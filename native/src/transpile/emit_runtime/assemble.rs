use super::super::{
    apply_js_compat_text_fixes, render_live_export_slot_with, render_namespace_export_slots_with,
    render_reified_namespace_export_slots_with, BundlerModuleSlots, TranspileContext,
};
use super::exports::{indent_block, RuntimeBindingNames};

pub(crate) fn assemble_runtime_module_text(
    runtime_module_id: &str,
    module_id: &str,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    runtime_names: &RuntimeBindingNames,
    commonjs_export_name: Option<&str>,
    mut output: Vec<String>,
) -> std::result::Result<String, String> {
    if let Some(export_name) = commonjs_export_name {
        let export_slot = current_slots.slot_for(export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                export_name, module_id
            )
        })?;
        output.push(render_live_export_slot_with(
            &runtime_names.live,
            &runtime_names.exports,
            export_slot,
            export_name,
        ));
        output.push(format!(
            "{}({}, {:?}, function(){{return {};}});",
            runtime_names.live, runtime_names.exports, export_name, export_name
        ));
        let default_slot = current_slots.slot_for("default").ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for default in {}",
                module_id
            )
        })?;
        output.push(render_live_export_slot_with(
            &runtime_names.live,
            &runtime_names.exports,
            default_slot,
            export_name,
        ));
    }

    if context.lazy_target_module_ids.contains(module_id)
        || context
            .hoist_plan
            .as_ref()
            .is_some_and(|plan| plan.is_namespace_object_module(module_id))
    {
        let namespace_slots = current_slots
            .export_names()
            .filter(|export_name| export_name.as_str() != "__cjsExports")
            .map(|export_name| {
                let slot = current_slots.slot_for(export_name).ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for {export_name} in {module_id}")
                })?;
                Ok((export_name.clone(), slot))
            })
            .collect::<Result<Vec<_>, String>>()?;
        if !namespace_slots.is_empty() {
            output.push(
                if context
                    .hoist_plan
                    .as_ref()
                    .is_some_and(|plan| plan.is_reified_namespace_module(module_id))
                {
                    render_reified_namespace_export_slots_with(
                        &runtime_names.exports,
                        &namespace_slots,
                    )
                } else {
                    render_namespace_export_slots_with(&runtime_names.exports, &namespace_slots)
                },
            );
        }
        if current_slots.slot_for("default") == Some(0) {
            output.push(format!("{}.__esModule = true;", runtime_names.exports));
        }
    }

    let body = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let source = format!(
        "__register({runtime_module_id:?}, function({}, {}, {}, {}, {}) {{\n{}\n}});",
        runtime_names.require,
        runtime_names.exports,
        runtime_names.dynamic_import,
        runtime_names.preload_dynamic_import,
        runtime_names.live,
        indent_block(&body),
    );
    Ok(apply_js_compat_text_fixes(source))
}
