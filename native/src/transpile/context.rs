use super::*;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ImportOrExportKind,
    ModuleExportName, Program as OxcProgram, Statement,
};

pub(super) fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "off" => Ok(ChunkMode::Off),
        "bundler-runtime" | "split" => Ok(ChunkMode::BundlerRuntime),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

#[derive(Clone, Debug)]
pub(super) struct TranspileContext {
    pub(super) bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    pub(super) bundler_runtime_logical_ids: HashMap<String, String>,
    pub(super) chunk_mode: ChunkMode,
    pub(super) class_map_calls: Vec<ClassMapCallInput>,
    pub(super) pure_callees: HashSet<String>,
    pub(super) commonjs_specifiers: HashSet<String>,
    pub(super) opaque_commonjs: std::sync::Arc<OpaqueCommonJs>,
    pub(super) boundary_identity_tokens: HashMap<String, String>,
    pub(super) external_specifiers: HashMap<String, String>,
    pub(super) opaque_external_specifiers: HashSet<String>,
    pub(super) file_metadata: HashMap<String, ClosureFileMetadata>,
    pub(super) hoist_plan: Option<std::sync::Arc<HoistPlan>>,
    pub(super) lazy_imports_by_file: HashMap<String, Vec<LazyImportInput>>,
    pub(super) lazy_target_module_ids: HashSet<String>,
    pub(super) package_aliases: Vec<PackageAliasInput>,
    pub(super) preserved_modules: HashMap<String, PreservedModuleInput>,
    pub(super) resolved_module_ids: HashMap<String, String>,
    pub(super) preserved_property_names: HashSet<String>,
    pub(super) static_property_names: HashSet<String>,
    pub(super) type_metadata_enabled: bool,
    pub(super) assigner_pin_module_ids: HashSet<String>,
    pub(super) workspace_dir: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub(super) struct BundlerModuleSlots {
    export_slots: BTreeMap<String, usize>,
}

impl BundlerModuleSlots {
    pub(super) fn from_export_names(export_names: &BTreeSet<String>) -> Self {
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
pub(super) struct RawBundlerExportInfo {
    pub(super) explicit_exports: BTreeSet<String>,
    pub(super) export_all_modules: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChunkMode {
    Off,
    BundlerRuntime,
}

pub(super) fn collect_bundler_module_slots(
    file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<HashMap<String, BundlerModuleSlots>, String> {
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
        assigner_pin_module_ids: HashSet::new(),
        workspace_dir: workspace_dir.to_path_buf(),
    };

    let mut raw_exports_by_module = HashMap::<String, RawBundlerExportInfo>::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module_id = to_goog_module_id(&file_path, workspace_dir);
        let authored_source = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let metadata = file_metadata.get(&closure_metadata_key(&file_path));
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
        let mut raw_exports = if should_normalize_commonjs(&file_path, &commonjs_analysis) {
            RawBundlerExportInfo {
                explicit_exports: BTreeSet::from([
                    "__cjsExports".to_string(),
                    "default".to_string(),
                ]),
                export_all_modules: Vec::new(),
            }
        } else {
            collect_raw_bundler_exports(&program, &file_path, &resolution_context)?
        };
        if let Some(metadata) = metadata {
            raw_exports.explicit_exports.extend(
                metadata
                    .enums
                    .iter()
                    .filter(|enum_decl| enum_decl.exported)
                    .map(|enum_decl| enum_decl.binding_name.clone()),
            );
        }
        raw_exports_by_module.insert(module_id, raw_exports);
    }

    let mut resolved_export_names = raw_exports_by_module
        .iter()
        .map(|(module_id, raw)| (module_id.clone(), raw.explicit_exports.clone()))
        .collect::<HashMap<_, _>>();
    loop {
        let mut changed = false;
        for (module_id, raw_exports) in &raw_exports_by_module {
            for target_module_id in &raw_exports.export_all_modules {
                let Some(target_names) = resolved_export_names.get(target_module_id).cloned()
                else {
                    return Err(format!(
                        "Unable to resolve bundler-runtime slot exports for module {target_module_id}"
                    ));
                };
                let resolved_names = resolved_export_names.entry(module_id.clone()).or_default();
                for export_name in target_names {
                    if export_name != "default" {
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

pub(super) fn collect_raw_bundler_exports(
    program: &OxcProgram<'_>,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<RawBundlerExportInfo, String> {
    let mut raw_exports = RawBundlerExportInfo::default();
    for statement in &program.body {
        match statement {
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = &export.declaration {
                    collect_declaration_names(declaration, &mut raw_exports.explicit_exports);
                }
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Value {
                        raw_exports
                            .explicit_exports
                            .insert(module_export_name(&specifier.exported));
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if !matches!(
                    export.declaration,
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_)
                ) {
                    raw_exports.explicit_exports.insert("default".to_string());
                }
            }
            Statement::TSExportAssignment(_) => {
                raw_exports.explicit_exports.insert("default".to_string());
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if export.exported.is_some() {
                    return Err(format!(
                        "bundler-runtime does not support namespace re-exports in {}",
                        file_path.display()
                    ));
                }
                raw_exports
                    .export_all_modules
                    .push(resolve_module_id_for_specifier(
                        file_path,
                        export.source.value.as_str(),
                        context,
                    )?);
            }
            _ => {}
        }
    }
    Ok(raw_exports)
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
        Declaration::TSModuleDeclaration(declaration) => {
            if let oxc_ast::ast::TSModuleDeclarationName::Identifier(id) = &declaration.id {
                names.insert(id.name.to_string());
            }
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

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}
