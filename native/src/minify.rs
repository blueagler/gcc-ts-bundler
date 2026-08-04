use std::path::Path;

use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions, CommentOptions};
use oxc_minifier::{CompressOptions, CompressOptionsUnused, Minifier, MinifierOptions};
use oxc_parser::Parser;
use oxc_span::SourceType;

/// Final output-only compression. This deliberately mirrors the documented
/// no-DCE/no-mangle OXC pass: syntax/golf transforms are allowed, but unused
/// declarations, debugger statements, console calls, property names, and
/// identifiers are not removed or renamed.
pub fn minify_javascript(file_path: String, source: String) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(&file_path))
        .unwrap_or_default()
        .with_module(true);
    let parsed = Parser::new(&allocator, &source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{file_path}: {diagnostic}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let mut program = parsed.program;
    let mut compress = CompressOptions::smallest();
    compress.drop_debugger = false;
    compress.join_vars = true;
    compress.sequences = true;
    compress.unused = CompressOptionsUnused::Keep;
    let result = Minifier::new(MinifierOptions {
        compress: Some(compress),
        mangle: None,
    })
    .minify(&allocator, &mut program);

    Ok(Codegen::new()
        .with_options(CodegenOptions {
            comments: CommentOptions::disabled(),
            minify: true,
            ..CodegenOptions::default()
        })
        .with_scoping(result.scoping)
        .build(&program)
        .code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_mutation_visible_no_dce_no_mangle_contracts() {
        let output = minify_javascript(
            "fixture.mjs".to_string(),
            [
                "const unusedBinding = 1;",
                "const namedFunction = function namedFunction() { return 2; };",
                "const object = { preservedProperty: 3 };",
                "console.log(object.preservedProperty);",
                "debugger;",
                "export { unusedBinding, namedFunction, object };",
            ]
            .join("\n"),
        )
        .unwrap();
        assert!(output.contains("unusedBinding"), "{output}");
        assert!(output.contains("namedFunction"), "{output}");
        assert!(output.contains("preservedProperty"), "{output}");
        assert!(output.contains("console.log"), "{output}");
        assert!(output.contains("debugger"), "{output}");
    }
}
