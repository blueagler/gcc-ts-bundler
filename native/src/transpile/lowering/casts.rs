// Owned lowering: Closure type casts
//
// oxc erases `as T`, `<T>expr`, and `satisfies T`. Closure needs the same
// fact as `/** @type {T} */ (expr)`. Source JSDoc is dropped at codegen
// (`jsdoc: false`), so a comment on the AST would never print through
// statement-level emit. Encode the type in a parenthesized comma sequence
// that survives print, then rewrite the unique marker back to `@type`.
// `as const` is not a Closure type — unwrap it and let the transformer
// erase the rest.

use oxc_allocator::Allocator;
use oxc_allocator::FromIn;
use oxc_allocator::TakeIn;
use oxc_allocator::Vec as ArenaVec;
use oxc_ast::ast::{Expression, Program, TSLiteral, TSType, TSTypeName, UnaryOperator};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
#[cfg(test)]
use oxc_codegen::Codegen;
#[cfg(test)]
use oxc_span::SourceType;
use oxc_span::SPAN;
use oxc_str::Str;
#[cfg(test)]
use std::path::Path;

#[cfg(test)]
use super::comments::closure_input_codegen_options;

pub(super) const CAST_MARKER_PREFIX: &str = "__gccTsCast$:";

pub(super) fn synthesize_closure_casts<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    ClosureCastSynthesizer {
        allocator,
        builder: AstBuilder::new(allocator),
    }
    .visit_program(program);
}

struct ClosureCastSynthesizer<'a> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
}

impl<'a> VisitMut<'a> for ClosureCastSynthesizer<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if wrap_type_assertion(self.allocator, &self.builder, expression) {
            // Keep walking so nested assertions inside the inner expression
            // become casts too.
        }
        walk_mut::walk_expression(self, expression);
    }
}

fn wrap_type_assertion<'a>(
    allocator: &'a Allocator,
    builder: &AstBuilder<'a>,
    expression: &mut Expression<'a>,
) -> bool {
    let type_string = match expression {
        Expression::TSAsExpression(node) => cast_type_string(&node.type_annotation),
        Expression::TSTypeAssertion(node) => cast_type_string(&node.type_annotation),
        Expression::TSSatisfiesExpression(node) => cast_type_string(&node.type_annotation),
        _ => return false,
    };
    let inner = match expression {
        Expression::TSAsExpression(node) => node.expression.take_in(builder),
        Expression::TSTypeAssertion(node) => node.expression.take_in(builder),
        Expression::TSSatisfiesExpression(node) => node.expression.take_in(builder),
        _ => return false,
    };
    *expression = match type_string {
        Some(type_string) => synthesized_cast_expression(allocator, builder, &type_string, inner),
        None => inner,
    };
    true
}

fn cast_type_string(type_annotation: &TSType<'_>) -> Option<String> {
    if type_annotation.is_const_type_reference() {
        return None;
    }
    Some(render_closure_type(type_annotation))
}

fn synthesized_cast_expression<'a>(
    allocator: &'a Allocator,
    builder: &AstBuilder<'a>,
    type_string: &str,
    inner: Expression<'a>,
) -> Expression<'a> {
    let marker = Expression::new_string_literal(
        SPAN,
        Str::from_in(&format!("{CAST_MARKER_PREFIX}{type_string}"), allocator),
        None,
        builder,
    );
    let mut expressions = ArenaVec::with_capacity_in(2, &allocator);
    expressions.push(marker);
    expressions.push(inner);
    let sequence = Expression::new_sequence_expression(SPAN, expressions, builder);
    Expression::new_parenthesized_expression(SPAN, sequence, builder)
}

