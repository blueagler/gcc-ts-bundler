use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use oxc_ast::ast::*;

use super::super::super::fresh::FreshNameAllocator;
use super::super::super::imports_exports::{
    render_grouped_live_slot_exports_with, BundlerExportSlotMode, ImportBindingSlotAlias,
};
use super::super::super::{
    render_live_export_slot_with, render_static_export_slot_with, resolve_module_id_for_specifier,
    to_bundler_runtime_module_id, BundlerModuleSlots, TranspileContext,
};
use super::slots::module_export_name;

#[allow(clippy::too_many_arguments)]
pub(crate) fn convert_bundler_named_export(
    file_path: &Path,
    export: &ExportNamedDeclaration<'_>,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    import_binding_rewrites: &HashMap<String, String>,
    import_binding_slot_aliases: &HashMap<String, ImportBindingSlotAlias>,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    require_name: &str,
    exports_name: &str,
    live_name: &str,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(source) = &export.source {
        let local_name = fresh_names.fresh(&format!("__gcc_export_{}", *export_counter));
        *export_counter += 1;
        let module_id = resolve_module_id_for_specifier(file_path, source.value.as_str(), context)?;
        let runtime_module_id = to_bundler_runtime_module_id(&module_id);
        lines.push(format!(
            "const {local_name} = {require_name}({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        let mut slot_pairs = Vec::new();
        for specifier in &export.specifiers {
            if specifier.export_kind == ImportOrExportKind::Type {
                continue;
            }
            let source_name = module_export_name(&specifier.local);
            let export_name = module_export_name(&specifier.exported);
            let source_slot = target_slots.slot_for(&source_name).ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {} in {}",
                    source_name, module_id
                )
            })?;
            let target_slot = current_slots
                .slot_for(&export_name)
                .ok_or_else(|| format!("Missing bundler-runtime export slot for {export_name}"))?;
            slot_pairs.push((target_slot, source_slot));
        }
        lines.extend(render_grouped_live_slot_exports_with(
            &local_name,
            slot_pairs,
            live_name,
            exports_name,
        ));
        return Ok(lines);
    }

    let mut grouped_alias_exports = BTreeMap::<String, Vec<(usize, usize)>>::new();
    for specifier in &export.specifiers {
        if specifier.export_kind == ImportOrExportKind::Type {
            continue;
        }
        let local_name = module_export_name(&specifier.local);
        let export_name = module_export_name(&specifier.exported);
        let target_slot = current_slots
            .slot_for(&export_name)
            .ok_or_else(|| format!("Missing bundler-runtime export slot for {export_name}"))?;
        let slot_mode = local_export_modes
            .get(&local_name)
            .copied()
            .unwrap_or(BundlerExportSlotMode::Live);
        if slot_mode == BundlerExportSlotMode::Live {
            if let Some(alias) = import_binding_slot_aliases.get(&local_name) {
                grouped_alias_exports
                    .entry(alias.source_object_name.clone())
                    .or_default()
                    .push((target_slot, alias.source_slot));
                continue;
            }
        }
        let value = import_binding_rewrites
            .get(&local_name)
            .map(String::as_str)
            .unwrap_or(local_name.as_str());
        lines.push(match slot_mode {
            BundlerExportSlotMode::Static => {
                render_static_export_slot_with(exports_name, target_slot, value)
            }
            BundlerExportSlotMode::Live => {
                render_live_export_slot_with(live_name, exports_name, target_slot, value)
            }
        });
    }
    for (source_object_name, slot_pairs) in grouped_alias_exports {
        lines.extend(render_grouped_live_slot_exports_with(
            &source_object_name,
            slot_pairs,
            live_name,
            exports_name,
        ));
    }
    Ok(lines)
}
