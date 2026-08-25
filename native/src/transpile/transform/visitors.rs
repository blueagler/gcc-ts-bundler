use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_allocator::FromIn;
use oxc_ast::ast::{
    AccessorProperty, BindingProperty, Expression, MethodDefinition, ObjectProperty,
    PropertyDefinition, PropertyKey, SimpleAssignmentTarget, UnaryOperator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Str;
use oxc_syntax::number::NumberBase;

use super::super::TranspileContext;

pub(super) fn preserve_property_names<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    context: &TranspileContext,
) {
    if context.preserved_property_names.is_empty() {
        return;
    }
    PreservedPropertyVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        names: &context.preserved_property_names,
    }
    .visit_program(program);
}

pub(super) struct PreservedPropertyVisitor<'a, 'n> {
    pub(super) allocator: &'a Allocator,
    pub(super) builder: AstBuilder<'a>,
    pub(super) names: &'n HashSet<String>,
}

impl<'a> PreservedPropertyVisitor<'a, '_> {
    fn quote_key(&self, key: &mut PropertyKey<'a>) -> bool {
        let PropertyKey::StaticIdentifier(identifier) = key else {
            return false;
        };
        if !self.names.contains(identifier.name.as_str()) {
            return false;
        }
        *key = PropertyKey::new_string_literal(
            SPAN,
            Str::from_in(identifier.name.as_str(), self.allocator),
            None,
            &self.builder,
        );
        true
    }
}

impl<'a> VisitMut<'a> for PreservedPropertyVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        if !self.names.contains(member.property.name.as_str()) {
            return;
        }
        let property = member.property.name.to_string();
        let optional = member.optional;
        let object = std::mem::replace(
            &mut member.object,
            Expression::new_null_literal(SPAN, &self.builder),
        );
        *expression = Expression::new_computed_member_expression(
            SPAN,
            object,
            Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            ),
            optional,
            &self.builder,
        );
    }

    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        if let SimpleAssignmentTarget::StaticMemberExpression(member) = target {
            if self.names.contains(member.property.name.as_str()) {
                let property = member.property.name.to_string();
                let optional = member.optional;
                let object = std::mem::replace(
                    &mut member.object,
                    Expression::new_null_literal(SPAN, &self.builder),
                );
                *target = SimpleAssignmentTarget::new_computed_member_expression(
                    SPAN,
                    object,
                    Expression::new_string_literal(
                        SPAN,
                        Str::from_in(&property, self.allocator),
                        None,
                        &self.builder,
                    ),
                    optional,
                    &self.builder,
                );
                return;
            }
        }
        walk_mut::walk_simple_assignment_target(self, target);
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        walk_mut::walk_object_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
            property.shorthand = false;
        }
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        walk_mut::walk_binding_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
            property.shorthand = false;
        }
    }

    fn visit_method_definition(&mut self, method: &mut MethodDefinition<'a>) {
        walk_mut::walk_method_definition(self, method);
        if matches!(
            &method.key,
            PropertyKey::StaticIdentifier(identifier) if identifier.name == "constructor"
        ) {
            return;
        }
        if self.quote_key(&mut method.key) {
            method.computed = false;
        }
    }

    fn visit_property_definition(&mut self, property: &mut PropertyDefinition<'a>) {
        walk_mut::walk_property_definition(self, property);
        // A quoted STATIC field crashes Closure: ConvertToDottedProperties
        // reads the value of `static "x" = v` from the wrong child and
        // dereferences null ("Cannot invoke Node.detach() because rightElem is
        // null"). Quoting a class field buys nothing anyway — that same pass
        // converts `"x" = v` straight back to `x = v`, and the extern entry is
        // what keeps the name out of renaming.
        if property.r#static {
            return;
        }
        if self.quote_key(&mut property.key) {
            property.computed = false;
            if property.value.is_none() {
                property.value = Some(Expression::new_unary_expression(
                    SPAN,
                    UnaryOperator::Void,
                    Expression::new_numeric_literal(
                        SPAN,
                        0.0,
                        None,
                        NumberBase::Decimal,
                        &self.builder,
                    ),
                    &self.builder,
                ));
            }
        }
    }

    fn visit_accessor_property(&mut self, property: &mut AccessorProperty<'a>) {
        walk_mut::walk_accessor_property(self, property);
        if self.quote_key(&mut property.key) {
            property.computed = false;
        }
    }
}
