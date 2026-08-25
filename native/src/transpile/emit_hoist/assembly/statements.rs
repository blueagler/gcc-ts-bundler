use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::*;

use super::super::super::emit::render_closure_enum;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::{suffixed_name, HoistPlan};
use super::super::super::identity::ModuleIdentity;
use super::super::super::imports_exports::BundlerExportSlotMode;
use super::super::super::nocollapse::NocollapseAssignments;
use super::super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::super::TranspileContext;
use super::super::helpers::print_node;
use super::facade::render_facade;
use super::render::{render_execution_require, render_hoisted_statement};

#[allow(clippy::too_many_arguments)]
pub(crate) fn assemble_hoisted_module_text<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
    module_id: &str,
    ordinal: usize,
    type_metadata: &mut PreparedTypeMetadata,
    import_lines: &[String],
    fresh_names: &mut FreshNameAllocator,
    pure_names: &HashSet<String>,
    module_bindings: &HashSet<String>,
    nocollapse_assignments: &NocollapseAssignments,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let mut output = type_metadata.take_declaration_lines();
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
    }

    // ESM imports are instantiated before every module statement, regardless
    // of their textual position. Keep generated registry requires equivalent.
    output.extend(import_lines.iter().cloned());
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {}
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    output.push(render_hoisted_statement(
                        type_metadata,
                        identity,
                        declaration.into(),
                        pure_names,
                        module_bindings,
                        context,
                        ordinal,
                        nocollapse_assignments,
                    )?);
                } else if let Some(source) = export.source {
                    output.extend(render_execution_require(
                        file_path,
                        source.value.as_str(),
                        context,
                        plan,
                    )?);
                }
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind != ImportOrExportKind::Type {
                    output.extend(render_execution_require(
                        file_path,
                        export.source.value.as_str(),
                        context,
                        plan,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        if function.id.is_some() {
                            output.push(render_hoisted_statement(
                                type_metadata,
                                identity,
                                Statement::FunctionDeclaration(function),
                                pure_names,
                                module_bindings,
                                context,
                                ordinal,
                                nocollapse_assignments,
                            )?);
                        } else {
                            let local_name =
                                fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
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
                            output.push(render_hoisted_statement(
                                type_metadata,
                                identity,
                                Statement::ClassDeclaration(class),
                                pure_names,
                                module_bindings,
                                context,
                                ordinal,
                                nocollapse_assignments,
                            )?);
                        } else {
                            let local_name =
                                fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::ClassDeclaration(class))
                                    .trim()
                                    .trim_end_matches(';')
                            ));
                        }
                    }
                    declaration if declaration.is_typescript_syntax() => {}
                    expression => {
                        let local_name = fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                        output.push(format!(
                            "const {local_name} = {};",
                            print_node(&expression).trim().trim_end_matches(';')
                        ));
                    }
                }
            }
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(render_hoisted_statement(
                type_metadata,
                identity,
                statement,
                pure_names,
                module_bindings,
                context,
                ordinal,
                nocollapse_assignments,
            )?),
        }
    }

    if let Some(facade_slots) = plan.facade_slots_for(module_id) {
        output.extend(render_facade(
            module_id,
            ordinal,
            context,
            plan,
            facade_slots,
            local_export_modes,
            commonjs_export_name,
        )?);
    }

    Ok(output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}
