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
    normalized_body.extend(module.body.drain(..));
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

fn to_emitted_commonjs_specifier(specifier: &str) -> String {
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
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Cond(conditional) = expr {
            if let Expr::Lit(Lit::Bool(Bool { value, .. })) = &*conditional.test {
                let replacement = if *value {
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

        *returned_expr = Box::new(Expr::Unary(UnaryExpr {
            span: Default::default(),
            op: UnaryOp::Void,
            arg: Box::new(Expr::Lit(Lit::Num(0f64.into()))),
        }));
    }
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
