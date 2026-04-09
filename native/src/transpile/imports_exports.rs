use super::*;

pub(super) fn convert_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
) -> std::result::Result<Vec<String>, String> {
    let module_id = resolve_module_id_for_specifier(
        file_path,
        &import_decl.src.value.to_string_lossy(),
        context,
    )?;
    let mut lines = Vec::new();
    if import_decl.specifiers.is_empty() {
        lines.push(format!("goog.require({module_id:?});"));
        return Ok(lines);
    }

    let mut value_specifiers = Vec::new();
    let mut type_specifiers = Vec::new();
    for specifier in &import_decl.specifiers {
        match specifier {
            ImportSpecifier::Named(named) if import_decl.type_only || named.is_type_only => {
                type_specifiers.push(specifier);
            }
            _ if import_decl.type_only => type_specifiers.push(specifier),
            _ => value_specifiers.push(specifier),
        }
    }

    if !value_specifiers.is_empty() {
        let local_name = format!("__goog_import_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!("const {local_name} = goog.require({module_id:?});"));
        lines.extend(bind_import_specifiers(&local_name, &value_specifiers));
    }
    if !type_specifiers.is_empty() {
        let local_name = format!("__goog_type_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = goog.requireType({module_id:?});"
        ));
        lines.extend(bind_import_specifiers(&local_name, &type_specifiers));
    }

    Ok(lines)
}

pub(super) fn convert_bundler_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
) -> std::result::Result<(Vec<String>, Vec<String>), String> {
    let module_id = resolve_module_id_for_specifier(
        file_path,
        &import_decl.src.value.to_string_lossy(),
        context,
    )?;
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let mut lines = Vec::new();
    let mut dependency_ids = Vec::new();
    if import_decl.specifiers.is_empty() {
        lines.push(format!("__require({runtime_module_id:?});"));
        dependency_ids.push(module_id);
        return Ok((lines, dependency_ids));
    }

    let mut value_specifiers = Vec::new();
    for specifier in &import_decl.specifiers {
        match specifier {
            ImportSpecifier::Named(named) if import_decl.type_only || named.is_type_only => {}
            _ if import_decl.type_only => {}
            _ => value_specifiers.push(specifier),
        }
    }

    if !value_specifiers.is_empty() {
        let local_name = format!("__gcc_import_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = __require({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        lines.extend(bind_bundler_import_specifiers(
            &local_name,
            &value_specifiers,
            target_slots,
        )?);
        dependency_ids.push(module_id);
    }

    Ok((lines, dependency_ids))
}

fn bind_import_specifiers(local_name: &str, specifiers: &[&ImportSpecifier]) -> Vec<String> {
    specifiers
        .iter()
        .map(|specifier| match specifier {
            ImportSpecifier::Default(default_specifier) => format!(
                "const {} = {}.default;",
                default_specifier.local.sym, local_name
            ),
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    member_access(local_name, &imported_name)
                )
            }
        })
        .collect()
}

fn bind_bundler_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::with_capacity(specifiers.len());
    for specifier in specifiers {
        let line = match specifier {
            ImportSpecifier::Default(default_specifier) => {
                let slot = target_slots
                    .slot_for("default")
                    .ok_or_else(|| "Missing bundler-runtime default export slot".to_string())?;
                format!(
                    "const {} = {};",
                    default_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                let slot = target_slots.slot_for(&imported_name).ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for imported name {imported_name}")
                })?;
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
        };
        lines.push(line);
    }
    Ok(lines)
}

pub(super) fn convert_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    export_counter: &mut usize,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(src) = &named_export.src {
        let require_name = format!("__goog_export_{}", *export_counter);
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        lines.push(format!(
            "const {require_name} = goog.require({module_id:?});"
        ));
        for specifier in &named_export.specifiers {
            let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                continue;
            };
            let local_name = module_export_name_to_string(&named.orig);
            let export_name = named
                .exported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| local_name.clone());
            lines.push(format!(
                "exports.{export_name} = {};",
                member_access(&require_name, &local_name)
            ));
        }
        return Ok(lines);
    }

    for specifier in &named_export.specifiers {
        let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
            continue;
        };
        let local_name = module_export_name_to_string(&named.orig);
        let export_name = named
            .exported
            .as_ref()
            .map(module_export_name_to_string)
            .unwrap_or_else(|| local_name.clone());
        lines.push(format!("exports.{export_name} = {local_name};"));
    }
    Ok(lines)
}

