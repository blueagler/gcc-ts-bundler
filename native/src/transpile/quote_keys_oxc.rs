//! Rewrite authored `obj["key"]` to Closure-safe
//! `obj[goog.reflect.objectProperty("key", obj)]` so ADVANCED renaming
//! keeps the string and the property aligned.
//!
//! Dynamic `obj[k]` is left alone. Objects that would double-evaluate, CJS
//! `exports` / `module.exports` surfaces, and non-identifier keys are skipped.
//! `Object.prototype` pin emission is unchanged.

use oxc_allocator::{Allocator, CloneIn, FromIn, Vec as ArenaVec};
use oxc_ast::ast::{
    Argument, ComputedMemberExpression, Expression, IdentifierName, Program,
    TSTypeParameterInstantiation,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::{Ident, Str};

use super::is_valid_js_identifier;

pub(super) fn quote_literal_computed_members<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
) {
    LiteralComputedMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
    }
    .visit_program(program);
}

struct LiteralComputedMemberQuoter<'a> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
}

impl<'a> LiteralComputedMemberQuoter<'a> {
    fn rewrite_computed_key(&self, member: &mut ComputedMemberExpression<'a>) {
        let Expression::StringLiteral(literal) = &member.expression else {
            return;
        };
        if literal.span == SPAN {
            return;
        }
        let key = literal.value.as_str();
        if !is_valid_js_identifier(key) {
            return;
        }
        if is_module_exports_access(&member.object, key) {
            return;
        }
        if is_commonjs_export_object(&member.object) {
            return;
        }
        if !is_safe_to_clone(&member.object) {
            return;
        }
        let key = key.to_string();
        let object = clone_object(&member.object, self.allocator);
        member.expression = object_property_call(&self.builder, self.allocator, &key, object);
    }
}

impl<'a> VisitMut<'a> for LiteralComputedMemberQuoter<'a> {
    fn visit_computed_member_expression(&mut self, member: &mut ComputedMemberExpression<'a>) {
        self.rewrite_computed_key(member);
        walk_mut::walk_computed_member_expression(self, member);
    }
}

fn object_property_call<'a>(
    builder: &AstBuilder<'a>,
    allocator: &'a Allocator,
    key: &str,
    object: Expression<'a>,
) -> Expression<'a> {
    let goog = Expression::new_identifier(SPAN, "goog", builder);
    let reflect: Ident<'a> = Ident::from_in("reflect", allocator);
    let reflect = Expression::new_static_member_expression(
        SPAN,
        goog,
        IdentifierName::new(SPAN, reflect, builder),
        false,
        builder,
    );
    let object_property: Ident<'a> = Ident::from_in("objectProperty", allocator);
    let callee = Expression::new_static_member_expression(
        SPAN,
        reflect,
        IdentifierName::new(SPAN, object_property, builder),
        false,
        builder,
    );
    let key = Expression::new_string_literal(SPAN, Str::from_in(key, allocator), None, builder);
    let mut arguments = ArenaVec::with_capacity_in(2, &allocator);
    arguments.push(Argument::from(key));
    arguments.push(Argument::from(object));
    Expression::new_call_expression(
        SPAN,
        callee,
        None::<oxc_allocator::Box<'a, TSTypeParameterInstantiation<'a>>>,
        arguments,
        false,
        builder,
    )
}

fn clone_object<'a>(object: &Expression<'a>, allocator: &'a Allocator) -> Expression<'a> {
    let mut cloned = object.clone_in(allocator);
    copy_reference_ids(object, &mut cloned);
    cloned
}

fn copy_reference_ids(source: &Expression<'_>, target: &mut Expression<'_>) {
    match (source, target) {
        (Expression::Identifier(source), Expression::Identifier(target)) => {
            target.reference_id.set(source.reference_id.get());
        }
        (
            Expression::ParenthesizedExpression(source),
            Expression::ParenthesizedExpression(target),
        ) => copy_reference_ids(&source.expression, &mut target.expression),
        _ => {}
    }
}

fn is_safe_to_clone(expression: &Expression<'_>) -> bool {
    matches!(
        expression.without_parentheses(),
        Expression::Identifier(_) | Expression::ThisExpression(_)
    )
}

fn is_commonjs_export_object(expression: &Expression<'_>) -> bool {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => identifier.name == "exports",
        Expression::StaticMemberExpression(member) => {
            is_module_identifier(&member.object) && member.property.name == "exports"
        }
        Expression::ComputedMemberExpression(member) => {
            is_module_identifier(&member.object)
                && matches!(&member.expression, Expression::StringLiteral(property) if property.value == "exports")
        }
        _ => false,
    }
}

fn is_module_identifier(expression: &Expression<'_>) -> bool {
    matches!(
        expression.without_parentheses(),
        Expression::Identifier(identifier) if identifier.name == "module"
    )
}

fn is_module_exports_access(object: &Expression<'_>, key: &str) -> bool {
    key == "exports" && is_module_identifier(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn quoted(source: &str) -> String {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        quote_literal_computed_members(&allocator, &mut program);
        Codegen::new().build(&program).code
    }

    #[test]
    fn string_literal_read_becomes_object_property() {
        let output = quoted("export const n = SETTINGS[\"retries\"];\n");
        assert!(
            output.contains("goog.reflect.objectProperty(\"retries\", SETTINGS)"),
            "{output}"
        );
    }

    #[test]
    fn string_literal_write_becomes_object_property() {
        let output = quoted("SETTINGS[\"retries\"] = 1;\n");
        assert!(
            output.contains("SETTINGS[goog.reflect.objectProperty(\"retries\", SETTINGS)] = 1"),
            "{output}"
        );
    }

    #[test]
    fn dynamic_key_is_unchanged() {
        let output = quoted("export const n = SETTINGS[k];\n");
        assert!(output.contains("SETTINGS[k]"), "{output}");
        assert!(!output.contains("goog.reflect"), "{output}");
    }

    #[test]
    fn call_object_is_unchanged() {
        let output = quoted("export const n = load()[\"retries\"];\n");
        assert!(output.contains("load()[\"retries\"]"), "{output}");
        assert!(!output.contains("goog.reflect"), "{output}");
    }

    #[test]
    fn commonjs_exports_are_unchanged() {
        let output = quoted("exports[\"retries\"] = 1;\nmodule[\"exports\"] = 1;\n");
        assert!(output.contains("exports[\"retries\"]"), "{output}");
        assert!(output.contains("module[\"exports\"]"), "{output}");
        assert!(!output.contains("goog.reflect"), "{output}");
    }

    #[test]
    fn non_identifier_key_is_unchanged() {
        let output = quoted("export const n = SETTINGS[\"foo-bar\"];\n");
        assert!(output.contains("SETTINGS[\"foo-bar\"]"), "{output}");
        assert!(!output.contains("goog.reflect"), "{output}");
    }
}
