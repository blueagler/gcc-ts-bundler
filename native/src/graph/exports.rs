use super::*;

pub(super) fn collect_exports(
    file_path: &PathBuf,
    commonjs_cache: &mut HashMap<PathBuf, CommonJsAnalysis>,
    module_cache: &mut HashMap<PathBuf, Module>,
    export_cache: &mut HashMap<PathBuf, EntryExportMetadata>,
    context: &ResolveContext,
) -> std::result::Result<EntryExportMetadata, String> {
    if let Some(existing) = export_cache.get(file_path) {
        return Ok(existing.clone());
    }

    let module = if let Some(existing) = module_cache.get(file_path) {
        existing.clone()
    } else {
        let parsed = parse_source_file(file_path)?;
        module_cache.insert(file_path.clone(), parsed.clone());
        parsed
    };

    let commonjs_analysis = commonjs_cache
        .get(file_path)
        .cloned()
        .unwrap_or_else(|| analyze_commonjs_module(&module));
    commonjs_cache.insert(file_path.clone(), commonjs_analysis.clone());
    if commonjs_analysis.has_commonjs {
        if let Some(specifier) = commonjs_analysis.proxy_export {
            if let Some(resolved) = resolve_module_specifier(&specifier, file_path, context)? {
                let metadata = collect_exports(
                    &resolved.path,
                    commonjs_cache,
                    module_cache,
                    export_cache,
                    context,
                )?;
                export_cache.insert(file_path.clone(), metadata.clone());
                return Ok(metadata);
            }
        }

        let metadata = EntryExportMetadata {
            exportNames: commonjs_analysis.export_names,
            hasDefaultExport: commonjs_analysis.has_default_export,
            sourcePath: file_path.to_string_lossy().to_string(),
        };
        export_cache.insert(file_path.clone(), metadata.clone());
        return Ok(metadata);
    }

    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for item in module.body.iter() {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                match &export_decl.decl {
                    Decl::Class(class_decl) => {
                        export_names.insert(class_decl.ident.sym.to_string());
                    }
                    Decl::Fn(fn_decl) => {
                        export_names.insert(fn_decl.ident.sym.to_string());
                    }
                    Decl::Var(var_decl) => {
                        for declarator in &var_decl.decls {
                            collect_pattern_idents(&declarator.name, &mut export_names);
                        }
                    }
                    Decl::TsEnum(enum_decl) => {
                        export_names.insert(enum_decl.id.sym.to_string());
                    }
                    _ => {}
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
            | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                has_default_export = true;
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if named.type_only {
                    continue;
                }

                if let Some(src) = &named.src {
                    if let Some(resolved) =
                        resolve_module_specifier(&src.value.to_string_lossy(), file_path, context)?
                    {
                        let target_exports = collect_exports(
                            &resolved.path,
                            commonjs_cache,
                            module_cache,
                            export_cache,
                            context,
                        )?;
                        for specifier in &named.specifiers {
                            match specifier {
                                ExportSpecifier::Named(named_specifier) => {
                                    let exported_name = export_name_from_module_export_name(
                                        named_specifier
                                            .exported
                                            .as_ref()
                                            .unwrap_or(&named_specifier.orig),
                                    );
                                    if exported_name != "default" {
                                        export_names.insert(exported_name);
                                    }
                                }
                                // `export * as ns from "./m"` exports one name:
                                // the namespace object. Dropping it here left
                                // the entry shim with nothing to re-export, so
                                // ADVANCED pruned the whole module and every
                                // consumer read `undefined`.
                                ExportSpecifier::Namespace(namespace_specifier) => {
                                    export_names.insert(export_name_from_module_export_name(
                                        &namespace_specifier.name,
                                    ));
                                }
                                ExportSpecifier::Default(_) => {}
                            }
                        }
                        if target_exports.hasDefaultExport
                            && named.specifiers.iter().any(|specifier| match specifier {
                                ExportSpecifier::Named(named_specifier) => {
                                    export_name_from_module_export_name(
                                        named_specifier
                                            .exported
                                            .as_ref()
                                            .unwrap_or(&named_specifier.orig),
                                    ) == "default"
                                }
                                _ => false,
                            })
                        {
                            has_default_export = true;
                        }
                    }
                } else {
                    for specifier in &named.specifiers {
                        if let ExportSpecifier::Named(named_specifier) = specifier {
                            let exported_name = export_name_from_module_export_name(
                                named_specifier
                                    .exported
                                    .as_ref()
                                    .unwrap_or(&named_specifier.orig),
                            );
                            if exported_name == "default" {
                                has_default_export = true;
                            } else {
                                export_names.insert(exported_name);
                            }
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                if export_all.type_only {
                    continue;
                }

                if let Some(resolved) = resolve_module_specifier(
                    &export_all.src.value.to_string_lossy(),
                    file_path,
                    context,
                )? {
                    let target_exports = collect_exports(
                        &resolved.path,
                        commonjs_cache,
                        module_cache,
                        export_cache,
                        context,
                    )?;
                    for export_name in target_exports.exportNames {
                        export_names.insert(export_name);
                    }
                }
            }
            _ => {}
        }
    }

    let metadata = EntryExportMetadata {
        exportNames: export_names.into_iter().collect(),
        hasDefaultExport: has_default_export,
        sourcePath: file_path.to_string_lossy().to_string(),
    };
    export_cache.insert(file_path.clone(), metadata.clone());
    Ok(metadata)
}

fn collect_pattern_idents(pattern: &Pat, out: &mut BTreeSet<String>) {
    match pattern {
        Pat::Ident(ident) => {
            out.insert(ident.id.sym.to_string());
        }
        Pat::Array(array) => {
            for pattern in array.elems.iter().flatten() {
                collect_pattern_idents(pattern, out);
            }
        }
        Pat::Object(object) => {
            for property in &object.props {
                match property {
                    ObjectPatProp::Assign(assign) => {
                        out.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_pattern_idents(&key_value.value, out);
                    }
                    ObjectPatProp::Rest(rest) => {
                        collect_pattern_idents(&rest.arg, out);
                    }
                }
            }
        }
        Pat::Rest(rest) => collect_pattern_idents(&rest.arg, out),
        Pat::Assign(assign) => collect_pattern_idents(&assign.left, out),
        _ => {}
    }
}

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
}
