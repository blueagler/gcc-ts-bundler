use super::*;

mod bindings;
mod resolve;

pub(super) use self::bindings::{
    exported_decl_names, member_access, module_export_name_to_string, render_module_export_slot,
    stable_slot_access,
};
pub(super) use self::resolve::resolve_module_id_for_specifier;
use self::bindings::{bind_bundler_import_specifiers, bind_import_specifiers};

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