fn render_closure_type(ty: &TSType<'_>) -> String {
    match ty {
        TSType::TSAnyKeyword(_) => "?".to_string(),
        TSType::TSUnknownKeyword(_) => "*".to_string(),
        TSType::TSNeverKeyword(_) | TSType::TSIntrinsicKeyword(_) => "?".to_string(),
        TSType::TSBigIntKeyword(_) => "bigint".to_string(),
        TSType::TSBooleanKeyword(_) => "boolean".to_string(),
        TSType::TSNumberKeyword(_) => "number".to_string(),
        TSType::TSStringKeyword(_) => "string".to_string(),
        TSType::TSSymbolKeyword(_) => "symbol".to_string(),
        TSType::TSVoidKeyword(_) => "void".to_string(),
        TSType::TSUndefinedKeyword(_) => "undefined".to_string(),
        TSType::TSNullKeyword(_) => "null".to_string(),
        TSType::TSObjectKeyword(_) => "!Object".to_string(),
        TSType::TSThisType(_) => "this".to_string(),
        TSType::TSArrayType(array) => {
            format!("!Array<{}>", render_closure_type(&array.element_type))
        }
        TSType::TSTupleType(_) => "!Array<?>".to_string(),
        TSType::TSParenthesizedType(inner) => render_closure_type(&inner.type_annotation),
        TSType::TSUnionType(union) => {
            let mut parts = Vec::new();
            for item in &union.types {
                let rendered = render_closure_type(item);
                if !parts.iter().any(|existing| existing == &rendered) {
                    parts.push(rendered);
                }
            }
            match parts.as_slice() {
                [] => "?".to_string(),
                [only] => only.clone(),
                _ => format!("({})", parts.join("|")),
            }
        }
        TSType::TSIntersectionType(_) => "?".to_string(),
        TSType::TSLiteralType(literal) => render_closure_literal(&literal.literal),
        TSType::TSTypeReference(reference) => render_type_reference(reference),
        TSType::JSDocNullableType(inner) => {
            format!("?{}", render_closure_type(&inner.type_annotation))
        }
        TSType::JSDocNonNullableType(inner) => {
            format!("!{}", render_closure_type(&inner.type_annotation))
        }
        TSType::JSDocUnknownType(_) => "?".to_string(),
        TSType::TSConditionalType(_)
        | TSType::TSConstructorType(_)
        | TSType::TSFunctionType(_)
        | TSType::TSImportType(_)
        | TSType::TSIndexedAccessType(_)
        | TSType::TSInferType(_)
        | TSType::TSMappedType(_)
        | TSType::TSNamedTupleMember(_)
        | TSType::TSTemplateLiteralType(_)
        | TSType::TSTypeLiteral(_)
        | TSType::TSTypeOperatorType(_)
        | TSType::TSTypePredicate(_)
        | TSType::TSTypeQuery(_) => "?".to_string(),
    }
}

fn render_type_reference(reference: &oxc_ast::ast::TSTypeReference<'_>) -> String {
    let mut name = render_type_name(&reference.type_name);
    if let Some(args) = &reference.type_arguments {
        let rendered = args
            .params
            .iter()
            .map(render_closure_type)
            .collect::<Vec<_>>()
            .join(",");
        name.push('<');
        name.push_str(&rendered);
        name.push('>');
    }
    name
}

fn render_type_name(name: &TSTypeName<'_>) -> String {
    name.to_string()
}

fn render_closure_literal(literal: &TSLiteral<'_>) -> String {
    match literal {
        TSLiteral::BooleanLiteral(_) => "boolean".to_string(),
        TSLiteral::NumericLiteral(number) => match number.raw {
            Some(raw) => raw.to_string(),
            None => number.value.to_string(),
        },
        TSLiteral::BigIntLiteral(number) => match number.raw {
            Some(raw) => raw.to_string(),
            None => "bigint".to_string(),
        },
        TSLiteral::StringLiteral(string) => format!("{:?}", string.value.as_str()),
        TSLiteral::TemplateLiteral(_) => "string".to_string(),
        TSLiteral::UnaryExpression(unary) => match &unary.argument {
            Expression::NumericLiteral(number)
                if unary.operator == UnaryOperator::UnaryNegation =>
            {
                format!(
                    "-{}",
                    number
                        .raw
                        .map_or_else(|| number.value.to_string(), |raw| raw.to_string())
                )
            }
            _ => "?".to_string(),
        },
    }
}

