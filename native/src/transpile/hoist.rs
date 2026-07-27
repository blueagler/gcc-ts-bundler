//! Per-chunk scope hoisting for bundler-runtime mode.
//!
//! Modules that live in the same chunk reference each other's top-level
//! bindings directly (renamed with a per-module ordinal suffix) so Closure can
//! inline and rename across the whole chunk. Only cross-chunk edges and
//! dynamic-import targets go through the `__register`/`__require` registry via
//! small export facades.

use super::*;

#[derive(Clone, Debug)]
pub(super) struct ResolvedExportBinding {
    pub(super) owner_module_id: String,
    pub(super) owner_export_name: String,
    pub(super) owner_local_name: String,
}

/// Which export slots a hoisted module's facade must expose. `All` keeps the
/// full slot table alive (namespace/dynamic-import consumers); `Named` prunes
/// the facade to the slots that are actually required somewhere, letting
/// Closure tree-shake every unused export.
#[derive(Clone, Debug)]
pub(super) enum FacadeSlots {
    All,
    Named(BTreeSet<String>),
}

#[derive(Clone, Debug, Default)]
pub(super) struct HoistPlan {
    pub(super) export_bindings: HashMap<String, BTreeMap<String, ResolvedExportBinding>>,
    pub(super) facade_slots: HashMap<String, FacadeSlots>,
    pub(super) hoisted_modules: HashSet<String>,
    pub(super) module_chunks: HashMap<String, usize>,
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

    /// A resolved binding can be referenced directly whenever its owner is
    /// hoisted into some chunk — including a *different* chunk. Static imports
    /// only cross chunk edges that the loader guarantees are already executed
    /// (dep chunks load first), and Closure moves cross-chunk survivors onto
    /// `$gcc`, so a plain identifier is a correct live reference.
    ///
    /// ponytail: `consumer_module_id` is kept in the signature because every
    /// call site has it and a future chunk-order check would need it.
    pub(super) fn is_direct_binding(
        &self,
        _consumer_module_id: &str,
        binding: &ResolvedExportBinding,
    ) -> bool {
        self.is_hoisted(&binding.owner_module_id)
            && self.chunk_of(&binding.owner_module_id).is_some()
    }

