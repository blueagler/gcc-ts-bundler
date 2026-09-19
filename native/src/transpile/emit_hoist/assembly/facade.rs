use std::collections::HashMap;

use super::super::super::hoist::{suffixed_name, FacadeSlots, HoistPlan};
use super::super::super::imports_exports::{
    render_live_export_slot, render_namespace_export_slots_with,
    render_reified_namespace_export_slots_with, render_static_export_slot, BundlerExportSlotMode,
};
use super::super::super::{to_bundler_runtime_module_id, TranspileContext};

pub(crate) fn render_facade(
    module_id: &str,
    ordinal: usize,
    context: &TranspileContext,
    plan: &HoistPlan,
    facade_slots: &FacadeSlots,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<Vec<String>, String> {
    let slots = context
        .bundler_module_slots
        .get(module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    let mut lines = Vec::new();
    for export_name in slots.export_names() {
        if let FacadeSlots::Named(needed) = facade_slots {
            if !needed.contains(export_name) {
                continue;
            }
        }
        let slot = slots.slot_for(export_name).ok_or_else(|| {
            format!("Missing bundler-runtime export slot for {export_name} in {module_id}")
        })?;
        if let Some(target) = plan.resolve_namespace_reexport(module_id, export_name) {
            let runtime_id = to_bundler_runtime_module_id(target);
            lines.push(render_static_export_slot(
                slot,
                &format!("__require({runtime_id:?},true)"),
            ));
            continue;
        }
        let binding = plan.resolve_export(module_id, export_name).ok_or_else(|| {
            format!("Missing hoisted export binding for {export_name} in {module_id}")
        })?;
        if binding.module_id == module_id {
            let value = suffixed_name(&binding.local_name, ordinal);
            let mode = local_export_modes
                .get(&binding.local_name)
                .copied()
                .unwrap_or(BundlerExportSlotMode::Live);
            lines.push(match mode {
                BundlerExportSlotMode::Static => render_static_export_slot(slot, &value),
                BundlerExportSlotMode::Live => render_live_export_slot(slot, &value),
            });
            continue;
        }
        if plan.is_direct_binding(module_id, binding) {
            let value = plan
                .direct_binding_name(binding)
                .ok_or_else(|| format!("Missing hoist ordinal for {}", binding.module_id))?;
            lines.push(match plan.direct_binding_slot_mode(module_id, binding) {
                BundlerExportSlotMode::Static => render_static_export_slot(slot, &value),
                BundlerExportSlotMode::Live => render_live_export_slot(slot, &value),
            });
            continue;
        }
        let owner_slots = context
            .bundler_module_slots
            .get(&binding.module_id)
            .ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slots for {}",
                    binding.module_id
                )
            })?;
        let owner_slot = owner_slots.slot_for(&binding.export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                binding.export_name, binding.module_id
            )
        })?;
        let owner_runtime_id = to_bundler_runtime_module_id(&binding.module_id);
        lines.push(render_live_export_slot(
            slot,
            &format!("__require({owner_runtime_id:?})[{owner_slot}]"),
        ));
    }
    let is_exposed = |export_name: &str| match facade_slots {
        FacadeSlots::All => true,
        FacadeSlots::Named(needed) => needed.contains(export_name),
    };
    if let Some(export_name) = commonjs_export_name {
        if is_exposed(export_name) {
            let slot = slots.slot_for(export_name).ok_or_else(|| {
                format!("Missing bundler-runtime export slot for {export_name} in {module_id}")
            })?;
            lines.push(format!(
                "__live(__exports,{export_name:?},function(){{return __exports[{slot}];}});"
            ));
        }
    }

    if context.lazy_target_module_ids.contains(module_id)
        || plan.is_namespace_object_module(module_id)
    {
        let namespace_slots = slots
            .export_names()
            .filter(|export_name| export_name.as_str() != "__cjsExports" && is_exposed(export_name))
            .filter_map(|export_name| {
                slots
                    .slot_for(export_name)
                    .map(|slot| (export_name.clone(), slot))
            })
            .collect::<Vec<_>>();
        if !namespace_slots.is_empty() {
            lines.push(if plan.is_reified_namespace_module(module_id) {
                render_reified_namespace_export_slots_with("__exports", &namespace_slots)
            } else {
                render_namespace_export_slots_with("__exports", &namespace_slots)
            });
        }
        if slots.slot_for("default") == Some(0) {
            lines.push("__exports.__esModule = true;".to_string());
        }
    }
    let runtime_module_id = to_bundler_runtime_module_id(module_id);
    Ok(vec![format!(
        "__register({runtime_module_id:?}, function(__require, __exports, __dynamicImport, __preloadDynamicImport, __live) {{\n{}\n}});",
        lines
            .into_iter()
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    )])
}
