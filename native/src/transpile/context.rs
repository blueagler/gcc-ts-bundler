use super::*;

pub(super) fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "off" => Ok(ChunkMode::Off),
        "bundler-runtime" => Ok(ChunkMode::BundlerRuntime),
        "split" => Ok(ChunkMode::Split),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

#[derive(Clone, Debug)]
pub(super) struct TranspileContext {
    pub(super) bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    pub(super) bundler_runtime_logical_ids: HashMap<String, String>,
    pub(super) chunk_mode: ChunkMode,
    pub(super) class_map_calls: Vec<ClassMapCallInput>,
    /// Callees whose results are pure; declarations initialized by them stay
    /// movable across chunks. Supplied by framework presets.
    pub(super) pure_callees: HashSet<String>,
    pub(super) commonjs_specifiers: HashSet<String>,
    pub(super) file_metadata: HashMap<String, ClosureFileMetadata>,
    pub(super) hoist_plan: Option<std::sync::Arc<HoistPlan>>,
    pub(super) lazy_imports_by_file: HashMap<String, Vec<LazyImportInput>>,
    /// Logical module ids that are dynamic-import targets; their facades
    /// expose ESM interop markers for host-library namespace unwrapping.
    pub(super) lazy_target_module_ids: HashSet<String>,
    pub(super) package_aliases: Vec<PackageAliasInput>,
    pub(super) preserved_property_names: HashSet<String>,
    pub(super) static_property_names: HashSet<String>,
    /// Checker-derived JSDoc per source file, keyed by
    /// `typed_annotations::annotation_key`. Consumed by hoisted emission
    /// only; `Off`/`Split` carry their JSDoc through `closure-ir` metadata.
    pub(super) typed_annotations: HashMap<String, TypedAnnotationsByName>,
    /// Module ids that the chunk plan placed in the vendor chunk. Empty
    /// unless `chunks.vendorChunk` produced one; see `transpile::assigners`.
    pub(super) vendor_module_ids: HashSet<String>,
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
    /// Split: goog.module emission compiled as one Closure program with
    /// --chunk, plus a lazy-namespace registry for dynamic import.
    Split,
}

pub(super) fn collect_bundler_module_slots(
    file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
) -> std::result::Result<HashMap<String, BundlerModuleSlots>, String> {
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

    let mut raw_exports_by_module = HashMap::<String, RawBundlerExportInfo>::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module_id = to_goog_module_id(&file_path, workspace_dir);
        let module = get_or_parse_cached_module(&file_path)?;
        let commonjs_analysis = analyze_commonjs_module(&module);
        let raw_exports = if should_normalize_commonjs(&file_path, &commonjs_analysis) {
            RawBundlerExportInfo {
                explicit_exports: BTreeSet::from([
                    "__cjsExports".to_string(),
                    "default".to_string(),
                ]),
                export_all_modules: Vec::new(),
            }
        } else {
            collect_raw_bundler_exports(&module, &file_path, &resolution_context)?
        };
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
                    if export_name == "default" {
                        continue;
                    }
                    changed |= resolved_names.insert(export_name);
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
    module: &Module,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<RawBundlerExportInfo, String> {
    let mut raw_exports = RawBundlerExportInfo::default();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                raw_exports
                    .explicit_exports
                    .extend(exported_decl_names(&export_decl.decl));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                if named_export.type_only {
                    continue;
                }
                if let Some(src) = &named_export.src {
                    for specifier in &named_export.specifiers {
                        match specifier {
                            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                                let local_name = module_export_name_to_string(&named.orig);
                                let export_name = named
                                    .exported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or(local_name);
                                raw_exports.explicit_exports.insert(export_name);
                            }
                            swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                                return Err(format!(
                                    "bundler-runtime does not support namespace re-exports in {}",
                                    file_path.display()
                                ));
                            }
                            _ => {}
                        }
                    }
                    if named_export.specifiers.is_empty() {
                        let module_id = resolve_module_id_for_specifier(
                            file_path,
                            &src.value.to_string_lossy(),
                            context,
                        )?;
                        raw_exports.export_all_modules.push(module_id);
                    }
                } else {
                    for specifier in &named_export.specifiers {
                        match specifier {
                            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                                let local_name = module_export_name_to_string(&named.orig);
                                let export_name = named
                                    .exported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or(local_name);
                                raw_exports.explicit_exports.insert(export_name);
                            }
                            swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                                return Err(format!(
                                    "bundler-runtime does not support namespace re-exports in {}",
                                    file_path.display()
                                ));
                            }
                            _ => {}
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(_))
            | ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(_)) => {
                raw_exports.explicit_exports.insert("default".to_string());
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                raw_exports.export_all_modules.push(module_id);
            }
            _ => {}
        }
    }

    Ok(raw_exports)
}
