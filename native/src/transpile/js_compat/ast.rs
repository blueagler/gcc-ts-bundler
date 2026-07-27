use super::*;

pub(crate) fn should_normalize_commonjs(
    file_path: &Path,
    analysis: &crate::commonjs::CommonJsAnalysis,
) -> bool {
    analysis.has_commonjs
        && file_path.to_string_lossy().contains("/node_modules/")
        && !file_path.to_string_lossy().ends_with(".d.ts")
}

pub(crate) fn normalize_commonjs_module(
    module: Module,
    analysis: &crate::commonjs::CommonJsAnalysis,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<String, String> {
    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!("Unsupported CommonJS pattern: {reason}"));
    }

    let require_bindings = analysis
        .dependencies
        .iter()
        .enumerate()
        .map(|(index, specifier)| (specifier.clone(), format!("__cjs_require_{index}")))
        .collect::<HashMap<_, _>>();

    let import_items = analysis
        .dependencies
        .iter()
        .enumerate()
        .flat_map(|(index, specifier)| {
            parse_module_items(&format!(
                "import * as __cjs_import_{index} from {:?}; const __cjs_require_{index} = \"__cjsExports\" in __cjs_import_{index} ? __cjs_import_{index}.__cjsExports : __cjs_import_{index};",
                to_emitted_commonjs_specifier(specifier)
            ))
            .unwrap_or_default()
        })
        .collect::<Vec<_>>();

    let mut program = Program::Module(module);
    program.visit_mut_with(&mut CommonJsRewriteVisitor::new(require_bindings)?);
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };

    let mut normalized_body = Vec::new();
    normalized_body.extend(import_items);
    normalized_body.extend(parse_module_items("var module = { exports: {} };")?);
    normalized_body.extend(wrap_commonjs_body(module.body.drain(..).collect())?);
    normalized_body.extend(parse_module_items("var __cjsExports = module.exports;")?);

    let mut program = Program::Module(Module {
        body: normalized_body,
        shebang: None,
        span: module.span,
    });
    let has_t_declaration = false;
    program.visit_mut_with(&mut JsCompatAstVisitor::new(has_t_declaration));
    apply_file_compat_transforms(&mut program, file_path, context);

    emit_module_program(
        file_path,
        program,
        context,
        file_metadata,
        Some("__cjsExports"),
    )
}

