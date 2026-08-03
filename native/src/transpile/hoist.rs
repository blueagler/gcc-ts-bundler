//! Per-chunk scope hoisting for bundler-runtime mode.
//!
//! Modules that live in the same chunk reference each other's top-level
//! bindings directly (renamed with a per-module ordinal suffix) so Closure can
//! inline and rename across the whole chunk. Only cross-chunk edges and
//! dynamic-import targets go through the `__register`/`__require` registry via
//! small export facades.

use super::*;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    ImportOrExportKind, ModuleExportName, Program as OxcProgram, Statement,
};
use oxc_semantic::SemanticBuilder;

#[derive(Clone, Debug)]
pub(super) struct ResolvedExportBinding {
    pub(super) owner_module_id: String,
    pub(super) owner_export_name: String,
    pub(super) owner_local_name: String,
    pub(super) owner_slot_mode: BundlerExportSlotMode,
}

/// Which export slots a hoisted module's registry factory must expose.
/// `All` keeps the full slot table alive; `Named` prunes registration to the
/// slots required by cross-chunk consumers.
#[derive(Clone, Debug)]
pub(super) enum FacadeSlots {
    All,
    Named(BTreeSet<String>),
}

#[derive(Clone, Debug, Default)]
pub(super) struct HoistPlan {
    /// For each chunk index, the chunk indices the loader guarantees have
    /// executed before it (transitive closure of the plan's dependency
    /// edges). Empty when the chunk graph carried no dependency edges.
    chunk_dependency_closure: Vec<HashSet<usize>>,
    pub(super) export_bindings: HashMap<String, BTreeMap<String, ResolvedExportBinding>>,
    pub(super) facade_slots: HashMap<String, FacadeSlots>,
    pub(super) hoisted_modules: HashSet<String>,
    pub(super) module_chunks: HashMap<String, usize>,
    module_positions: HashMap<String, usize>,
    pub(super) module_ordinals: HashMap<String, usize>,
}

impl HoistPlan {
    pub(super) fn is_hoisted(&self, module_id: &str) -> bool {
        self.hoisted_modules.contains(module_id)
    }

    pub(super) fn chunk_of(&self, module_id: &str) -> Option<usize> {
        self.module_chunks.get(module_id).copied()
    }

    pub(super) fn ordinal_of(&self, module_id: &str) -> Option<usize> {
        self.module_ordinals.get(module_id).copied()
    }

    pub(super) fn resolve_export(
        &self,
        module_id: &str,
        export_name: &str,
    ) -> Option<&ResolvedExportBinding> {
        self.export_bindings.get(module_id)?.get(export_name)
    }

    /// A resolved binding can be referenced directly only when the loader has
    /// already executed the chunk that owns it: the same chunk, or one this
    /// chunk transitively depends on (dependency chunks are fetched and run
    /// first). Sibling chunks are *not* ordered against each other, so a
    /// binding owned by one lazy chunk and read from another has to go back
    /// through the `__require` registry.
    ///
    /// The plan is built so this never happens; the `debug_assert` says so out
    /// loud in tests, and the release path still falls back to the registry
    /// rather than emitting a reference to a binding that may not exist yet.
    pub(super) fn is_direct_binding(
        &self,
        consumer_module_id: &str,
        binding: &ResolvedExportBinding,
    ) -> bool {
        if !self.is_hoisted(&binding.owner_module_id) {
            return false;
        }
        let Some(owner_chunk) = self.chunk_of(&binding.owner_module_id) else {
            return false;
        };
        let Some(consumer_chunk) = self.chunk_of(consumer_module_id) else {
            // The consumer is not in the chunk graph at all, so there is no
            // ordering to check and nothing new to forbid.
            return true;
        };
        if self.chunk_dependency_closure.is_empty() {
            return true;
        }
        let ordered = owner_chunk == consumer_chunk
            || self
                .chunk_dependency_closure
                .get(consumer_chunk)
                .is_some_and(|dependencies| dependencies.contains(&owner_chunk));
        debug_assert!(
            ordered,
            "direct binding {} (chunk {owner_chunk}) read from {consumer_module_id} (chunk {consumer_chunk}), which does not depend on it",
            binding.owner_module_id,
        );
        ordered
    }

