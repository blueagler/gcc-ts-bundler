use super::*;

pub(super) fn emit_goog_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let Program::Module(module) = program else {
        return Err("Expected module program".to_string());
    };
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];

    if let Some(metadata) = file_metadata {
        for type_decl in &metadata.type_declarations {
            output.push(type_decl.snippet.trim().to_string());
        }
        for enum_decl in &metadata.enum_declarations {
            output.push(render_closure_enum(enum_decl));
            if enum_decl.exported {
                output.push(format!("exports.{} = {};", enum_decl.name, enum_decl.name));
            }
        }
    }

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
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(print_statement(Stmt::Decl(export_decl.decl))?);
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
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = format!("__goog_default_export_{export_counter}");
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
                    let local_name = function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__goog_default_export_{export_counter}"));
                    export_counter += 1;
                    if function_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                            swc_core::ecma::ast::FnDecl {
                                declare: false,
                                function: function_expr.function,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            },
                        )))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                    output.push(format!("exports.default = {local_name};"));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let local_name = class_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__goog_default_export_{export_counter}"));
                    export_counter += 1;
                    if class_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(
                            swc_core::ecma::ast::Decl::Class(swc_core::ecma::ast::ClassDecl {
                                class: class_expr.class,
                                declare: false,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            }),
                        ))?);
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
                let require_name = format!("__goog_export_all_{export_counter}");
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
            ModuleItem::Stmt(statement) => {
                output.push(print_statement(statement)?);
            }
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }

    let mut source_text = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(metadata) = file_metadata {
        source_text = attach_top_level_docs(source_text, &metadata.top_level_docs);
    }
    Ok(apply_js_compat_text_fixes(source_text))
}
