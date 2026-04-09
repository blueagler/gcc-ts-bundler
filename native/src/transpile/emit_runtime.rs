use super::*;

pub(super) fn emit_bundler_runtime_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    rewrite_bundler_runtime_namespace_usage(&mut module, file_path, context)?;
    let mut output = Vec::new();
    let mut dependency_ids = Vec::new();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;

    if let Some(metadata) = file_metadata {
        for type_decl in &metadata.type_declarations {
            output.push(type_decl.snippet.trim().to_string());
        }
        for enum_decl in &metadata.enum_declarations {
            output.push(render_closure_enum(enum_decl));
            if enum_decl.exported {
                let slot = current_slots.slot_for(&enum_decl.name).ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        enum_decl.name, module_id
                    )
                })?;
                output.push(render_module_export_slot(slot, &enum_decl.name));
            }
        }
    }

    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                let (lines, deps) = convert_bundler_import_decl(
                    file_path,
                    &import_decl,
                    context,
                    &mut import_counter,
                )?;
                output.extend(lines);
                dependency_ids.extend(deps);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(print_statement(Stmt::Decl(export_decl.decl))?);
                for export_name in exported_names {
                    let slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, module_id
                        )
                    })?;
                    output.push(render_module_export_slot(slot, &export_name));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                let (lines, deps) = convert_bundler_named_export(
                    file_path,
                    &named_export,
                    context,
                    current_slots,
                    &mut export_counter,
                )?;
                output.extend(lines);
                dependency_ids.extend(deps);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = format!("__gcc_default_export_{export_counter}");
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                let slot = current_slots.slot_for("default").ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for default in {}",
                        module_id
                    )
                })?;
                output.push(render_module_export_slot(slot, &local_name));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let local_name = function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
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
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for default in {}",
                            module_id
                        )
                    })?;
                    output.push(render_module_export_slot(slot, &local_name));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let local_name = class_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
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
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for default in {}",
                            module_id
                        )
                    })?;
                    output.push(render_module_export_slot(slot, &local_name));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name = format!("__gcc_export_all_{export_counter}");
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                let runtime_export_module_id = to_bundler_runtime_module_id(&export_module_id);
                dependency_ids.push(export_module_id.clone());
                output.push(format!(
                    "const {require_name} = __require({runtime_export_module_id:?});"
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
                    output.push(render_module_export_slot(
                        target_slot,
                        &stable_slot_access(&require_name, source_slot),
                    ));
                }
            }
            ModuleItem::Stmt(statement) => output.push(print_statement(statement)?),
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        let export_slot = current_slots.slot_for(export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                export_name, module_id
            )
        })?;
        output.push(render_module_export_slot(export_slot, export_name));
        let default_slot = current_slots.slot_for("default").ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for default in {}",
                module_id
            )
        })?;
        output.push(render_module_export_slot(default_slot, export_name));
    }

    let dependency_ids = dependency_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let body = rewrite_bundler_exports(
        &output
            .into_iter()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let runtime_dependency_ids = serde_json::to_string(
        &dependency_ids
            .iter()
            .map(|module_id| to_bundler_runtime_module_id(module_id))
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())?;
    let source_text = format!(
        "__register({module_id:?}, {runtime_dependency_ids}, function(__require, __exports, __dynamicImport, __preloadDynamicImport) {{\n{}\n}});",
        indent_block(&body),
        module_id = runtime_module_id,
        runtime_dependency_ids = runtime_dependency_ids,
    );
    Ok(apply_js_compat_text_fixes(source_text))
}

fn indent_block(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_bundler_exports(source: &str) -> String {
    let dot_rewritten = regex::Regex::new(r"\bexports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
        .map(|regex| {
            regex
                .replace_all(source, "__exports[\"$1\"] =")
                .into_owned()
        })
        .unwrap_or_else(|_| source.to_string());
    regex::Regex::new(r#"\bexports\[(["'])(.+?)\1\]\s*="#)
        .map(|regex| {
            regex
                .replace_all(&dot_rewritten, "__exports[\"$2\"] =")
                .into_owned()
        })
        .unwrap_or(dot_rewritten)
}