    pub(super) fn direct_binding_name(&self, binding: &ResolvedExportBinding) -> Option<String> {
        let ordinal = self.ordinal_of(&binding.owner_module_id)?;
        Some(suffixed_name(&binding.owner_local_name, ordinal))
    }

    pub(super) fn direct_binding_slot_mode(
        &self,
        consumer_module_id: &str,
        binding: &ResolvedExportBinding,
    ) -> BundlerExportSlotMode {
        let owner_precedes_consumer = self
            .module_positions
            .get(&binding.owner_module_id)
            .zip(self.module_positions.get(consumer_module_id))
            .is_some_and(|(owner, consumer)| owner < consumer);
        if binding.owner_slot_mode == BundlerExportSlotMode::Static
            && self.chunk_of(consumer_module_id) == self.chunk_of(&binding.owner_module_id)
            && owner_precedes_consumer
        {
            BundlerExportSlotMode::Static
        } else {
            BundlerExportSlotMode::Live
        }
    }

    pub(super) fn facade_slots_for(&self, module_id: &str) -> Option<&FacadeSlots> {
        self.facade_slots.get(module_id)
    }
}

pub(super) fn suffixed_name(local_name: &str, ordinal: usize) -> String {
    format!("{local_name}$${ordinal}")
}

const DEFAULT_EXPORT_LOCAL: &str = "__gcc_dflt";

#[derive(Clone, Debug, Default)]
struct ModuleScan {
    /// export name -> local top-level binding name
    own_exports: BTreeMap<String, String>,
    /// export name -> (target module id, original export name on the target)
    reexports: BTreeMap<String, (String, String)>,
    /// `export * from` targets, in source order
    stars: Vec<String>,
    import_edges: Vec<ImportEdge>,
    /// `export ... from` targets (execution + facade edges)
    reexport_targets: Vec<String>,
    scan_failed: bool,
    local_export_modes: HashMap<String, BundlerExportSlotMode>,
}

#[derive(Clone, Debug, Default)]
struct ImportEdge {
    named: Vec<String>,
    namespace: bool,
    /// Present when every use of the namespace binding is a plain member
    /// access; lists the accessed member names.
    namespace_members: Option<BTreeSet<String>>,
    target_module_id: String,
    /// Imported names whose local binding is actually referenced in the
    /// module body (as opposed to merely re-exported).
    used_named: Vec<String>,
}

