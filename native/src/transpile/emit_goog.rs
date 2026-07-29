use super::*;
use crate::transpile::pure_calls::{
    collect_pure_annotated_binding_names, pure_annotation_for_statement,
};

pub(super) fn emit_goog_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let Program::Module(module) = program else {
        return Err("Expected module program".to_string());
    };
    let bound = BoundTypeMetadata::bind(&module, file_metadata, context.type_metadata_enabled);
    let runtime_type_names = runtime_type_names_from_module(&module, &bound);
    let mut fresh_names = FreshNameAllocator::from_module(&module);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for enum_decl in enum_declarations {
        let emitted_name = type_metadata.enum_name(&enum_decl).to_string();
        output.push(render_closure_enum(&enum_decl, &emitted_name));
        type_metadata.count_enum();
        if enum_decl.exported {
            output.push(format!(
                "exports.{} = {};",
                enum_decl.binding_name, emitted_name
            ));
        }
    }

    let pure_names = std::fs::read_to_string(file_path)
        .map(|source| collect_pure_annotated_binding_names(&source))
        .unwrap_or_default();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                output.extend(convert_import_decl(
                    file_path,
                    &import_decl,
                    context,
                    &mut import_counter,
                    &mut fresh_names,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(render_statement(
                    &mut type_metadata,
                    Stmt::Decl(export_decl.decl),
                    &pure_names,
                    context,
                )?);
                for export_name in exported_names {
                    output.push(format!("exports.{export_name} = {export_name};"));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                output.extend(convert_named_export(
                    file_path,
                    &named_export,
                    context,
                    &mut export_counter,
                    &mut fresh_names,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name =
                    fresh_names.fresh(&format!("__goog_default_export_{export_counter}"));
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                output.push(format!("exports.default = {local_name};"));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let original_ident = function_expr.ident.clone();
                    let local_name = original_ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| {
                            fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                                swc_core::ecma::ast::FnDecl {
                                    declare: false,
                                    function: function_expr.function,
                                    ident,
                                },
                            )),
                            &pure_names,
                            context,
                        )?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                    output.push(format!("exports.default = {local_name};"));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let original_ident = class_expr.ident.clone();
                    let local_name = original_ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| {
                            fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Class(
                                swc_core::ecma::ast::ClassDecl {
                                    class: class_expr.class,
                                    declare: false,
                                    ident,
                                },
                            )),
                            &pure_names,
                            context,
                        )?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Class(class_expr))?
                        ));
                    }
                    output.push(format!("exports.default = {local_name};"));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name =
                    fresh_names.fresh(&format!("__goog_export_all_{export_counter}"));
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                output.push(format!(
                    "const {require_name} = goog.require({export_module_id:?});"
                ));
                output.push(format!(
                    "for (const key in {require_name}) {{ if (key !== \"default\") {{ exports[key] = {require_name}[key]; }} }}"
                ));
            }
            ModuleItem::Stmt(statement) => output.push(render_statement(
                &mut type_metadata,
                statement,
                &pure_names,
                context,
            )?),
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }

    let source_text = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(source_text),
        reflective_property_names: Default::default(),
        shared_helpers: Vec::new(),
        type_metadata: type_metadata.finish(),
    })
}

fn render_statement(
    type_metadata: &mut PreparedTypeMetadata,
    statement: Stmt,
    pure_names: &HashSet<String>,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    let tags =
        if pure_annotation_for_statement(&statement, pure_names, &context.pure_callees, |_| None)
            .is_empty()
        {
            Vec::new()
        } else {
            vec![PURE_TAG]
        };
    type_metadata.render_statement(statement, &tags)
}
