use super::*;

pub(super) fn transform_program(
    module: swc_core::ecma::ast::Module,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<Program, String> {
    let safe_enums = file_metadata
        .map(|metadata| {
            metadata
                .enum_declarations
                .iter()
                .map(|enum_decl| enum_decl.name.clone())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let module = remove_closure_safe_enums(module, &safe_enums);
    let mut enum_literal_values = collect_ts_enum_literal_values(&module);
    enum_literal_values.extend(collect_imported_ts_enum_literal_values(&module, file_path));
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