pub(super) fn build_hoist_plan(
    file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<Option<HoistPlan>, String> {
    if chunk_graph.is_empty() {
        return Ok(None);
    }

    let resolution_context = TranspileContext {
        bundler_module_slots: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        boundary_identity_tokens: HashMap::new(),
        external_specifiers: HashMap::new(),
        opaque_external_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: package_aliases.to_vec(),
        preserved_modules: HashMap::new(),
        resolved_module_ids: resolved_module_ids.clone(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: false,
        vendor_module_ids: HashSet::new(),
        workspace_dir: workspace_dir.to_path_buf(),
    };

    let mut module_chunks = HashMap::new();
    let mut module_positions = HashMap::new();
    for (chunk_index, chunk) in chunk_graph.iter().enumerate() {
        for (position, relative_file) in chunk.files.iter().enumerate() {
            let module_id = to_goog_module_id(&workspace_dir.join(relative_file), workspace_dir);
            module_chunks.insert(module_id.clone(), chunk_index);
            module_positions.insert(module_id, position);
        }
    }
    let chunk_dependency_closure = build_chunk_dependency_closure(chunk_graph);

    let mut scans = HashMap::<String, ModuleScan>::new();
    let mut hoistable = HashSet::new();
    let mut sorted_module_ids = BTreeSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module_id = to_goog_module_id(&file_path, workspace_dir);
        sorted_module_ids.insert(module_id.clone());
        let metadata = file_metadata.get(&closure_metadata_key(&file_path));
        let authored_source = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let source = metadata
            .and_then(|metadata| metadata.decorated_output_text.as_deref())
            .unwrap_or(&authored_source);
        let effective_path =
            if metadata.is_some_and(|metadata| metadata.decorated_output_text.is_some()) {
                file_path.with_extension("js")
            } else {
                file_path.clone()
            };
        let allocator = Allocator::default();
        let program = super::parse_oxc_program(&allocator, &effective_path, source)?;
        let commonjs_analysis = crate::commonjs::analyze_commonjs_program(&program);
        let normalize_commonjs = should_normalize_commonjs(&file_path, &commonjs_analysis);
        let mut scan = if normalize_commonjs {
            scan_commonjs_module(&file_path, &commonjs_analysis, &resolution_context)
        } else {
            let semantic = SemanticBuilder::new()
                .with_build_nodes(true)
                .with_enum_eval(true)
                .build(&program);
            if !semantic.diagnostics.is_empty() {
                return Err(semantic
                    .diagnostics
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"));
            }
            let identity =
                super::identity_oxc::ModuleIdentity::new(semantic.semantic.into_scoping());
            let mut scan = scan_esm_program(&program, &identity, &file_path, &resolution_context);
            scan.local_export_modes =
                super::emit_runtime_oxc::collect_local_export_modes(&program, &identity);
            scan
        };
        if let Some(metadata) = metadata {
            scan.own_exports.extend(
                metadata
                    .enums
                    .iter()
                    .filter(|enum_decl| enum_decl.exported)
                    .map(|enum_decl| {
                        (
                            enum_decl.binding_name.clone(),
                            enum_decl.binding_name.clone(),
                        )
                    }),
            );
        }
        if module_chunks.contains_key(&module_id) && !scan.scan_failed {
            hoistable.insert(module_id.clone());
        }
        scans.insert(module_id, scan);
    }

    let module_ordinals = sorted_module_ids
        .iter()
        .enumerate()
        .map(|(ordinal, module_id)| (module_id.clone(), ordinal))
        .collect::<HashMap<_, _>>();

    let export_bindings = resolve_all_export_bindings(&scans);

    let plan_without_facades = HoistPlan {
        chunk_dependency_closure,
        export_bindings,
        facade_slots: HashMap::new(),
        hoisted_modules: hoistable,
        module_chunks,
        module_positions,
        module_ordinals,
    };
    let facade_slots = compute_facade_slots(&plan_without_facades, &scans, lazy_imports);

    Ok(Some(HoistPlan {
        facade_slots,
        ..plan_without_facades
    }))
}

/// Transitive closure of the plan's chunk dependency edges, by chunk index.
///
/// The loader fetches and runs a chunk's dependencies before the chunk
/// itself, so "is in the closure" is exactly "has already executed". An empty
/// result (no chunk declared a dependency) disables the ordering check rather
/// than forbidding every cross-chunk binding, which is what callers that do
/// not build a dependency graph rely on.
fn build_chunk_dependency_closure(chunk_graph: &[TranspileChunkInput]) -> Vec<HashSet<usize>> {
    if chunk_graph
        .iter()
        .all(|chunk| chunk.dependencies.is_empty())
    {
        return Vec::new();
    }
    let index_by_name = chunk_graph
        .iter()
        .enumerate()
        .map(|(index, chunk)| (chunk.name.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut closure = vec![HashSet::new(); chunk_graph.len()];
    for (index, chunk) in chunk_graph.iter().enumerate() {
        let mut pending = chunk
            .dependencies
            .iter()
            .filter_map(|name| index_by_name.get(name.as_str()).copied())
            .collect::<Vec<_>>();
        while let Some(dependency) = pending.pop() {
            if dependency == index || !closure[index].insert(dependency) {
                continue;
            }
            pending.extend(
                chunk_graph[dependency]
                    .dependencies
                    .iter()
                    .filter_map(|name| index_by_name.get(name.as_str()).copied()),
            );
        }
    }
    closure
}

fn scan_commonjs_module(
    file_path: &Path,
    analysis: &crate::commonjs::CommonJsAnalysis,
    resolution_context: &TranspileContext,
) -> ModuleScan {
    let mut scan = ModuleScan::default();
    scan.own_exports
        .insert("__cjsExports".to_string(), "__cjsExports".to_string());
    scan.own_exports
        .insert("default".to_string(), "__cjsExports".to_string());
    // The normalized CommonJS interop imports use reflection, which requires a
    // real require object; keep CommonJS modules with dependencies in registry form.
    if !analysis.dependencies.is_empty() {
        scan.scan_failed = true;
        for specifier in &analysis.dependencies {
            if let Ok(target) = resolve_module_id_for_specifier(
                file_path,
                &to_emitted_commonjs_specifier(specifier),
                resolution_context,
            ) {
                scan.import_edges.push(ImportEdge {
                    named: Vec::new(),
                    namespace: true,
                    namespace_members: None,
                    target_module_id: target,
                    used_named: Vec::new(),
                });
            }
        }
    }
    scan
}

fn scan_esm_program(
    program: &OxcProgram<'_>,
    identity: &super::identity_oxc::ModuleIdentity,
    file_path: &Path,
    resolution_context: &TranspileContext,
) -> ModuleScan {
    let mut scan = ModuleScan::default();
    let mut import_locals = HashMap::<String, Option<(String, String)>>::new();
    let namespace_usage = super::hoist_oxc::scan_namespace_usage(program, identity);
    let used_binding_ids = super::hoist_oxc::collect_used_binding_ids(program, identity);

    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    import.source.value.as_str(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                let mut edge = ImportEdge {
                    target_module_id: target.clone(),
                    ..Default::default()
                };
                for specifier in import.specifiers.iter().flatten() {
                    match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Type => {}
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                            let imported = module_export_name(&specifier.imported);
                            let local = specifier.local.name.to_string();
                            import_locals.insert(local, Some((target.clone(), imported.clone())));
                            if used_binding_ids.contains(&identity.key_of_binding(&specifier.local))
                            {
                                edge.used_named.push(imported.clone());
                            }
                            edge.named.push(imported);
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            let local = specifier.local.name.to_string();
                            import_locals
                                .insert(local, Some((target.clone(), "default".to_string())));
                            if used_binding_ids.contains(&identity.key_of_binding(&specifier.local))
                            {
                                edge.used_named.push("default".to_string());
                            }
                            edge.named.push("default".to_string());
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                            import_locals.insert(specifier.local.name.to_string(), None);
                            edge.namespace = true;
                            edge.namespace_members = namespace_usage
                                .member_only_usage(identity.key_of_binding(&specifier.local));
                        }
                    }
                }
                scan.import_edges.push(edge);
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = &export.declaration {
                    for name in declaration_names(declaration) {
                        scan.own_exports.insert(name.clone(), name);
                    }
                }
                if let Some(source) = &export.source {
                    let Ok(target) = resolve_module_id_for_specifier(
                        file_path,
                        source.value.as_str(),
                        resolution_context,
                    ) else {
                        scan.scan_failed = true;
                        continue;
                    };
                    scan.reexport_targets.push(target.clone());
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        scan.reexports.insert(
                            module_export_name(&specifier.exported),
                            (target.clone(), module_export_name(&specifier.local)),
                        );
                    }
                } else {
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let local = module_export_name(&specifier.local);
                        let export_name = module_export_name(&specifier.exported);
                        match import_locals.get(&local) {
                            Some(Some((target, imported))) => {
                                scan.reexports
                                    .insert(export_name, (target.clone(), imported.clone()));
                            }
                            Some(None) => scan.scan_failed = true,
                            None => {
                                scan.own_exports.insert(export_name, local);
                            }
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let local = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        function.id.as_ref().map(|id| id.name.to_string())
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        class.id.as_ref().map(|id| id.name.to_string())
                    }
                    _ => None,
                };
                if let Some((target, imported)) =
                    export.declaration.as_expression().and_then(|expression| {
                        let oxc_ast::ast::Expression::Identifier(identifier) = expression else {
                            return None;
                        };
                        import_locals
                            .get(identifier.name.as_str())
                            .and_then(Option::as_ref)
                    })
                {
                    scan.reexports
                        .insert("default".to_string(), (target.clone(), imported.clone()));
                    continue;
                }
                scan.own_exports.insert(
                    "default".to_string(),
                    local.unwrap_or_else(|| DEFAULT_EXPORT_LOCAL.to_string()),
                );
            }
            Statement::TSExportAssignment(_) => {
                scan.own_exports
                    .insert("default".to_string(), DEFAULT_EXPORT_LOCAL.to_string());
            }
            Statement::ExportAllDeclaration(export) => {
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    export.source.value.as_str(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                scan.reexport_targets.push(target.clone());
                if export.exported.is_some() {
                    scan.scan_failed = true;
                } else {
                    scan.stars.push(target);
                }
            }
            _ => {}
        }
    }
    scan
}

