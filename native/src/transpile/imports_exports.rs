//! Shared import/export naming and bundler-runtime rendering.

mod resolve;
pub(super) use resolve::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BundlerExportSlotMode {
    Live,
    Static,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ImportBindingSlotAlias {
    pub(crate) source_object_name: String,
    pub(crate) source_slot: usize,
}

pub(crate) fn live_export_accessor_name(export_name: &str) -> String {
    format!("__gccLive_{export_name}")
}

pub(crate) fn member_access(object_name: &str, property_name: &str) -> String {
    if super::is_valid_js_identifier(property_name) {
        format!("{object_name}.{property_name}")
    } else {
        format!("{object_name}[{property_name:?}]")
    }
}

pub(crate) fn stable_slot_access(object_name: &str, slot: usize) -> String {
    format!("{object_name}[{slot}]")
}

pub(crate) fn render_live_export_slot(slot: usize, value_expression: &str) -> String {
    render_live_export_slot_with("__live", "__exports", slot, value_expression)
}

pub(crate) fn render_live_export_slot_with(
    live_name: &str,
    exports_name: &str,
    slot: usize,
    value_expression: &str,
) -> String {
    format!("{live_name}({exports_name},{slot},function(){{return {value_expression};}});")
}

pub(crate) fn render_packed_live_export_slots_with(
    live_name: &str,
    exports_name: &str,
    source_object_name: &str,
    slot_pairs: &[(usize, usize)],
) -> String {
    let flat_pairs = slot_pairs
        .iter()
        .flat_map(|(target_slot, source_slot)| [target_slot, source_slot])
        .map(|slot| slot.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("{live_name}({exports_name},{source_object_name},[{flat_pairs}]);")
}

pub(super) fn render_grouped_live_slot_exports_with(
    source_object_name: &str,
    mut slot_pairs: Vec<(usize, usize)>,
    live_name: &str,
    exports_name: &str,
) -> Vec<String> {
    slot_pairs.sort_unstable();
    if slot_pairs.len() > 1 {
        return vec![render_packed_live_export_slots_with(
            live_name,
            exports_name,
            source_object_name,
            &slot_pairs,
        )];
    }
    slot_pairs
        .into_iter()
        .map(|(target_slot, source_slot)| {
            render_live_export_slot_with(
                live_name,
                exports_name,
                target_slot,
                &stable_slot_access(source_object_name, source_slot),
            )
        })
        .collect()
}

pub(crate) fn render_namespace_export_slots_with(
    exports_name: &str,
    export_slots: &[(String, usize)],
) -> String {
    let descriptors = export_slots
        .iter()
        .map(|(export_name, slot)| {
            let key = if super::is_valid_js_identifier(export_name) && export_name != "__cjsExports" {
                export_name.clone()
            } else {
                format!("{export_name:?}")
            };
            format!(
                "{key}:{{configurable:true,enumerable:true,get:function(){{return {exports_name}[{slot}];}}}}"
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("Object.defineProperties({exports_name},{{{descriptors}}});")
}

pub(crate) fn render_static_export_slot(slot: usize, value_expression: &str) -> String {
    render_static_export_slot_with("__exports", slot, value_expression)
}

pub(crate) fn render_static_export_slot_with(
    exports_name: &str,
    slot: usize,
    value_expression: &str,
) -> String {
    format!("{exports_name}[{slot}]={value_expression};")
}
