use std::collections::HashMap;
use std::path::Path;

use oxc_ast::ast::*;

use super::super::fresh::FreshNameAllocator;
use super::super::identity::ModuleIdentity;
use super::super::imports_exports::{BundlerExportSlotMode, ImportBindingSlotAlias};
use super::super::nocollapse::NocollapseAssignments;
use super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::{
    render_static_export_slot_with, resolve_module_id_for_specifier, to_bundler_runtime_module_id,
    BundlerModuleSlots, TranspileContext,
};
use super::exports::{
    convert_bundler_named_export, default_declaration_name, exported_decl_names,
    module_export_name, print_node, render_namespace_reexport_object, render_slot_export,
    slot_mode_for_export_decl, RuntimeBindingNames,
};

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_runtime_statements<'a>(
    body: oxc_allocator::Vec<'a, Statement<'a>>,
    file_path: &Path,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    module_id: &str,
    current_slots: &BundlerModuleSlots,
    runtime_names: &RuntimeBindingNames,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    import_binding_rewrites: &HashMap<String, String>,
    import_binding_slot_aliases: &HashMap<String, ImportBindingSlotAlias>,
    nocollapse_assignments: &NocollapseAssignments,
    type_metadata: &mut PreparedTypeMetadata,
    fresh_names: &mut FreshNameAllocator,
    export_counter: &mut usize,
    import_plan_lines: &mut impl Iterator<Item = Vec<String>>,
    output: &mut Vec<String>,
) -> std::result::Result<(), String> {
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {
                let lines = import_plan_lines
                    .next()
                    .ok_or_else(|| "Missing bundler-runtime import plan".to_string())?;
                output.extend(lines);
            }
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    let exported_names = exported_decl_names(&declaration, identity);
                    let slot_mode =
                        slot_mode_for_export_decl(&declaration, identity, local_export_modes);
                    output.push(type_metadata.render_statement_with_nocollapse(
                        identity,
                        declaration.into(),
                        &[],
                        Some(nocollapse_assignments),
                    )?);
                    for export_name in exported_names {
                        let slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                            format!(
                                "Missing bundler-runtime export slot for {} in {}",
                                export_name, module_id
                            )
                        })?;
                        output.push(render_slot_export(
                            runtime_names,
                            slot_mode,
                            slot,
                            &export_name,
                        ));
                    }
                } else {
                    output.extend(convert_bundler_named_export(
                        file_path,
                        &export,
                        context,
                        current_slots,
                        import_binding_rewrites,
                        import_binding_slot_aliases,
                        local_export_modes,
                        export_counter,
                        fresh_names,
                        &runtime_names.require,
                        &runtime_names.exports,
                        &runtime_names.live,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        fresh_names.fresh(&format!("__gcc_default_export_{export_counter}"))
                    });
                *export_counter += 1;
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        if function.id.is_some() {
                            output.push(type_metadata.render_statement_with_nocollapse(
                                identity,
                                Statement::FunctionDeclaration(function),
                                &[],
                                Some(nocollapse_assignments),
                            )?);
                        } else {
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::FunctionDeclaration(
                                    function
                                ))
                                .trim()
                                .trim_end_matches(';')
                            ));
                        }
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        if class.id.is_some() {
                            output.push(type_metadata.render_statement_with_nocollapse(
                                identity,
                                Statement::ClassDeclaration(class),
                                &[],
                                Some(nocollapse_assignments),
                            )?);
                        } else {
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::ClassDeclaration(class))
                                    .trim()
                                    .trim_end_matches(';')
                            ));
                        }
                    }
                    expression => output.push(format!(
                        "const {local_name} = {};",
                        print_node(&expression).trim().trim_end_matches(';')
                    )),
                }
                let slot = current_slots.slot_for("default").ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for default in {}",
                        module_id
                    )
                })?;
                output.push(render_static_export_slot_with(
                    &runtime_names.exports,
                    slot,
                    &local_name,
                ));
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                let require_name = fresh_names.fresh(&format!("__gcc_export_all_{export_counter}"));
                *export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    export.source.value.as_str(),
                    context,
                )?;
                let runtime_export_module_id = to_bundler_runtime_module_id(&export_module_id);
                output.push(format!(
                    "const {require_name} = {}({runtime_export_module_id:?});",
                    runtime_names.require
                ));
                let target_slots = context
                    .bundler_module_slots
                    .get(&export_module_id)
                    .ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slots for re-exported module {}",
                            export_module_id
                        )
                    })?;
                if let Some(exported) = &export.exported {
                    let exported_name = module_export_name(exported);
                    let namespace_slot =
                        current_slots.slot_for(&exported_name).ok_or_else(|| {
                            format!(
                                "Missing bundler-runtime export slot for {} in {}",
                                exported_name, module_id
                            )
                        })?;
                    output.push(render_static_export_slot_with(
                        &runtime_names.exports,
                        namespace_slot,
                        &render_namespace_reexport_object(
                            &require_name,
                            target_slots,
                            &export_module_id,
                        )?,
                    ));
                } else {
                    let mut slot_pairs = Vec::new();
                    for export_name in target_slots.export_names() {
                        if export_name == "default" {
                            continue;
                        }
                        let source_slot = target_slots.slot_for(export_name).ok_or_else(|| {
                            format!(
                                "Missing bundler-runtime export slot for {} in {}",
                                export_name, export_module_id
                            )
                        })?;
                        let target_slot = current_slots.slot_for(export_name).ok_or_else(|| {
                            format!(
                                "Missing bundler-runtime export slot for {} in {}",
                                export_name, module_id
                            )
                        })?;
                        slot_pairs.push((target_slot, source_slot));
                    }
                    output.extend(
                        super::super::imports_exports::render_grouped_live_slot_exports_with(
                            &require_name,
                            slot_pairs,
                            &runtime_names.live,
                            &runtime_names.exports,
                        ),
                    );
                }
            }
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(type_metadata.render_statement_with_nocollapse(
                identity,
                statement,
                &[],
                Some(nocollapse_assignments),
            )?),
        }
    }
    Ok(())
}