    pub(super) fn direct_binding_name(&self, binding: &ResolvedExportBinding) -> Option<String> {
        let ordinal = self.ordinal_of(&binding.owner_module_id)?;
        Some(suffixed_name(&binding.owner_local_name, ordinal))
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
        file_metadata: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: package_aliases.to_vec(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        typed_annotations: HashMap::new(),
        vendor_module_ids: HashSet::new(),
        workspace_dir: workspace_dir.to_path_buf(),
    };

    let mut module_chunks = HashMap::new();
    for (chunk_index, chunk) in chunk_graph.iter().enumerate() {
        for relative_file in &chunk.files {
            let module_id = to_goog_module_id(&workspace_dir.join(relative_file), workspace_dir);
            module_chunks.insert(module_id, chunk_index);
        }
    }

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
        let metadata = file_metadata.get(file_name);
        let module = if let Some(decorated_text) = metadata
            .as_ref()
            .and_then(|metadata| metadata.decorated_output_text.clone())
        {
            parse_module(&file_path.with_extension("js"), &decorated_text)?
        } else {
            get_or_parse_cached_module(&file_path)?
        };
        let commonjs_analysis = analyze_commonjs_module(&module);
        let scan = if should_normalize_commonjs(&file_path, &commonjs_analysis) {
            scan_commonjs_module(&file_path, &commonjs_analysis, &resolution_context)
        } else {
            scan_esm_module(&module, &file_path, &resolution_context)
        };
        // Enum and typedef snippets are emitted by the registry paths only,
        // so a file carrying them cannot be flattened without losing them.
        // Note this is orthogonal to `TranspileContext::typed_annotations`:
        // those arrive on their own channel, are re-attached by
        // `emit_hoist`, and never set this flag — a plain typed `.ts` module
        // hoists *and* keeps its JSDoc. The residual gap is a file that has
        // both, which falls back to registry emission and drops its typed
        // annotations; closing it needs AST-level typedef/enum emission in
        // the hoisted form (docs/research/typed-input.md §5 item 2).
        let has_typed_metadata = metadata
            .map(|metadata| {
                !metadata.enum_declarations.is_empty() || !metadata.type_declarations.is_empty()
            })
            .unwrap_or(false);
        let can_hoist =
            module_chunks.contains_key(&module_id) && !scan.scan_failed && !has_typed_metadata;
        if can_hoist {
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
        export_bindings,
        facade_slots: HashMap::new(),
        hoisted_modules: hoistable,
        module_chunks,
        module_ordinals,
    };
    let facade_slots = compute_facade_slots(&plan_without_facades, &scans, lazy_imports);

    Ok(Some(HoistPlan {
        facade_slots,
        ..plan_without_facades
    }))
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
    // The normalized CommonJS interop imports use `"__cjsExports" in ns`
    // reflection, which requires a real require object; keep CommonJS modules
    // with dependencies in registry form.
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

fn scan_esm_module(
    module: &Module,
    file_path: &Path,
    resolution_context: &TranspileContext,
) -> ModuleScan {
    let mut scan = ModuleScan::default();
    // local import binding name -> (target module id, imported export name).
    // Namespace imports map to None so exporting one falls back to registry.
    let mut import_locals = HashMap::<String, Option<(String, String)>>::new();
    let namespace_usage = scan_namespace_usage(module);
    let used_binding_ids = collect_used_binding_ids(module);

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                if import_decl.type_only {
                    continue;
                }
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    &import_decl.src.value.to_string_lossy(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                let mut edge = ImportEdge {
                    target_module_id: target.clone(),
                    ..Default::default()
                };
                for specifier in &import_decl.specifiers {
                    match specifier {
                        ImportSpecifier::Named(named) if named.is_type_only => {}
                        ImportSpecifier::Named(named) => {
                            let imported = named
                                .imported
                                .as_ref()
                                .map(module_export_name_to_string)
                                .unwrap_or_else(|| named.local.sym.to_string());
                            import_locals.insert(
                                named.local.sym.to_string(),
                                Some((target.clone(), imported.clone())),
                            );
                            if used_binding_ids.contains(&named.local.to_id()) {
                                edge.used_named.push(imported.clone());
                            }
                            edge.named.push(imported);
                        }
                        ImportSpecifier::Default(default_specifier) => {
                            import_locals.insert(
                                default_specifier.local.sym.to_string(),
                                Some((target.clone(), "default".to_string())),
                            );
                            if used_binding_ids.contains(&default_specifier.local.to_id()) {
                                edge.used_named.push("default".to_string());
                            }
                            edge.named.push("default".to_string());
                        }
                        ImportSpecifier::Namespace(namespace_specifier) => {
                            import_locals.insert(namespace_specifier.local.sym.to_string(), None);
                            edge.namespace = true;
                            edge.namespace_members = namespace_usage
                                .member_only_usage(&namespace_specifier.local.to_id());
                        }
                    }
                }
                scan.import_edges.push(edge);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                for name in exported_decl_names(&export_decl.decl) {
                    scan.own_exports.insert(name.clone(), name);
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                if named_export.type_only {
                    continue;
                }
                if let Some(src) = &named_export.src {
                    let Ok(target) = resolve_module_id_for_specifier(
                        file_path,
                        &src.value.to_string_lossy(),
                        resolution_context,
                    ) else {
                        scan.scan_failed = true;
                        continue;
                    };
                    scan.reexport_targets.push(target.clone());
                    for specifier in &named_export.specifiers {
                        let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                            scan.scan_failed = true;
                            continue;
                        };
                        let orig = module_export_name_to_string(&named.orig);
                        let export_name = named
                            .exported
                            .as_ref()
                            .map(module_export_name_to_string)
                            .unwrap_or_else(|| orig.clone());
                        scan.reexports.insert(export_name, (target.clone(), orig));
                    }
                } else {
                    for specifier in &named_export.specifiers {
                        let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                            scan.scan_failed = true;
                            continue;
                        };
                        let local = module_export_name_to_string(&named.orig);
                        let export_name = named
                            .exported
                            .as_ref()
                            .map(module_export_name_to_string)
                            .unwrap_or_else(|| local.clone());
                        match import_locals.get(&local) {
                            Some(Some((target, imported))) => {
                                scan.reexports
                                    .insert(export_name, (target.clone(), imported.clone()));
                            }
                            Some(None) => {
                                // Exporting a namespace binding: registry only.
                                scan.scan_failed = true;
                            }
                            None => {
                                scan.own_exports.insert(export_name, local);
                            }
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => {
                let local = match &default_decl.decl {
                    swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string()),
                    swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                        class_expr.ident.as_ref().map(|ident| ident.sym.to_string())
                    }
                    _ => None,
                };
                scan.own_exports.insert(
                    "default".to_string(),
                    local.unwrap_or_else(|| DEFAULT_EXPORT_LOCAL.to_string()),
                );
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                if let Expr::Ident(ident) = &*default_expr.expr {
                    if let Some(Some((target, imported))) =
                        import_locals.get(&ident.sym.to_string())
                    {
                        scan.reexports
                            .insert("default".to_string(), (target.clone(), imported.clone()));
                        continue;
                    }
                }
                scan.own_exports
                    .insert("default".to_string(), DEFAULT_EXPORT_LOCAL.to_string());
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let Ok(target) = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    resolution_context,
                ) else {
                    scan.scan_failed = true;
                    continue;
                };
                scan.reexport_targets.push(target.clone());
                scan.stars.push(target);
            }
            _ => {}
        }
    }

