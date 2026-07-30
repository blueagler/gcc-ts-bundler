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
) -> std::result::Result<EmittedProgram, String> {
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
    program.visit_mut_with(&mut CommonJsRewriteVisitor::new(
        require_bindings,
        context.opaque_commonjs.file_is_opaque(file_path),
    )?);
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };

    let mut normalized_body = Vec::new();
    normalized_body.extend(import_items);
    // The scratch `module` object keeps its quoted `exports` slot regardless of
    // the export-name decision. Dotting it types `module` as a bare `{}` and
    // Closure's checkTypes then rejects the assignment
    // (JSC_TYPE_MISMATCH "assignment to property exports"); it also buys
    // nothing, since `module` is file-local and `exports` is one name.
    normalized_body.extend(parse_module_items(
        "var module = {}; module[\"exports\"] = {};",
    )?);
    if uses_top_level_this(&module) {
        normalized_body.extend(wrap_commonjs_body(module.body.drain(..).collect())?);
    } else {
        normalized_body.extend(module.body.drain(..));
    }
    normalized_body.extend(parse_module_items("var __cjsExports = module.exports;")?);

    let mut program = Program::Module(Module {
        body: normalized_body,
        shebang: None,
        span: module.span,
    });
    let has_t_declaration = false;
    apply_resolver_and_global_this_compat(&mut program, true)?;
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

fn uses_top_level_this(module: &Module) -> bool {
    #[derive(Default)]
    struct Finder {
        found: bool,
    }

    impl Visit for Finder {
        fn visit_this_expr(&mut self, _this_expr: &swc_core::ecma::ast::ThisExpr) {
            self.found = true;
        }

        fn visit_function(&mut self, _function: &swc_core::ecma::ast::Function) {}

        fn visit_class(&mut self, _class: &swc_core::ecma::ast::Class) {}
    }

    let mut finder = Finder::default();
    module.visit_with(&mut finder);
    finder.found
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

/// Builds this module's semantic model and runs the compat passes that depend on
/// it.
///
/// Returns the model rather than raw marks: under oxc the model is the `Scoping`
/// from `SemanticBuilder` and the marks do not exist, so callers thread
/// `ModuleIdentity` and ask it for what they need.
pub(crate) fn apply_resolver_and_global_this_compat(
    program: &mut Program,
    run_resolver: bool,
) -> std::result::Result<ModuleIdentity, String> {
    let resolver_marks = if run_resolver {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        resolver(unresolved_mark, top_level_mark, true).process(program);
        Some((unresolved_mark, top_level_mark))
    } else {
        None
    };
    let module_identity = ModuleIdentity::from_resolver_marks(resolver_marks);
    let global_scope = module_identity.global_scope();

    let compat_property_names = collect_global_this_compat_property_names(program, global_scope);
    if !compat_property_names.is_empty() {
        program.visit_mut_with(&mut GlobalThisCompatVisitor::new(
            compat_property_names,
            global_scope,
        )?);
    }
    program.visit_mut_with(&mut ProcessEnvNodeEnvVisitor { global_scope });
    Ok(module_identity)
}

struct ProcessEnvNodeEnvVisitor {
    global_scope: GlobalScope,
}

impl VisitMut for ProcessEnvNodeEnvVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);
        if !is_unresolved_process_env_node_env(expr, self.global_scope) {
            return;
        }
        *expr = Expr::Lit(Lit::Str(Str {
            span: Default::default(),
            value: "production".into(),
            raw: None,
        }));
    }
}

fn is_unresolved_process_env_node_env(expr: &Expr, global_scope: GlobalScope) -> bool {
    let Expr::Member(node_env) = expr else {
        return false;
    };
    if !matches!(&node_env.prop, MemberProp::Ident(prop) if prop.sym == *"NODE_ENV") {
        return false;
    }
    let Expr::Member(env) = &*node_env.obj else {
        return false;
    };
    if !matches!(&env.prop, MemberProp::Ident(prop) if prop.sym == *"env") {
        return false;
    }
    matches!(&*env.obj, Expr::Ident(process) if process.sym == *"process" && global_scope.contains(process))
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

pub(crate) struct DirectoryModuleSpecifierVisitor;

impl VisitMut for DirectoryModuleSpecifierVisitor {
    fn visit_mut_module_decl(&mut self, declaration: &mut swc_core::ecma::ast::ModuleDecl) {
        match declaration {
            swc_core::ecma::ast::ModuleDecl::Import(import) => {
                rewrite_directory_specifier(&mut import.src)
            }
            swc_core::ecma::ast::ModuleDecl::ExportNamed(export) => {
                if let Some(src) = &mut export.src {
                    rewrite_directory_specifier(src);
                }
            }
            swc_core::ecma::ast::ModuleDecl::ExportAll(export) => {
                rewrite_directory_specifier(&mut export.src)
            }
            _ => {}
        }
        declaration.visit_mut_children_with(self);
    }

    fn visit_mut_call_expr(&mut self, call: &mut CallExpr) {
        call.visit_mut_children_with(self);
        if !matches!(call.callee, Callee::Import(_)) || call.args.len() != 1 {
            return;
        }
        if let Expr::Lit(Lit::Str(specifier)) = call.args[0].expr.as_mut() {
            rewrite_directory_specifier(specifier);
        }
    }
}

fn rewrite_directory_specifier(specifier: &mut Str) {
    let replacement = match specifier.value.to_string_lossy().as_ref() {
        "." => "./index.js",
        ".." => "../index.js",
        _ => return,
    };
    specifier.value = replacement.into();
    specifier.raw = None;
}

pub(crate) fn parse_module_items(source: &str) -> std::result::Result<Vec<ModuleItem>, String> {
    Ok(parse_module(&PathBuf::from("snippet.js"), source)?.body)
}
