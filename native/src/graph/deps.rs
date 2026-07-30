use super::*;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Expression, ImportOrExportKind, Program, Statement, TemplateLiteral};
use oxc_ast::AstKind;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

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
    // Language and JSX come from the extension, exactly as before. The module
    // kind is forced: `from_path` leaves `.ts`/`.js` ambiguous and would fall
    // back to script mode for a file with no import or export, which rejects
    // top-level `await`. Every file here was previously parsed as a module, and
    // an unknown extension keeps the old plain-ESM fallback.
    let source_type = SourceType::from_path(file_path)
        .unwrap_or_else(|_| SourceType::mjs())
        .with_module(true);
    let parsed = oxc_parser::Parser::new(allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!(
            "{}: {}",
            file_path.to_string_lossy(),
            error.message
        ));
    }
    Ok(parsed.program)
}

/// Static import edges, in source order. Type-only forms carry no runtime
/// dependency and are skipped.
pub(super) fn extract_dependencies(program: &Program<'_>) -> Vec<String> {
    let mut dependencies = Vec::new();

    for item in &program.body {
        match item {
            Statement::ImportDeclaration(import_decl) => {
                if import_decl.import_kind == ImportOrExportKind::Value {
                    dependencies.push(import_decl.source.value.to_string());
                }
            }
            Statement::ExportNamedDeclaration(named) => {
                if named.export_kind == ImportOrExportKind::Value {
                    if let Some(source) = &named.source {
                        dependencies.push(source.value.to_string());
                    }
                }
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
    let mut specifiers = Vec::new();
    let mut errors = Vec::new();

    // `with_build_nodes` is what fills the node store; without it the scan
    // finds nothing.
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    for node in semantic.nodes().iter() {
        let AstKind::ImportExpression(import_expression) = node.kind() else {
            continue;
        };
        if import_expression.options.is_some() {
            errors.push("import() requires exactly one string literal argument".to_string());
            continue;
        }
        match &import_expression.source {
            Expression::StringLiteral(string) => specifiers.push(string.value.to_string()),
            Expression::TemplateLiteral(template) => {
                match no_substitution_template_value(template) {
                    Some(specifier) => specifiers.push(specifier),
                    None => errors
                        .push("import() requires a string literal module specifier".to_string()),
                }
            }
            _ => errors.push("import() requires a string literal module specifier".to_string()),
        }
    }

    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(specifiers)
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
            .map(|value| value.to_string())
            .unwrap_or_else(|| quasi.value.raw.to_string()),
    )
}
