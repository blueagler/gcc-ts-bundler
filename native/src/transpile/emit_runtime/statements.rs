use oxc_ast::ast::{ExportDefaultDeclarationKind, ImportOrExportKind, Statement};
use std::collections::HashMap;

use super::super::fresh::FreshNameAllocator;
use super::super::identity::ModuleIdentity;
use super::super::imports_exports::{BundlerExportSlotMode, ImportBindingSlotAlias};
use super::super::nocollapse::NocollapseAssignments;
use super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::{
    render_static_export_slot_with, resolve_module_id_for_specifier, to_bundler_runtime_module_id,
};
use super::exports::{
    convert_bundler_export_from, convert_bundler_named_export, default_declaration_name,
    exported_decl_names, module_export_name, print_node, render_slot_export,
    slot_mode_for_export_decl, RuntimeExportInput,
};

pub(super) struct RuntimeStatementInput<'i> {
    pub(super) exports: RuntimeExportInput<'i>,
    pub(super) identity: &'i ModuleIdentity,
    pub(super) module_id: &'i str,
    pub(super) local_export_modes: &'i HashMap<String, BundlerExportSlotMode>,
    pub(super) import_binding_slot_aliases: &'i HashMap<String, ImportBindingSlotAlias>,
    pub(super) nocollapse_assignments: &'i NocollapseAssignments,
}

pub(super) fn emit_runtime_statements<'a>(
    body: oxc_allocator::Vec<'a, Statement<'a>>,
    input: &RuntimeStatementInput<'_>,
    type_metadata: &mut PreparedTypeMetadata<'_>,
    fresh_names: &mut FreshNameAllocator,
    import_plan_lines: &mut impl Iterator<Item = Vec<String>>,
    output: &mut Vec<String>,
) -> std::result::Result<(), String> {
    let RuntimeStatementInput {
        ref exports,
        identity,
        module_id,
        local_export_modes,
        import_binding_slot_aliases,
        nocollapse_assignments,
    } = *input;
    let RuntimeExportInput {
        file_path,
        context,
        current_slots,
        names: runtime_names,
    } = *exports;
    let mut export_counter = 0usize;
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {
                let lines = import_plan_lines
                    .next()
                    .ok_or_else(|| "Missing bundler-runtime import plan".to_string())?;
                output.extend(lines);
            }
            Statement::ExportDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind() == ImportOrExportKind::Type {
                    continue;
                }
                let declaration = export.declaration;
                let exported_names = exported_decl_names(&declaration)?;
                let slot_mode = slot_mode_for_export_decl(&declaration, local_export_modes)?;
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
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                output.extend(convert_bundler_named_export(
                    &export,
                    current_slots,
                    import_binding_slot_aliases,
                    local_export_modes,
                    runtime_names,
                )?);
            }
            Statement::ExportFromDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                output.extend(convert_bundler_export_from(
                    &export,
                    exports,
                    &mut export_counter,
                    fresh_names,
                )?);
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration).map_or_else(
                    || fresh_names.fresh(&format!("__gcc_default_export_{export_counter}")),
                    str::to_string,
                );
                export_counter += 1;
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
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    export.source.value.as_str(),
                    context,
                )?;
                let runtime_export_module_id = to_bundler_runtime_module_id(&export_module_id);
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
                        &format!(
                            "{}({runtime_export_module_id:?},true)",
                            runtime_names.require
                        ),
                    ));
                } else {
                    output.push(format!(
                        "const {require_name} = {}({runtime_export_module_id:?});",
                        runtime_names.require
                    ));
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
