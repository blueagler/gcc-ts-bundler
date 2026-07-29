use super::*;

/// `export = x` has no ES module spelling, so SWC's TypeScript strip lowers it
/// to `module.exports = x`. Every output shape this bundler emits is a
/// `goog.module`, where `module` is not bound, so the lowering produced a
/// reference to an undeclared global and Closure rejected the file
/// (`JSC_UNDEFINED_VARIABLE: module`) — for *any* source using `export =`.
///
/// `export = x` means "this module's single export is x", which is exactly
/// `export default x` in the module system we emit into; the CommonJS interop
/// that consumers go through already maps a default export onto
/// `module.exports`.
fn rewrite_ts_export_assignment(mut module: Module) -> Module {
    for item in &mut module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::TsExportAssignment(assignment)) =
            item
        else {
            continue;
        };
        let expr = assignment.expr.clone();
        let span = assignment.span;
        *item = ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
            swc_core::ecma::ast::ExportDefaultExpr { span, expr },
        ));
    }
    module
}

pub(super) fn transform_program(
    module: swc_core::ecma::ast::Module,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<Program, String> {
    let safe_enums = file_metadata
        .map(|metadata| {
            metadata
                .enums
                .iter()
                .map(|enum_decl| enum_decl.binding_name.clone())
                .chain(metadata.erased_const_enums.iter().cloned())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let erased_const_enums = file_metadata
        .map(|metadata| {
            metadata
                .erased_const_enums
                .iter()
                .cloned()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    // An erased const enum has no replacement object, so the inliner is the
    // only thing that can resolve its members — and it has to read them before
    // the declaration is dropped. A `@enum`-backed enum is deliberately not
    // collected here: its reads resolve against the emitted object instead.
    let erased_enum_values = if erased_const_enums.is_empty() {
        HashMap::new()
    } else {
        collect_ts_enum_literal_values(&module)
            .into_iter()
            .filter(|(name, _)| erased_const_enums.contains(name))
            .collect()
    };
    let module = rewrite_ts_export_assignment(module);
    let module = remove_closure_safe_enums(module, &safe_enums);
    let mut enum_literal_values = collect_ts_enum_literal_values(&module);
    enum_literal_values.extend(collect_imported_ts_enum_literal_values(&module, file_path));
    enum_literal_values.extend(erased_enum_values);
    let mut program = Program::Module(module);
    let cm: Lrc<SourceMap> = Default::default();
    let resolver_marks =
        apply_resolver_and_global_this_compat(&mut program, should_run_resolver(file_path))?;
    if let Some((unresolved_mark, top_level_mark)) = resolver_marks {
        if should_run_react_transform(file_path) {
            jsx(
                cm,
                None::<swc_core::common::comments::SingleThreadedComments>,
                ReactOptions {
                    runtime: Some(ReactRuntime::Classic),
                    development: Some(false),
                    ..Default::default()
                },
                top_level_mark,
                unresolved_mark,
            )
            .process(&mut program);
        }
        strip(unresolved_mark, top_level_mark).process(&mut program);
        // `strip` lowers TS namespaces into an IIFE the printer then emits
        // without the parentheses it requires; see `precedence`.
        crate::transpile::precedence::normalize_expression_parens(&mut program);
    }
    if !enum_literal_values.is_empty() {
        program.visit_mut_with(&mut EnumValueInlineVisitor::new(enum_literal_values));
    }
    apply_file_compat_transforms(&mut program, file_path, context);
    Ok(program)
}

fn remove_closure_safe_enums(module: Module, safe_enums: &HashSet<String>) -> Module {
    if safe_enums.is_empty() {
        return module;
    }

    Module {
        body: module
            .body
            .into_iter()
            .filter(|item| match item {
                ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsEnum(enum_decl))) => {
                    !safe_enums.contains(enum_decl.id.sym.as_ref())
                }
                ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(
                    export_decl,
                )) => match &export_decl.decl {
                    swc_core::ecma::ast::Decl::TsEnum(enum_decl) => {
                        !safe_enums.contains(enum_decl.id.sym.as_ref())
                    }
                    _ => true,
                },
                _ => true,
            })
            .collect(),
        ..module
    }
}

pub(super) fn print_program(program: &Program) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default(),
            cm,
            comments: None,
            wr: writer,
        };
        emitter
            .emit_program(program)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

pub(super) fn print_module_item(item: ModuleItem) -> std::result::Result<String, String> {
    print_program(&Program::Module(Module {
        body: vec![item],
        shebang: None,
        span: Default::default(),
    }))
}

pub(super) fn print_statement(statement: Stmt) -> std::result::Result<String, String> {
    print_module_item(ModuleItem::Stmt(statement))
}

pub(super) fn print_expression(expression: Expr) -> std::result::Result<String, String> {
    let printed = print_statement(Stmt::Expr(ExprStmt {
        expr: Box::new(expression),
        span: Default::default(),
    }))?;
    Ok(printed.trim().trim_end_matches(';').to_string())
}

#[cfg(test)]
pub(crate) fn print_program_for_test(program: &Program) -> std::result::Result<String, String> {
    print_program(program)
}

#[cfg(test)]
pub(crate) fn print_module_item_for_test(item: ModuleItem) -> std::result::Result<String, String> {
    print_module_item(item)
}
