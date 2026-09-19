use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::{Program, Statement};
use oxc_codegen::Codegen;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

pub(crate) fn emit_preserved_module(path: &Path, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    if source_type.is_typescript() && source_type.is_jsx() {
        return Err(format!(
            "Preserved type stripping requires a non-JSX TypeScript module: {}",
            path.display()
        ));
    }
    let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut program = parsed.program;
    if source_type.is_typescript() {
        rewrite_preserved_module_specifiers(&allocator, path, &mut program);
        let semantic = SemanticBuilder::new()
            .with_build_nodes(false)
            .with_enum_eval(true)
            .build(&program);
        if !semantic.diagnostics.is_empty() {
            return Err(semantic
                .diagnostics
                .iter()
                .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        let options = TransformOptions::default();
        let result = Transformer::new(&allocator, path, &options)
            .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
        if !result.diagnostics.is_empty() {
            return Err(result
                .diagnostics
                .iter()
                .map(|diagnostic| format!("{}: {diagnostic}", path.display()))
                .collect::<Vec<_>>()
                .join("\n"));
        }
    }
    Ok(Codegen::new()
        .with_options(oxc_codegen::CodegenOptions::minify())
        .build(&program)
        .code)
}

fn rewrite_preserved_module_specifiers<'a>(
    allocator: &'a Allocator,
    path: &Path,
    program: &mut Program<'a>,
) {
    for statement in &mut program.body {
        let literal = match statement {
            Statement::ImportDeclaration(import) => Some(&mut import.source),
            Statement::ExportAllDeclaration(export) => Some(&mut export.source),
            Statement::ExportFromDeclaration(export) => Some(&mut export.source),
            _ => None,
        };
        let Some(literal) = literal else {
            continue;
        };
        let Some(specifier) = preserved_output_specifier(path, literal.value.as_str()) else {
            continue;
        };
        literal.value = oxc_str::Str::from_in(specifier.as_str(), allocator);
        literal.raw = None;
    }
}

fn preserved_output_specifier(path: &Path, specifier: &str) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let extension = Path::new(specifier)
        .extension()
        .and_then(|value| value.to_str());
    if matches!(extension, Some("ts" | "tsx" | "mts" | "cts")) {
        let stem = specifier.rsplit_once('.')?.0;
        return Some(format!("{stem}.js"));
    }
    if extension.is_some() {
        return None;
    }
    let target = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(specifier);
    for extension in ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"] {
        if target.with_extension(extension).is_file() {
            return Some(format!("{specifier}.js"));
        }
    }
    for extension in ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"] {
        if target.join(format!("index.{extension}")).is_file() {
            return Some(format!("{}/index.js", specifier.trim_end_matches('/')));
        }
    }
    None
}
