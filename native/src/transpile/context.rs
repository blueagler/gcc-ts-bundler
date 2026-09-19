use super::{
    resolve_module_id_for_specifier, should_normalize_commonjs, to_goog_module_id, BTreeMap,
    BTreeSet, ClassMapCallInput, ClosureFileMetadata, HashMap, HashSet, HoistPlan, LazyImportInput,
    OpaqueCommonJs, PackageAliasInput, Path, PathBuf, PreservedModuleInput,
};
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Program as OxcProgram,
    Statement,
};

pub(crate) fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "off" => Ok(ChunkMode::Off),
        "bundler-runtime" | "split" => Ok(ChunkMode::BundlerRuntime),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TranspileContext {
    pub(crate) bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    pub(crate) goog_live_modules: HashMap<String, super::emit_goog::live_bindings::LiveModuleFacts>,
    pub(crate) bundler_runtime_logical_ids: HashMap<String, String>,
    pub(crate) chunk_mode: ChunkMode,
    pub(crate) class_map_calls: Vec<ClassMapCallInput>,
    pub(crate) pure_callees: HashSet<String>,
    pub(crate) commonjs_specifiers: HashSet<String>,
    pub(crate) opaque_commonjs: std::sync::Arc<OpaqueCommonJs>,
    pub(crate) boundary_identity_tokens: HashMap<String, String>,
    pub(crate) external_specifiers: HashMap<String, String>,
    pub(crate) opaque_external_specifiers: HashSet<String>,
    pub(crate) file_metadata: HashMap<String, ClosureFileMetadata>,
    pub(crate) authored_enum_values: HashMap<PathBuf, super::lowering::EnumValues>,
    pub(crate) hoist_plan: Option<std::sync::Arc<HoistPlan>>,
    pub(crate) lazy_imports_by_file: HashMap<String, Vec<LazyImportInput>>,
    pub(crate) lazy_target_module_ids: HashSet<String>,
    pub(crate) package_aliases: Vec<PackageAliasInput>,
    pub(crate) preserved_modules: HashMap<String, PreservedModuleInput>,
    pub(crate) resolved_module_ids: HashMap<String, String>,
    pub(crate) preserved_property_names: HashSet<String>,
    pub(crate) static_property_names: HashSet<String>,
    pub(crate) type_metadata_enabled: bool,
    /// Multi-chunk hoisted exports need both `@noinline` and runtime assigner pins:
    /// code motion must not turn a module-state write into an ESM import assignment.
    pub(crate) pin_cross_chunk_assigners: bool,
    pub(crate) workspace_dir: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BundlerModuleSlots {
    export_slots: BTreeMap<String, usize>,
}

impl BundlerModuleSlots {
    pub(crate) fn from_export_names(export_names: &BTreeSet<String>) -> Self {
        let mut export_slots = BTreeMap::new();
        let mut next_slot = 0usize;
        if export_names.contains("default") {
            export_slots.insert("default".to_string(), 0);
            next_slot = 1;
        }
        for export_name in export_names {
            if export_name == "default" {
                continue;
            }
            export_slots.insert(export_name.clone(), next_slot);
            next_slot += 1;
        }
        Self { export_slots }
    }

    pub(super) fn export_names(&self) -> impl Iterator<Item = &String> {
        self.export_slots.keys()
    }

    pub(super) fn slot_for(&self, export_name: &str) -> Option<usize> {
        self.export_slots.get(export_name).copied()
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RawBundlerExportInfo {
    pub(crate) explicit_exports: BTreeSet<String>,
    pub(crate) export_all_modules: Vec<String>,
    /// Exported name, target module, and imported name for explicit forwarding.
    forward_exports: Vec<(String, String, String)>,
    erased_exports: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChunkMode {
    Off,
    BundlerRuntime,
}

/// Resolution-only context for hoist-plan tests.
#[cfg(test)]
pub(crate) fn analysis_resolution_context(
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
) -> TranspileContext {
    TranspileContext {
        bundler_module_slots: HashMap::new(),
        goog_live_modules: HashMap::new(),
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
        authored_enum_values: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: package_aliases.to_vec(),
        preserved_modules: HashMap::new(),
        resolved_module_ids: resolved_module_ids.clone(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: false,
        pin_cross_chunk_assigners: false,
        workspace_dir: workspace_dir.to_path_buf(),
    }
}

/// Bundler-runtime export names for one already-parsed file.
pub(crate) fn collect_file_bundler_exports(
    program: &OxcProgram<'_>,
    file_path: &Path,
    workspace_dir: &Path,
    metadata: Option<&ClosureFileMetadata>,
    resolution_context: &TranspileContext,
    commonjs_analysis: &crate::commonjs::CommonJsAnalysis,
    topology: Option<&ExportTopology>,
) -> std::result::Result<(String, RawBundlerExportInfo), String> {
    let module_id = to_goog_module_id(file_path, workspace_dir);
    let mut raw_exports = if should_normalize_commonjs(file_path, commonjs_analysis) {
        RawBundlerExportInfo {
            explicit_exports: BTreeSet::from(["__cjsExports".to_string(), "default".to_string()]),
            ..RawBundlerExportInfo::default()
        }
    } else if let Some(topology) = topology {
        raw_bundler_exports_from_topology(topology)
    } else {
        collect_raw_bundler_exports(program, file_path, resolution_context)?
    };
    // The enum metadata is the same option-owned object list used by emission,
    // including when type inference is disabled. Authored syntax alone cannot
    // decide whether a const enum belongs to the runtime namespace.
    let mut erased_locals = HashSet::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::TSEnumDeclaration(declaration) => Some(&**declaration),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::TSEnumDeclaration(declaration) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        if let Some(declaration) = declaration {
            if declaration.r#const
                && !metadata.is_some_and(|metadata| {
                    metadata
                        .enums
                        .iter()
                        .any(|enum_decl| enum_decl.binding_name == declaration.id.name.as_str())
                })
            {
                erased_locals.insert(declaration.id.name.as_str());
            }
        }
    }
    if !erased_locals.is_empty() {
        for statement in &program.body {
            match statement {
                Statement::ExportDeclaration(export) => {
                    if let Declaration::TSEnumDeclaration(declaration) = &export.declaration {
                        if erased_locals.contains(declaration.id.name.as_str()) {
                            raw_exports
                                .erased_exports
                                .insert(declaration.id.name.to_string());
                        }
                    }
                }
                Statement::ExportNamedDeclaration(export) => {
                    for specifier in &export.specifiers {
                        if erased_locals.contains(module_export_name(&specifier.local).as_str()) {
                            raw_exports
                                .erased_exports
                                .insert(module_export_name(&specifier.exported));
                        }
                    }
                }
                Statement::ExportDefaultDeclaration(export) => {
                    if let Some(Expression::Identifier(identifier)) =
                        export.declaration.as_expression()
                    {
                        if erased_locals.contains(identifier.name.as_str()) {
                            raw_exports.erased_exports.insert("default".to_string());
                        }
                    }
                }
                Statement::TSExportAssignment(export) => {
                    if let Expression::Identifier(identifier) = &export.expression {
                        if erased_locals.contains(identifier.name.as_str()) {
                            raw_exports.erased_exports.insert("default".to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(metadata) = metadata {
        raw_exports.explicit_exports.extend(
            metadata
                .enums
                .iter()
                .filter(|enum_decl| enum_decl.exported)
                .map(|enum_decl| enum_decl.binding_name.clone()),
        );
    }
    Ok((module_id, raw_exports))
}

/// Resolves `export *` edges across per-file bundler export facts.
///
/// Module ids are walked in sorted order so a missing-target error is
/// byte-stable regardless of which rayon worker produced which file.
pub(crate) fn resolve_bundler_module_slots(
    raw_exports_by_module: HashMap<String, RawBundlerExportInfo>,
) -> std::result::Result<HashMap<String, BundlerModuleSlots>, String> {
    let mut erased_exports = raw_exports_by_module
        .iter()
        .map(|(module_id, raw)| (module_id.clone(), raw.erased_exports.clone()))
        .collect::<HashMap<_, _>>();
    let mut module_ids = raw_exports_by_module.keys().cloned().collect::<Vec<_>>();
    module_ids.sort();
    loop {
        let mut changed = false;
        for module_id in &module_ids {
            let raw = &raw_exports_by_module[module_id];
            let mut forwarded_erased = BTreeSet::new();
            for target in &raw.export_all_modules {
                if let Some(names) = erased_exports.get(target) {
                    forwarded_erased.extend(
                        names
                            .iter()
                            .filter(|name| {
                                *name != "default" && !raw.explicit_exports.contains(*name)
                            })
                            .cloned(),
                    );
                }
            }
            for (exported, target, imported) in &raw.forward_exports {
                if erased_exports
                    .get(target)
                    .is_some_and(|names| names.contains(imported))
                {
                    forwarded_erased.insert(exported.clone());
                }
            }
            let names = erased_exports.entry(module_id.clone()).or_default();
            for name in forwarded_erased {
                changed |= names.insert(name);
            }
        }
        if !changed {
            break;
        }
    }
    let mut resolved_export_names = raw_exports_by_module
        .iter()
        .map(|(module_id, raw)| {
            (
                module_id.clone(),
                raw.explicit_exports
                    .difference(&erased_exports[module_id])
                    .cloned()
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();
    loop {
        let mut changed = false;
        for module_id in &module_ids {
            let raw_exports = &raw_exports_by_module[module_id];
            for target_module_id in &raw_exports.export_all_modules {
                let Some(target_names) = resolved_export_names.get(target_module_id).cloned()
                else {
                    return Err(format!(
                        "Unable to resolve bundler-runtime slot exports for module {target_module_id}"
                    ));
                };
                let resolved_names = resolved_export_names.entry(module_id.clone()).or_default();
                for export_name in target_names {
                    if export_name != "default"
                        && !raw_exports.explicit_exports.contains(&export_name)
                        && !erased_exports[module_id].contains(&export_name)
                    {
                        changed |= resolved_names.insert(export_name);
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }

    Ok(resolved_export_names
        .into_iter()
        .map(|(module_id, export_names)| {
            (
                module_id,
                BundlerModuleSlots::from_export_names(&export_names),
            )
        })
        .collect())
}

pub(crate) fn collect_raw_bundler_exports(
    program: &OxcProgram<'_>,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<RawBundlerExportInfo, String> {
    Ok(raw_bundler_exports_from_topology(&collect_export_topology(
        program, file_path, context,
    )?))
}

fn raw_bundler_exports_from_topology(topology: &ExportTopology) -> RawBundlerExportInfo {
    let mut forward_exports = topology
        .forwards
        .iter()
        .map(|(exported, (target, imported))| (exported.clone(), target.clone(), imported.clone()))
        .collect::<Vec<_>>();
    // Snapshot expressions are not live bindings, but an erased const-enum
    // import still erases the default export initialized from that import.
    if let Some((target, imported)) = &topology.default_snapshot_source {
        forward_exports.push(("default".to_string(), target.clone(), imported.clone()));
    }
    RawBundlerExportInfo {
        explicit_exports: topology.explicit.clone(),
        export_all_modules: topology.stars.clone(),
        forward_exports,
        erased_exports: BTreeSet::new(),
    }
}

pub(crate) const DEFAULT_EXPORT_LOCAL: &str = "__gcc_dflt";

/// Syntax-level export identities shared by the slot and live-binding analyses.
/// Callers choose the source stage; mutation and use facts remain symbol-backed.
#[derive(Default)]
pub(crate) struct ExportTopology {
    pub(crate) explicit: BTreeSet<String>,
    pub(crate) locals: BTreeMap<String, String>,
    pub(crate) forwards: BTreeMap<String, (String, String)>,
    pub(crate) namespaces: BTreeMap<String, String>,
    pub(crate) stars: Vec<String>,
    /// Const-enum erasure lineage only, never a live forwarding edge.
    default_snapshot_source: Option<(String, String)>,
}

pub(crate) fn collect_export_topology(
    program: &OxcProgram<'_>,
    file_path: &Path,
    context: &TranspileContext,
) -> Result<ExportTopology, String> {
    let mut topology = ExportTopology::default();
    let mut imports = HashMap::new();
    let target = |source: &str| {
        if context
            .external_specifiers
            .contains_key(&super::resolved_import_key(file_path, source))
        {
            Ok(None)
        } else {
            resolve_module_id_for_specifier(file_path, source, context).map(Some)
        }
    };
    // Collect imports first: export lists may precede their import declarations.
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            let (local, imported) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if named.import_kind != ImportOrExportKind::Type =>
                {
                    (
                        named.local.name.as_str(),
                        Some(module_export_name(&named.imported)),
                    )
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    (default.local.name.as_str(), Some("default".to_string()))
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    (namespace.local.name.as_str(), None)
                }
                ImportDeclarationSpecifier::ImportSpecifier(_) => continue,
            };
            imports.insert(local, (import.source.value.as_str(), imported));
        }
    }
    for statement in &program.body {
        match statement {
            Statement::ExportDeclaration(export)
                if export.export_kind() != ImportOrExportKind::Type =>
            {
                let mut names = BTreeSet::new();
                collect_declaration_names(&export.declaration, &mut names);
                for name in names {
                    topology.explicit.insert(name.clone());
                    topology.locals.insert(name.clone(), name);
                }
            }
            Statement::ExportFromDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                if export
                    .specifiers
                    .iter()
                    .all(|specifier| specifier.export_kind == ImportOrExportKind::Type)
                {
                    continue;
                }
                let module_id = target(export.source.value.as_str())?;
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    let exported = module_export_name(&specifier.exported);
                    topology.explicit.insert(exported.clone());
                    if let Some(module_id) = &module_id {
                        topology.forwards.insert(
                            exported,
                            (module_id.clone(), module_export_name(&specifier.local)),
                        );
                    }
                }
            }
            Statement::ExportNamedDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    let exported = module_export_name(&specifier.exported);
                    let local = module_export_name(&specifier.local);
                    topology.explicit.insert(exported.clone());
                    if let Some((source, imported)) = imports.get(local.as_str()) {
                        if let Some(module_id) = target(source)? {
                            if let Some(imported) = imported {
                                topology
                                    .forwards
                                    .insert(exported, (module_id, imported.clone()));
                            } else {
                                topology.namespaces.insert(exported, module_id);
                            }
                        }
                    } else {
                        topology.locals.insert(exported, local);
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let local = match &export.declaration {
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => continue,
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        function.id.as_ref().map(|id| id.name.to_string())
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        class.id.as_ref().map(|id| id.name.to_string())
                    }
                    _ => None,
                };
                topology.explicit.insert("default".to_string());
                topology.locals.insert(
                    "default".to_string(),
                    local.unwrap_or_else(|| DEFAULT_EXPORT_LOCAL.to_string()),
                );
                if let Some(Expression::Identifier(identifier)) = export.declaration.as_expression()
                {
                    if let Some((source, Some(imported))) = imports.get(identifier.name.as_str()) {
                        topology.default_snapshot_source =
                            target(source)?.map(|module_id| (module_id, imported.clone()));
                    }
                }
            }
            Statement::TSExportAssignment(export) => {
                topology.explicit.insert("default".to_string());
                topology
                    .locals
                    .insert("default".to_string(), DEFAULT_EXPORT_LOCAL.to_string());
                if let Expression::Identifier(identifier) = &export.expression {
                    if let Some((source, Some(imported))) = imports.get(identifier.name.as_str()) {
                        topology.default_snapshot_source =
                            target(source)?.map(|module_id| (module_id, imported.clone()));
                    }
                }
            }
            Statement::ExportAllDeclaration(export)
                if export.export_kind != ImportOrExportKind::Type =>
            {
                if let Some(exported) = &export.exported {
                    let exported = module_export_name(exported);
                    topology.explicit.insert(exported.clone());
                    if let Some(module_id) = target(export.source.value.as_str())? {
                        topology.namespaces.insert(exported, module_id);
                    }
                } else {
                    topology.stars.push(resolve_module_id_for_specifier(
                        file_path,
                        export.source.value.as_str(),
                        context,
                    )?);
                }
            }
            _ => {}
        }
    }
    Ok(topology)
}

fn collect_declaration_names(declaration: &Declaration<'_>, names: &mut BTreeSet<String>) {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for declarator in &declaration.declarations {
                collect_pattern_names(&declarator.id, names);
            }
        }
        Declaration::FunctionDeclaration(declaration) => {
            if let Some(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
        }
        Declaration::ClassDeclaration(declaration) => {
            if let Some(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
        }
        Declaration::TSEnumDeclaration(declaration) => {
            names.insert(declaration.id.name.to_string());
        }
        Declaration::TSNamespaceDeclaration(declaration) => {
            names.insert(declaration.id.name.to_string());
        }
        _ => {}
    }
}

fn collect_pattern_names(pattern: &BindingPattern<'_>, names: &mut BTreeSet<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            names.insert(identifier.name.to_string());
        }
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

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}
