use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::{ExportDefaultDeclarationKind, ImportOrExportKind, Program, Statement};

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
use super::render::{render_execution_require, render_hoisted_statement, StatementRenderOptions};

pub(crate) struct HoistedAssemblyOptions<'a> {
    pub(crate) file_path: &'a Path,
    pub(crate) context: &'a TranspileContext,
    pub(crate) plan: &'a HoistPlan,
    pub(crate) module_id: &'a str,
    pub(crate) ordinal: usize,
    pub(crate) import_lines: &'a [String],
    pub(crate) pure_names: &'a HashSet<String>,
    pub(crate) module_bindings: &'a HashSet<String>,
    pub(crate) nocollapse_assignments: &'a NocollapseAssignments,
    pub(crate) local_export_modes: &'a HashMap<String, BundlerExportSlotMode>,
    pub(crate) commonjs_export_name: Option<&'a str>,
}

pub(crate) fn assemble_hoisted_module_text<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    type_metadata: &mut PreparedTypeMetadata<'_>,
    fresh_names: &mut FreshNameAllocator,
    options: HoistedAssemblyOptions<'_>,
) -> std::result::Result<String, String> {
    let HoistedAssemblyOptions {
        file_path,
        context,
        plan,
        module_id,
        ordinal,
        import_lines,
        pure_names,
        module_bindings,
        nocollapse_assignments,
        local_export_modes,
        commonjs_export_name,
    } = options;
    let render_options = StatementRenderOptions {
        pure_names,
        module_bindings,
        context,
        ordinal,
        nocollapse_assignments,
    };
    let mut output = type_metadata.take_declaration_lines();
    let enum_declarations = type_metadata.enum_declarations();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(declaration);
        output.push(render_closure_enum(declaration, &emitted_name));
    }
    type_metadata.count_enums(enum_declarations.len());

    // ESM imports are instantiated before every module statement, regardless
    // of their textual position. Keep generated registry requires equivalent.
    output.extend(import_lines.iter().cloned());
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {}
            Statement::ExportDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind() == ImportOrExportKind::Type {
                    continue;
                }
                output.push(render_hoisted_statement(
                    type_metadata,
                    identity,
                    export.declaration.into(),
                    &render_options,
                )?);
            }
            Statement::ExportNamedDeclaration(_) => {}
            Statement::ExportFromDeclaration(export) => {
                if export.export_kind != ImportOrExportKind::Type {
                    output.extend(render_execution_require(
                        file_path,
                        export.source.value.as_str(),
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
                                &render_options,
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
                                &render_options,
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
                &render_options,
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