fn declaration_names(declaration: &Declaration<'_>) -> Vec<String> {
    let mut names = Vec::new();
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for declarator in &declaration.declarations {
                collect_pattern_names(&declarator.id, &mut names);
            }
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(id) = &function.id {
                names.push(id.name.to_string());
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(id) = &class.id {
                names.push(id.name.to_string());
            }
        }
        Declaration::TSEnumDeclaration(declaration) => {
            names.push(declaration.id.name.to_string());
        }
        Declaration::TSModuleDeclaration(declaration) => {
            if let oxc_ast::ast::TSModuleDeclarationName::Identifier(id) = &declaration.id {
                names.push(id.name.to_string());
            }
        }
        _ => {}
    }
    names
}

fn collect_pattern_names(pattern: &BindingPattern<'_>, names: &mut Vec<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
        BindingPattern::ArrayPattern(array) => {
            for pattern in array.elements.iter().flatten() {
                collect_pattern_names(pattern, names);
            }
            if let Some(rest) = &array.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                collect_pattern_names(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                collect_pattern_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            collect_pattern_names(&assignment.left, names);
        }
    }
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn resolve_all_export_bindings(
    scans: &HashMap<String, ModuleScan>,
) -> HashMap<String, BTreeMap<String, ResolvedExportBinding>> {
    let mut memo = HashMap::<(String, String), Option<ResolvedExportBinding>>::new();
    let mut result = HashMap::new();
    for module_id in scans.keys() {
        let mut export_names = BTreeSet::new();
        collect_export_names(module_id, scans, &mut export_names, &mut BTreeSet::new());
        let mut bindings = BTreeMap::new();
        for export_name in export_names {
            let mut visiting = BTreeSet::new();
            if let Some(binding) =
                resolve_export_binding(module_id, &export_name, scans, &mut memo, &mut visiting)
            {
                bindings.insert(export_name, binding);
            }
        }
        result.insert(module_id.clone(), bindings);
    }
    result
}

fn collect_export_names(
    module_id: &str,
    scans: &HashMap<String, ModuleScan>,
    names: &mut BTreeSet<String>,
    visiting: &mut BTreeSet<String>,
) {
    if !visiting.insert(module_id.to_string()) {
        return;
    }
    let Some(scan) = scans.get(module_id) else {
        return;
    };
    names.extend(scan.own_exports.keys().cloned());
    names.extend(scan.reexports.keys().cloned());
    for star_target in &scan.stars {
        let mut star_names = BTreeSet::new();
        collect_export_names(star_target, scans, &mut star_names, visiting);
        names.extend(star_names.into_iter().filter(|name| name != "default"));
    }
}

fn resolve_export_binding(
    module_id: &str,
    export_name: &str,
    scans: &HashMap<String, ModuleScan>,
    memo: &mut HashMap<(String, String), Option<ResolvedExportBinding>>,
    visiting: &mut BTreeSet<String>,
) -> Option<ResolvedExportBinding> {
    let key = (module_id.to_string(), export_name.to_string());
    if let Some(memoized) = memo.get(&key) {
        return memoized.clone();
    }
    if !visiting.insert(module_id.to_string()) {
        return None;
    }
    let resolved =
        (|| {
            let scan = scans.get(module_id)?;
            if let Some(local) = scan.own_exports.get(export_name) {
                return Some(ResolvedExportBinding {
                    owner_module_id: module_id.to_string(),
                    owner_export_name: export_name.to_string(),
                    owner_local_name: local.clone(),
                    owner_slot_mode: scan.local_export_modes.get(local).copied().unwrap_or_else(
                        || {
                            if local == DEFAULT_EXPORT_LOCAL {
                                BundlerExportSlotMode::Static
                            } else {
                                BundlerExportSlotMode::Live
                            }
                        },
                    ),
                });
            }
            if let Some((target, orig)) = scan.reexports.get(export_name) {
                return resolve_export_binding(target, orig, scans, memo, visiting);
            }
            if export_name != "default" {
                for star_target in &scan.stars {
                    if let Some(binding) =
                        resolve_export_binding(star_target, export_name, scans, memo, visiting)
                    {
                        return Some(binding);
                    }
                }
            }
            None
        })();
    visiting.remove(module_id);
    memo.insert(key, resolved.clone());
    resolved
}

struct FacadeNeeds<'a> {
    plan: &'a HoistPlan,
    slots: HashMap<String, FacadeSlots>,
    worklist: Vec<(String, Option<String>)>,
}

