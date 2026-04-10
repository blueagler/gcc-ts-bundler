use super::*;

mod bindings;
mod resolve;

use self::bindings::{
    bind_import_specifiers, collect_named_export_bindings, plan_bundler_import_specifiers,
    reject_namespace_export_specifiers, ImportBindingRewrite,
};
pub(super) use self::bindings::{
    apply_import_binding_rewrites,
    exported_decl_names, member_access, module_export_name_to_string, render_live_export_slot,
    render_static_export_slot, stable_slot_access, BundlerExportSlotMode,
};
pub(super) use self::resolve::resolve_module_id_for_specifier;

pub(super) struct BundlerImportPlan {
    pub(super) lines: Vec<String>,
    pub(super) binding_rewrites: Vec<ImportBindingRewrite>,
}

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
) -> std::result::Result<BundlerImportPlan, String> {
    let module_id = resolve_module_id_for_specifier(
        file_path,
        &import_decl.src.value.to_string_lossy(),
        context,
    )?;
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let mut lines = Vec::new();
    let mut binding_rewrites = Vec::new();
    if import_decl.specifiers.is_empty() {
        lines.push(format!("__require({runtime_module_id:?});"));
        return Ok(BundlerImportPlan {
            lines,
            binding_rewrites,
        });
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
        let (specifier_lines, specifier_rewrites) = plan_bundler_import_specifiers(
            &local_name,
            &value_specifiers,
            target_slots,
        )?;
        lines.extend(specifier_lines);
        binding_rewrites.extend(specifier_rewrites);
    }

    Ok(BundlerImportPlan {
        lines,
        binding_rewrites,
    })
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
        for binding in collect_named_export_bindings(named_export) {
            lines.push(format!(
                "exports.{} = {};",
                binding.export_name,
                member_access(&require_name, &binding.local_name)
            ));
        }
        return Ok(lines);
    }

    for binding in collect_named_export_bindings(named_export) {
        lines.push(format!(
            "exports.{} = {};",
            binding.export_name, binding.local_name
        ));
    }
    Ok(lines)
}

pub(super) fn convert_bundler_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    import_binding_rewrites: &HashMap<String, String>,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    export_counter: &mut usize,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    reject_namespace_export_specifiers(named_export, file_path)?;
    if let Some(src) = &named_export.src {
        let require_name = format!("__gcc_export_{}", *export_counter);
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        let runtime_module_id = to_bundler_runtime_module_id(&module_id);
        lines.push(format!(
            "const {require_name} = __require({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        for binding in collect_named_export_bindings(named_export) {
            let source_slot = target_slots.slot_for(&binding.local_name).ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {} in {}",
                    binding.local_name, module_id
                )
            })?;
            let target_slot = current_slots
                .slot_for(&binding.export_name)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {}",
                        binding.export_name
                    )
                })?;
            lines.push(render_live_export_slot(
                target_slot,
                &stable_slot_access(&require_name, source_slot),
            ));
        }
        return Ok(lines);
    }

    for binding in collect_named_export_bindings(named_export) {
        let target_slot = current_slots
            .slot_for(&binding.export_name)
            .ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {}",
                    binding.export_name
                )
            })?;
        let value_expression = import_binding_rewrites
            .get(&binding.local_name)
            .map(String::as_str)
            .unwrap_or(binding.local_name.as_str());
        match local_export_modes
            .get(&binding.local_name)
            .copied()
            .unwrap_or(BundlerExportSlotMode::Live)
        {
            BundlerExportSlotMode::Static => {
                lines.push(render_static_export_slot(target_slot, value_expression))
            }
            BundlerExportSlotMode::Live => {
                lines.push(render_live_export_slot(target_slot, value_expression))
            }
        }
    }
    Ok(lines)
}
