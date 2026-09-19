use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Expression, ForOfStatement, ImportExpression, ImportOrExportKind, Program, Statement,
    TemplateLiteral, VariableDeclaration, VariableDeclarationKind,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::SourceType;
use oxc_syntax::scope::ScopeFlags;
use std::path::Path;

/// Parses one source file for the import scan.
///
/// This is the graph lane's own parse. It deliberately does not go through the
/// transpile pipeline's module cache: the scanner only reads specifiers, so it
/// has no reason to share an AST - or an AST library - with the emitter.
pub(super) fn parse_scanned_module<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    source: &'a str,
) -> std::result::Result<Program<'a>, String> {
    // Preserve the extension rejection and complete diagnostic sequence of the
    // CommonJS parse that previously preceded this scan. Both analyses consume
    // this same module-mode program.
    let source_type = SourceType::from_path(file_path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    let parsed = oxc_parser::Parser::new(allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(parsed.program)
}

/// Static import edges, in source order. Type-only forms carry no runtime
/// dependency and are skipped.
pub(super) fn has_top_level_await(program: &Program<'_>) -> bool {
    struct TopLevelAwaitVisitor {
        found: bool,
    }

    // Oxc represents await-bearing module syntax in three places: ordinary
    // AwaitExpression nodes, ForOfStatement's await flag, and AwaitUsing
    // declarations. Keep all three here while function visitors remain sealed.
    impl<'a> Visit<'a> for TopLevelAwaitVisitor {
        fn visit_await_expression(&mut self, _expression: &oxc_ast::ast::AwaitExpression<'a>) {
            self.found = true;
        }

        fn visit_for_of_statement(&mut self, statement: &ForOfStatement<'a>) {
            self.found |= statement.r#await;
            walk::walk_for_of_statement(self, statement);
        }

        fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
            self.found |= declaration.kind == VariableDeclarationKind::AwaitUsing;
            walk::walk_variable_declaration(self, declaration);
        }

        fn visit_function(&mut self, _function: &oxc_ast::ast::Function<'a>, _flags: ScopeFlags) {}

        fn visit_arrow_function_expression(
            &mut self,
            _function: &oxc_ast::ast::ArrowFunctionExpression<'a>,
        ) {
        }
    }

    let mut visitor = TopLevelAwaitVisitor { found: false };
    visitor.visit_program(program);
    visitor.found
}

pub(super) fn collect_export_source_specifiers(program: &Program<'_>) -> Vec<String> {
    program
        .body
        .iter()
        .filter_map(|statement| match statement {
            Statement::ExportFromDeclaration(export)
                if export.export_kind == ImportOrExportKind::Value =>
            {
                Some(export.source.value.to_string())
            }
            Statement::ExportAllDeclaration(export)
                if export.export_kind == ImportOrExportKind::Value =>
            {
                Some(export.source.value.to_string())
            }
            _ => None,
        })
        .collect()
}

pub(super) fn extract_dependencies(program: &Program<'_>) -> Vec<String> {
    let mut dependencies = Vec::new();

    for item in &program.body {
        match item {
            Statement::ImportDeclaration(import_decl) => {
                if import_decl.import_kind == ImportOrExportKind::Value {
                    dependencies.push(import_decl.source.value.to_string());
                }
            }
            Statement::ExportFromDeclaration(export)
                if export.export_kind == ImportOrExportKind::Value =>
            {
                dependencies.push(export.source.value.to_string());
            }
            Statement::ExportAllDeclaration(export_all)
                if export_all.export_kind == ImportOrExportKind::Value =>
            {
                dependencies.push(export_all.source.value.to_string());
            }
            _ => {}
        }
    }

    dependencies
}

/// Dynamic `import()` edges anywhere in the file.
///
/// Fails closed: a dynamic import whose specifier is not a plain string
/// literal cannot be placed in the chunk graph, so it is an error rather than a
/// silently dropped edge.
pub(super) fn collect_dynamic_import_specifiers(
    program: &Program<'_>,
) -> std::result::Result<Vec<String>, String> {
    struct DynamicImportVisitor {
        specifiers: Vec<String>,
        errors: Vec<String>,
    }

    impl<'a> Visit<'a> for DynamicImportVisitor {
        fn visit_import_expression(&mut self, import: &ImportExpression<'a>) {
            if import.options.is_some() {
                self.errors
                    .push("import() requires exactly one string literal argument".to_string());
            } else {
                match &import.source {
                    Expression::StringLiteral(string) => {
                        self.specifiers.push(string.value.to_string());
                    }
                    Expression::TemplateLiteral(template) => {
                        if let Some(specifier) = no_substitution_template_value(template) {
                            self.specifiers.push(specifier);
                        } else {
                            self.errors.push(
                                "import() requires a string literal module specifier".to_string(),
                            );
                        }
                    }
                    _ => self
                        .errors
                        .push("import() requires a string literal module specifier".to_string()),
                }
            }
            // Match the former node-store pre-order, including imports nested
            // inside invalid specifiers and options.
            walk::walk_import_expression(self, import);
        }
    }

    let mut visitor = DynamicImportVisitor {
        specifiers: Vec::new(),
        errors: Vec::new(),
    };
    visitor.visit_program(program);
    if !visitor.errors.is_empty() {
        return Err(visitor.errors.join("\n"));
    }
    Ok(visitor.specifiers)
}

/// The text of a template literal that has no substitutions, cooked value
/// preferred over raw so escapes read the way the author meant them.
fn no_substitution_template_value(template: &TemplateLiteral<'_>) -> Option<String> {
    if !template.expressions.is_empty() || template.quasis.len() != 1 {
        return None;
    }
    let quasi = &template.quasis[0];
    Some(
        quasi
            .value
            .cooked
            .as_ref()
            .map_or_else(|| quasi.value.raw.to_string(), |value| value.to_string()),
    )
}