    scan
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
    let resolved = (|| {
        let scan = scans.get(module_id)?;
        if let Some(local) = scan.own_exports.get(export_name) {
            return Some(ResolvedExportBinding {
                owner_module_id: module_id.to_string(),
                owner_export_name: export_name.to_string(),
                owner_local_name: local.clone(),
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

/// Ids referenced anywhere except import declarations and source-less named
/// exports (pure re-exports are not uses).
pub(super) fn collect_used_binding_ids(module: &Module) -> HashSet<Id> {
    let mut collector = UsedBindingCollector {
        used: HashSet::new(),
    };
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(_)) => {}
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export))
                if named_export.src.is_none() => {}
            _ => item.visit_with(&mut collector),
        }
    }
    collector.used
}

struct UsedBindingCollector {
    used: HashSet<Id>,
}

impl Visit for UsedBindingCollector {
    fn visit_ident(&mut self, ident: &Ident) {
        self.used.insert(ident.to_id());
    }
}

struct NamespaceUsage {
    disqualified: HashSet<Id>,
    members: HashMap<Id, BTreeSet<String>>,
}

impl NamespaceUsage {
    fn member_only_usage(&self, binding_id: &Id) -> Option<BTreeSet<String>> {
        if self.disqualified.contains(binding_id) {
            return None;
        }
        Some(self.members.get(binding_id).cloned().unwrap_or_default())
    }
}

/// Records, for every namespace import binding, which members are accessed and
/// whether the binding ever escapes as a value.
fn scan_namespace_usage(module: &Module) -> NamespaceUsage {
    let mut candidates = HashSet::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item
        else {
            continue;
        };
        for specifier in &import_decl.specifiers {
            if let ImportSpecifier::Namespace(namespace_specifier) = specifier {
                candidates.insert(namespace_specifier.local.to_id());
            }
        }
    }
    let mut scanner = NamespaceMemberScanner {
        candidates,
        usage: NamespaceUsage {
            disqualified: HashSet::new(),
            members: HashMap::new(),
        },
    };
    // Import specifiers and re-export specifiers are not expression contexts,
    // so visiting every item (including default exports) is safe.
    module.visit_with(&mut scanner);
    scanner.usage
}

struct NamespaceMemberScanner {
    candidates: HashSet<Id>,
    usage: NamespaceUsage,
}

impl Visit for NamespaceMemberScanner {
    fn visit_expr(&mut self, expr: &Expr) {
        if let Expr::Member(member) = expr {
            if let Expr::Ident(object_ident) = &*member.obj {
                let binding_id = object_ident.to_id();
                if self.candidates.contains(&binding_id) {
                    // Identifier and quoted-string members both count as
                    // plain member access (preserved-property quoting turns
                    // `ns.state` into `ns["state"]` before emission).
                    match &member.prop {
                        MemberProp::Ident(prop_ident) => {
                            self.usage
                                .members
                                .entry(binding_id)
                                .or_default()
                                .insert(prop_ident.sym.to_string());
                            return;
                        }
                        MemberProp::Computed(computed) => {
                            if let Expr::Lit(Lit::Str(value)) = &*computed.expr {
                                self.usage
                                    .members
                                    .entry(binding_id)
                                    .or_default()
                                    .insert(value.value.to_string_lossy().to_string());
                                return;
                            }
                            self.usage.disqualified.insert(binding_id);
                            computed.visit_children_with(self);
                            return;
                        }
                        MemberProp::PrivateName(_) => {}
                    }
                }
            }
        }
        if let Expr::Ident(ident) = expr {
            if self.candidates.contains(&ident.to_id()) {
                self.usage.disqualified.insert(ident.to_id());
            }
        }
        expr.visit_children_with(self);
    }
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

    // Dynamic-import namespaces are consumed member-by-member via the target
    // slot table, so lazy targets keep their full facade.
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
                        needs.need_all(&edge.target_module_id)
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