impl FacadeNeeds<'_> {
    fn need(&mut self, module_id: &str, export_name: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        match self
            .slots
            .entry(module_id.to_string())
            .or_insert_with(|| FacadeSlots::Named(BTreeSet::new()))
        {
            FacadeSlots::All => {}
            FacadeSlots::Named(names) => {
                if names.insert(export_name.to_string()) {
                    self.worklist
                        .push((module_id.to_string(), Some(export_name.to_string())));
                }
            }
        }
    }

    fn need_all(&mut self, module_id: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        let previous = self.slots.insert(module_id.to_string(), FacadeSlots::All);
        if !matches!(previous, Some(FacadeSlots::All)) {
            self.worklist.push((module_id.to_string(), None));
        }
    }

    fn ensure_registered(&mut self, module_id: &str) {
        if !self.plan.is_hoisted(module_id) {
            return;
        }
        self.slots
            .entry(module_id.to_string())
            .or_insert_with(|| FacadeSlots::Named(BTreeSet::new()));
    }
}

fn compute_facade_slots(
    plan: &HoistPlan,
    scans: &HashMap<String, ModuleScan>,
    lazy_imports: &[LazyImportInput],
) -> HashMap<String, FacadeSlots> {
    let mut needs = FacadeNeeds {
        plan,
        slots: HashMap::new(),
        worklist: Vec::new(),
    };

    // Dynamic imports expose namespace values across user and framework
    // boundaries, so keep the complete slot table and the named facade.
    for lazy_import in lazy_imports {
        needs.need_all(&lazy_import.moduleId);
    }

    for (module_id, scan) in scans {
        if plan.chunk_of(module_id).is_none() {
            continue;
        }
        let consumer_hoisted = plan.is_hoisted(module_id);
        for edge in &scan.import_edges {
            if edge.namespace {
                match (&edge.namespace_members, consumer_hoisted) {
                    (Some(members), true) => {
                        let direct_namespace = plan.is_hoisted(&edge.target_module_id)
                            && plan.chunk_of(&edge.target_module_id).is_some();
                        if direct_namespace {
                            // Members rewrite to direct bindings, except when
                            // they resolve to a non-hoisted owner, where the
                            // emitter falls back to `__require(owner)[slot]`.
                            for member in members {
                                match plan.resolve_export(&edge.target_module_id, member) {
                                    Some(binding) if plan.is_direct_binding(module_id, binding) => {
                                    }
                                    Some(binding) => {
                                        let (owner, owner_export_name) = (
                                            binding.owner_module_id.clone(),
                                            binding.owner_export_name.clone(),
                                        );
                                        needs.need(&owner, &owner_export_name);
                                    }
                                    None => needs.need(&edge.target_module_id, member),
                                }
                            }
                        } else {
                            for member in members {
                                needs.need(&edge.target_module_id, member);
                            }
                        }
                    }
                    _ => {
                        if std::env::var("GCC_HOIST_DEBUG").is_ok() {
                            eprintln!(
                                "[hoist] need_all target={} consumer={} consumer_hoisted={} members={:?}",
                                edge.target_module_id, module_id, consumer_hoisted, edge.namespace_members
                            );
                        }
                        needs.need_all(&edge.target_module_id);
                    }
                }
            }
            if !consumer_hoisted {
                // Registry emission requires the immediate target for every
                // import form, including bare side-effect imports.
                needs.ensure_registered(&edge.target_module_id);
                for imported_name in &edge.named {
                    needs.need(&edge.target_module_id, imported_name);
                }
                continue;
            }
            for imported_name in &edge.used_named {
                match plan.resolve_export(&edge.target_module_id, imported_name) {
                    Some(binding) if plan.is_direct_binding(module_id, binding) => {}
                    Some(binding) => {
                        let (owner, owner_export_name) = (
                            binding.owner_module_id.clone(),
                            binding.owner_export_name.clone(),
                        );
                        needs.need(&owner, &owner_export_name);
                    }
                    None => needs.need(&edge.target_module_id, imported_name),
                }
            }
        }
        if !consumer_hoisted {
            for (target, orig) in scan.reexports.values() {
                needs.need(target, orig);
            }
            for star_target in &scan.stars {
                needs.need_all(star_target);
            }
        }
    }

    // Facade getters of re-exported names reach into their owners at runtime.
    while let Some((module_id, export_name)) = needs.worklist.pop() {
        let Some(bindings) = plan.export_bindings.get(&module_id) else {
            continue;
        };
        let names: Vec<(String, ResolvedExportBinding)> = match export_name {
            Some(name) => bindings
                .get(&name)
                .map(|binding| vec![(name, binding.clone())])
                .unwrap_or_default(),
            None => bindings
                .iter()
                .map(|(name, binding)| (name.clone(), binding.clone()))
                .collect(),
        };
        for (_, binding) in names {
            if binding.owner_module_id == module_id {
                continue;
            }
            if plan.is_direct_binding(&module_id, &binding) {
                continue;
            }
            needs.need(&binding.owner_module_id, &binding.owner_export_name);
        }
    }

    if std::env::var("GCC_HOIST_DEBUG").is_ok() {
        for (module_id, slots) in &needs.slots {
            match slots {
                FacadeSlots::All => eprintln!("[hoist] facade {} = ALL", module_id),
                FacadeSlots::Named(names) => {
                    eprintln!("[hoist] facade {} = {} names", module_id, names.len())
                }
            }
        }
    }
    needs.slots
}
