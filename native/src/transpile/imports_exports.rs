use super::*;

mod bindings;
mod resolve;

pub(super) use self::bindings::{
    apply_import_binding_rewrites, exported_decl_names, live_export_accessor_name, member_access,
    module_export_name_to_string, render_live_export_slot, render_live_export_slot_with,
    render_namespace_export_slots_with, render_packed_live_export_slots_with,
    render_static_export_slot, render_static_export_slot_with, stable_slot_access,
    BundlerExportSlotMode,
};
use self::bindings::{
    bind_import_specifiers, collect_named_export_bindings, collect_namespace_export_bindings,
    plan_bundler_import_specifiers, reject_namespace_export_specifiers,
};
pub(super) use self::bindings::{ImportBindingRewrite, ImportBindingSlotAlias};
pub(super) use self::resolve::{resolve_module_id_for_specifier, resolved_import_key};

pub(super) struct BundlerImportPlan {
    pub(super) lines: Vec<String>,
    pub(super) binding_rewrites: Vec<ImportBindingRewrite>,
}

pub(super) fn convert_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    // Locals that alias another module's live export accessor; see
    // `emit_goog`'s live-export section.
    live_imported_ids: &HashSet<Id>,
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
        let local_name = fresh_names.fresh(&format!("__goog_import_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!("const {local_name} = goog.require({module_id:?});"));
        lines.extend(bind_import_specifiers(
            &local_name,
            &value_specifiers,
            live_imported_ids,
        ));
    }
    if !type_specifiers.is_empty() {
        let local_name = fresh_names.fresh(&format!("__goog_type_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = goog.requireType({module_id:?});"
        ));
        lines.extend(bind_import_specifiers(
            &local_name,
            &type_specifiers,
            &HashSet::new(),
        ));
    }

    Ok(lines)
}

pub(super) fn convert_bundler_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    require_name: &str,
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
        lines.push(format!("{require_name}({runtime_module_id:?});"));
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
        let local_name = fresh_names.fresh(&format!("__gcc_import_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = {require_name}({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        let (specifier_lines, specifier_rewrites) =
            plan_bundler_import_specifiers(&local_name, &value_specifiers, target_slots)?;
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
    fresh_names: &mut FreshNameAllocator,
    // Local names that now hold another module's live export accessor rather
    // than its value, so re-exporting one has to call it.
    live_imported_locals: &HashSet<String>,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(src) = &named_export.src {
        let require_name = fresh_names.fresh(&format!("__goog_export_{}", *export_counter));
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
        // `export * as ns from "./m"`: the required module object *is* the
        // exported value. Without this the `goog.require` above was emitted
        // with nothing consuming it and the export silently disappeared.
        for binding in collect_namespace_export_bindings(named_export) {
            lines.push(format!(
                "exports.{} = {};",
                binding.export_name, require_name
            ));
        }
        return Ok(lines);
    }

    for binding in collect_named_export_bindings(named_export) {
        // Re-exporting a live import: the local is the accessor, so the value
        // has to be read out of it. This export is still a snapshot -- it is a
        // value property, which is what a namespace consumer reads.
        let value = if live_imported_locals.contains(&binding.local_name) {
            format!("{}()", binding.local_name)
        } else {
            binding.local_name.clone()
        };
        lines.push(format!("exports.{} = {value};", binding.export_name));
    }
    Ok(lines)
}

// Threads the whole export-lowering context through one call; splitting it
// into a struct would only move the same eight values behind a name.
#[allow(clippy::too_many_arguments)]
pub(super) fn convert_bundler_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    import_binding_rewrites: &HashMap<String, String>,
    import_binding_slot_aliases: &HashMap<String, ImportBindingSlotAlias>,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    runtime_require_name: &str,
    runtime_exports_name: &str,
    runtime_live_name: &str,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    reject_namespace_export_specifiers(named_export, file_path)?;
    if let Some(src) = &named_export.src {
        let require_name = fresh_names.fresh(&format!("__gcc_export_{}", *export_counter));
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        let runtime_module_id = to_bundler_runtime_module_id(&module_id);
        lines.push(format!(
            "const {require_name} = {runtime_require_name}({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        let mut packed_slot_pairs = Vec::new();
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
            packed_slot_pairs.push((target_slot, source_slot));
        }
        lines.extend(render_grouped_live_slot_exports_with(
            &require_name,
            packed_slot_pairs,
            runtime_live_name,
            runtime_exports_name,
        ));
        return Ok(lines);
    }

    let mut grouped_alias_exports = BTreeMap::<String, Vec<(usize, usize)>>::new();
    for binding in collect_named_export_bindings(named_export) {
        let target_slot = current_slots
            .slot_for(&binding.export_name)
            .ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {}",
                    binding.export_name
                )
            })?;
        let slot_mode = local_export_modes
            .get(&binding.local_name)
            .copied()
            .unwrap_or(BundlerExportSlotMode::Live);
        if slot_mode == BundlerExportSlotMode::Live {
            if let Some(alias) = import_binding_slot_aliases.get(&binding.local_name) {
                grouped_alias_exports
                    .entry(alias.source_object_name.clone())
                    .or_default()
                    .push((target_slot, alias.source_slot));
                continue;
            }
        }
        let value_expression = import_binding_rewrites
            .get(&binding.local_name)
            .map(String::as_str)
            .unwrap_or(binding.local_name.as_str());
        match slot_mode {
            BundlerExportSlotMode::Static => lines.push(render_static_export_slot_with(
                runtime_exports_name,
                target_slot,
                value_expression,
            )),
            BundlerExportSlotMode::Live => lines.push(render_live_export_slot_with(
                runtime_live_name,
                runtime_exports_name,
                target_slot,
                value_expression,
            )),
        }
    }
    for (source_object_name, slot_pairs) in grouped_alias_exports {
        lines.extend(render_grouped_live_slot_exports_with(
            &source_object_name,
            slot_pairs,
            runtime_live_name,
            runtime_exports_name,
        ));
    }
    Ok(lines)
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