pub(crate) fn materialize_closure_casts(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(marker_at) = rest.find(CAST_MARKER_PREFIX) {
        let before_marker = &rest[..marker_at];
        let Some(quote_offset) = before_marker.rfind(['"', '\'']) else {
            output.push_str(&rest[..=marker_at]);
            rest = &rest[marker_at + 1..];
            continue;
        };
        let prefix = &before_marker[..quote_offset];
        let quote = before_marker.as_bytes()[quote_offset] as char;
        let Some((unescaped, after_string)) = parse_js_string(&rest[quote_offset..], quote) else {
            output.push_str(&rest[..marker_at + CAST_MARKER_PREFIX.len()]);
            rest = &rest[marker_at + CAST_MARKER_PREFIX.len()..];
            continue;
        };
        let Some(type_string) = unescaped.strip_prefix(CAST_MARKER_PREFIX) else {
            output.push_str(&rest[..marker_at + CAST_MARKER_PREFIX.len()]);
            rest = &rest[marker_at + CAST_MARKER_PREFIX.len()..];
            continue;
        };
        let Some(after_comma) = after_string.strip_prefix(',') else {
            output.push_str(&rest[..marker_at + CAST_MARKER_PREFIX.len()]);
            rest = &rest[marker_at + CAST_MARKER_PREFIX.len()..];
            continue;
        };
        let Some(before_open) = prefix.trim_end().strip_suffix('(') else {
            output.push_str(&rest[..marker_at + CAST_MARKER_PREFIX.len()]);
            rest = &rest[marker_at + CAST_MARKER_PREFIX.len()..];
            continue;
        };
        output.push_str(before_open);
        output.push_str("/** @type {");
        output.push_str(&sanitize_jsdoc_type(type_string));
        output.push_str("} */ (");
        rest = after_comma.trim_start();
    }
    output.push_str(rest);
    output
}

fn sanitize_jsdoc_type(type_string: &str) -> String {
    type_string.replace("*/", "* /")
}

fn parse_js_string(source: &str, quote: char) -> Option<(String, &str)> {
    let mut chars = source.char_indices();
    let (_, first) = chars.next()?;
    if first != quote {
        return None;
    }
    let mut out = String::new();
    while let Some((index, ch)) = chars.next() {
        match ch {
            '\\' => {
                let (_, escaped) = chars.next()?;
                match escaped {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    '\\' | '\'' | '"' => out.push(escaped),
                    'u' => {
                        let mut hex = String::new();
                        for _ in 0..4 {
                            hex.push(chars.next()?.1);
                        }
                        let code = u32::from_str_radix(&hex, 16).ok()?;
                        out.push(char::from_u32(code)?);
                    }
                    other => out.push(other),
                }
            }
            ch if ch == quote => {
                return Some((out, &source[index + quote.len_utf8()..]));
            }
            ch => out.push(ch),
        }
    }
    None
}

#[cfg(test)]
mod synthesize_casts {
    use super::super::lower_with_oxc;
    use super::*;

    fn emit(source: &str) -> String {
        lower_with_oxc(Path::new("cast.ts"), source).expect("lowering")
    }

    #[test]
    fn as_number_becomes_parenthesized_type_cast() {
        let code = emit("const n = value as number;\n");
        assert!(
            code.contains("/** @type {number} */") && code.contains("(value)"),
            "{code}"
        );
        assert!(!code.contains(CAST_MARKER_PREFIX), "{code}");
    }

    #[test]
    fn angle_bracket_assertion_becomes_type_cast() {
        let code = emit("const n = <string>value;\n");
        assert!(
            code.contains("/** @type {string} */") && code.contains("(value)"),
            "{code}"
        );
    }

    #[test]
    fn satisfies_becomes_type_cast() {
        let code = emit("const n = value satisfies boolean;\n");
        assert!(
            code.contains("/** @type {boolean} */") && code.contains("(value)"),
            "{code}"
        );
    }

    #[test]
    fn named_and_array_types_render() {
        let code = emit("const n = value as Foo[];\n");
        assert!(code.contains("/** @type {!Array<Foo>} */"), "{code}");
    }

    #[test]
    fn const_assertion_is_not_a_cast() {
        let code = emit("const n = value as const;\n");
        assert!(!code.contains("@type"), "{code}");
        assert!(code.contains("value"), "{code}");
    }

    #[test]
    fn hostile_source_jsdoc_is_still_dropped() {
        let allocator = Allocator::default();
        let source = "export const cast = /** @type {string} */ (String(2));\n";
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        synthesize_closure_casts(&allocator, &mut program);
        let code = materialize_closure_casts(
            &Codegen::new()
                .with_options(closure_input_codegen_options())
                .build(&program)
                .code,
        );
        assert!(!code.contains("@type"), "{code}");
        assert!(!code.contains("HOSTILE"), "{code}");
    }
}