pub(super) fn convert_bundler_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    export_counter: &mut usize,
) -> std::result::Result<(Vec<String>, Vec<String>), String> {
    let mut lines = Vec::new();
    let mut dependency_ids = Vec::new();
    if let Some(src) = &named_export.src {
        let require_name = format!("__gcc_export_{}", *export_counter);
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        let runtime_module_id = to_bundler_runtime_module_id(&module_id);
        dependency_ids.push(module_id.clone());
        lines.push(format!(
            "const {require_name} = __require({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        for specifier in &named_export.specifiers {
            match specifier {
                swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                    let local_name = module_export_name_to_string(&named.orig);
                    let export_name = named
                        .exported
                        .as_ref()
                        .map(module_export_name_to_string)
                        .unwrap_or_else(|| local_name.clone());
                    let source_slot = target_slots.slot_for(&local_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            local_name, module_id
                        )
                    })?;
                    let target_slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                        format!("Missing bundler-runtime export slot for {}", export_name)
                    })?;
                    lines.push(render_module_export_slot(
                        target_slot,
                        &stable_slot_access(&require_name, source_slot),
                    ));
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
        return Ok((lines, dependency_ids));
    }

    for specifier in &named_export.specifiers {
        match specifier {
            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                let local_name = module_export_name_to_string(&named.orig);
                let export_name = named
                    .exported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| local_name.clone());
                let target_slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for {}", export_name)
                })?;
                lines.push(render_module_export_slot(target_slot, &local_name));
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
    Ok((lines, dependency_ids))
}

pub(super) fn exported_decl_names(decl: &swc_core::ecma::ast::Decl) -> Vec<String> {
    match decl {
        swc_core::ecma::ast::Decl::Fn(function_decl) => vec![function_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Class(class_decl) => vec![class_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Var(var_decl) => var_decl
            .decls
            .iter()
            .flat_map(|decl| binding_names(&decl.name))
            .collect(),
        _ => Vec::new(),
    }
}

fn binding_names(pattern: &Pat) -> Vec<String> {
    match pattern {
        Pat::Ident(ident) => vec![ident.id.sym.to_string()],
        Pat::Array(array) => array
            .elems
            .iter()
            .flatten()
            .flat_map(binding_names)
            .collect(),
        Pat::Object(object) => object
            .props
            .iter()
            .flat_map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    binding_names(&key_value.value)
                }
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    vec![assign.key.sym.to_string()]
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(rest) => binding_names(&rest.arg),
            })
            .collect(),
        Pat::Assign(assign) => binding_names(&assign.left),
        Pat::Rest(rest) => binding_names(&rest.arg),
        _ => Vec::new(),
    }
}

pub(super) fn member_access(object_name: &str, property_name: &str) -> String {
    if is_valid_js_identifier(property_name) {
        format!("{object_name}.{property_name}")
    } else {
        format!("{object_name}[{property_name:?}]")
    }
}

pub(super) fn stable_slot_access(object_name: &str, slot: usize) -> String {
    format!("{object_name}[{slot}]")
}

pub(super) fn render_module_export_slot(slot: usize, value_expression: &str) -> String {
    format!("__exports[{slot}] = {value_expression};")
}

pub(super) fn module_export_name_to_string(name: &swc_core::ecma::ast::ModuleExportName) -> String {
    match name {
        swc_core::ecma::ast::ModuleExportName::Ident(ident) => ident.sym.to_string(),
        swc_core::ecma::ast::ModuleExportName::Str(value) => {
            value.value.to_string_lossy().to_string()
        }
    }
}

pub(super) fn resolve_module_id_for_specifier(
    file_path: &Path,
    specifier: &str,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    if specifier.starts_with('.') {
        let resolved = resolve_relative_module(file_path, specifier).ok_or_else(|| {
            format!(
                "Failed to resolve module specifier {specifier:?} from {}",
                file_path.display()
            )
        })?;
        return Ok(to_goog_module_id(&resolved, &context.workspace_dir));
    }

    let (package_name, subpath) = split_package_specifier(specifier);
    let alias = context
        .package_aliases
        .iter()
        .find(|alias| alias.packageName == package_name && alias.subpath == subpath)
        .or_else(|| {
            context
                .package_aliases
                .iter()
                .find(|alias| alias.packageName == package_name && alias.subpath == ".")
        })
        .ok_or_else(|| format!("Failed to resolve package specifier {specifier:?}"))?;
    Ok(to_goog_module_id(
        Path::new(&alias.targetPath),
        &context.workspace_dir,
    ))
}

fn split_package_specifier(specifier: &str) -> (String, String) {
    if specifier.starts_with('@') {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = format!("{}/{}", parts[0], parts[1]);
        let subpath = if parts.len() > 2 {
            format!("./{}", parts[2..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    } else {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = parts[0].to_string();
        let subpath = if parts.len() > 1 {
            format!("./{}", parts[1..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    }
}
