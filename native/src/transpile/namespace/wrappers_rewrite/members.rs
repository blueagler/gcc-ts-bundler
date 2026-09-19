//! Member-expression helpers for wrapper-flow resolve.

use oxc_ast::ast::Expression;

use super::literal_property_name;

pub(crate) fn is_member_expression(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::PrivateFieldExpression(_)
    )
}

pub(crate) fn member_object<'a>(expression: &'a Expression<'a>) -> Option<&'a Expression<'a>> {
    match expression {
        Expression::StaticMemberExpression(member) => Some(&member.object),
        Expression::ComputedMemberExpression(member) => Some(&member.object),
        Expression::PrivateFieldExpression(member) => Some(&member.object),
        _ => None,
    }
}

pub(crate) fn member_property_name(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::StaticMemberExpression(member) => Some(member.property.name.to_string()),
        Expression::ComputedMemberExpression(member) => literal_property_name(&member.expression),
        _ => None,
    }
}

pub(crate) fn member_is_literal_computed(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ComputedMemberExpression(member)
            if matches!(
                member.expression,
                Expression::StringLiteral(_) | Expression::NumericLiteral(_)
            )
    )
}