fn wrap_commonjs_body(items: Vec<ModuleItem>) -> std::result::Result<Vec<ModuleItem>, String> {
    let statements = items
        .into_iter()
        .map(|item| match item {
            ModuleItem::Stmt(statement) => Ok(statement),
            ModuleItem::ModuleDecl(_) => {
                Err("CommonJS normalization received ESM syntax.".to_string())
            }
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut wrapper = parse_module_items("(function () {}).call(module.exports);")?;
    let mut injector = CommonJsBodyInjector {
        statements: Some(statements),
    };
    for item in &mut wrapper {
        item.visit_mut_with(&mut injector);
    }
    if injector.statements.is_some() {
        return Err("Unable to create the CommonJS function wrapper.".to_string());
    }
    Ok(wrapper)
}

struct CommonJsBodyInjector {
    statements: Option<Vec<Stmt>>,
}

impl VisitMut for CommonJsBodyInjector {
    fn visit_mut_fn_expr(&mut self, function: &mut swc_core::ecma::ast::FnExpr) {
        let Some(statements) = self.statements.take() else {
            return;
        };
        let Some(body) = &mut function.function.body else {
            self.statements = Some(statements);
            return;
        };
        body.stmts = statements;
    }
}

pub(crate) fn to_emitted_commonjs_specifier(specifier: &str) -> String {
    if specifier.starts_with('.') {
        return specifier.replace(".cjs", ".js").replace(".cts", ".js");
    }

    specifier.to_string()
}

#[cfg(test)]
pub(crate) fn transform_js_pass_through_module(
    module: Module,
    source_text: String,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    GLOBALS.set(&Globals::new(), || {
        let program =
            transform_js_pass_through_program(module, source_text.clone(), file_path, context);
        print_program(&program)
            .map(apply_js_compat_text_fixes)
            .or_else(|_| Ok(apply_js_compat_text_fixes(source_text)))
    })
}

pub(crate) fn transform_js_pass_through_program(
    module: Module,
    source_text: String,
    file_path: &Path,
    context: &TranspileContext,
) -> Program {
    let mut program = Program::Module(module);
    apply_resolver_and_global_this_compat(&mut program, true)
        .expect("resolver and global compat rewrite");
    let has_t_declaration = source_declares_ident(&source_text, "T");
    program.visit_mut_with(&mut JsCompatAstVisitor::new(has_t_declaration));
    apply_file_compat_transforms(&mut program, file_path, context);
    program
}

pub(crate) type ResolverMarks = (Mark, Mark);

pub(crate) fn apply_resolver_and_global_this_compat(
    program: &mut Program,
    run_resolver: bool,
) -> std::result::Result<Option<ResolverMarks>, String> {
    let resolver_marks = if run_resolver {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        resolver(unresolved_mark, top_level_mark, true).process(program);
        Some((unresolved_mark, top_level_mark))
    } else {
        None
    };
    let unresolved_ctxt = unresolved_context_from_marks(resolver_marks.as_ref());
    let compat_property_names = collect_global_this_compat_property_names(program, unresolved_ctxt);
    if !compat_property_names.is_empty() {
        program.visit_mut_with(&mut GlobalThisCompatVisitor::new(
            compat_property_names,
            unresolved_ctxt,
        )?);
    }
    Ok(resolver_marks)
}

fn source_declares_ident(source_text: &str, name: &str) -> bool {
    let pattern = format!(
        r#"(?m)\b(?:var|let|const|function|class|import)\s+{}\b"#,
        regex::escape(name)
    );
    regex::Regex::new(&pattern)
        .map(|regex| regex.is_match(source_text))
        .unwrap_or(false)
}

struct JsCompatAstVisitor {
    has_t_declaration: bool,
}

impl JsCompatAstVisitor {
    fn new(has_t_declaration: bool) -> Self {
        Self { has_t_declaration }
    }
}

impl VisitMut for JsCompatAstVisitor {
    /// Bundler-time `define` replacement leaves dead branches whose callees
    /// were tree-shaken away (`else if (false) warn(...)`). Closure reports
    /// undeclared variables even inside dead code, so literal-condition
    /// branches are folded here.
    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        let Stmt::If(if_stmt) = stmt else {
            return;
        };
        let Some(test_value) = crate::commonjs::evaluate_boolean_expr(&if_stmt.test) else {
            return;
        };
        // `var`/function declarations hoist out of the branch; dropping them
        // would create the very undeclared-variable errors this fold fixes.
        let dropped_branch: Option<&Stmt> = if test_value {
            if_stmt.alt.as_deref()
        } else {
            Some(&if_stmt.cons)
        };
        if dropped_branch.is_some_and(branch_declares_hoisted_bindings) {
            return;
        }
        if test_value {
            let consequent = mem::replace(
                &mut if_stmt.cons,
                Box::new(Stmt::Empty(EmptyStmt {
                    span: Default::default(),
                })),
            );
            *stmt = *consequent;
            return;
        }
        match if_stmt.alt.take() {
            Some(alternative) => *stmt = *alternative,
            None => {
                *stmt = Stmt::Empty(EmptyStmt {
                    span: Default::default(),
                })
            }
        }
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Cond(conditional) = expr {
            if let Some(test_value) = crate::commonjs::evaluate_boolean_expr(&conditional.test) {
                let replacement = if test_value {
                    mem::replace(
                        &mut conditional.cons,
                        Box::new(Expr::Invalid(Default::default())),
                    )
                } else {
                    mem::replace(
                        &mut conditional.alt,
                        Box::new(Expr::Invalid(Default::default())),
                    )
                };
                *expr = *replacement;
                return;
            }
        }

        if let Expr::Bin(binary) = expr {
            if let Some(left_value) = crate::commonjs::evaluate_boolean_expr(&binary.left) {
                match binary.op {
                    swc_core::ecma::ast::BinaryOp::LogicalAnd => {
                        if left_value {
                            let right = mem::replace(
                                &mut binary.right,
                                Box::new(Expr::Invalid(Default::default())),
                            );
                            *expr = *right;
                        } else {
                            let left = mem::replace(
                                &mut binary.left,
                                Box::new(Expr::Invalid(Default::default())),
                            );
                            *expr = *left;
                        }
                        return;
                    }
                    swc_core::ecma::ast::BinaryOp::LogicalOr => {
                        if left_value {
                            let left = mem::replace(
                                &mut binary.left,
                                Box::new(Expr::Invalid(Default::default())),
                            );
                            *expr = *left;
                        } else {
                            let right = mem::replace(
                                &mut binary.right,
                                Box::new(Expr::Invalid(Default::default())),
                            );
                            *expr = *right;
                        }
                        return;
                    }
                    _ => {}
                }
            }
        }

        if self.has_t_declaration {
            return;
        }

        let Expr::Arrow(ArrowExpr { params, body, .. }) = expr else {
            return;
        };
        if !params.is_empty() {
            return;
        }
        let BlockStmtOrExpr::Expr(returned_expr) = &mut **body else {
            return;
        };
        if !matches!(&**returned_expr, Expr::Ident(ident) if ident.sym == "T") {
            return;
        }

        **returned_expr = Expr::Unary(UnaryExpr {
            span: Default::default(),
            op: UnaryOp::Void,
            arg: Box::new(Expr::Lit(Lit::Num(0f64.into()))),
        });
    }
}

fn branch_declares_hoisted_bindings(stmt: &Stmt) -> bool {
    struct HoistedBindingScanner {
        found: bool,
    }
    impl swc_core::ecma::visit::Visit for HoistedBindingScanner {
        fn visit_var_decl(&mut self, var_decl: &VarDecl) {
            if matches!(var_decl.kind, VarDeclKind::Var) {
                self.found = true;
            }
            var_decl.visit_children_with(self);
        }
        fn visit_fn_decl(&mut self, _: &swc_core::ecma::ast::FnDecl) {
            self.found = true;
        }
        // `var` inside nested functions does not hoist past them.
        fn visit_function(&mut self, _: &swc_core::ecma::ast::Function) {}
        fn visit_arrow_expr(&mut self, _: &ArrowExpr) {}
    }
    let mut scanner = HoistedBindingScanner { found: false };
    stmt.visit_with(&mut scanner);
    scanner.found
}

pub(crate) fn parse_module_items(source: &str) -> std::result::Result<Vec<ModuleItem>, String> {
    Ok(parse_module(&PathBuf::from("snippet.js"), source)?.body)
}

fn unresolved_context_from_marks(
    resolver_marks: Option<&ResolverMarks>,
) -> swc_core::common::SyntaxContext {
    resolver_marks
        .map(|(unresolved_mark, _)| {
            swc_core::common::SyntaxContext::empty().apply_mark(*unresolved_mark)
        })
        .unwrap_or_else(swc_core::common::SyntaxContext::empty)
}
