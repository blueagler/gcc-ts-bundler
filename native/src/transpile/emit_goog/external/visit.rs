//! Rewrite external-boundary member accesses to quoted computed form.

use std::collections::HashSet;

use oxc_allocator::{Allocator, FromIn, TakeIn};
use oxc_ast::ast::{
    BindingProperty, ChainElement, Expression, ObjectProperty, PropertyKey, SimpleAssignmentTarget,
};
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::Span;
use oxc_str::Ident;

use super::quote::ExternalBoundaryAccessQuoter;

impl<'a> VisitMut<'a> for ExternalBoundaryAccessQuoter<'a, '_> {
    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        walk_mut::walk_simple_assignment_target(self, target);
        let SimpleAssignmentTarget::StaticMemberExpression(member) = target else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *target = SimpleAssignmentTarget::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_chain_element(&mut self, element: &mut ChainElement<'a>) {
        walk_mut::walk_chain_element(self, element);
        let ChainElement::StaticMemberExpression(member) = element else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *element = ChainElement::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *expression = Expression::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        walk_mut::walk_binding_property(self, property);
        if let Some((span, name)) =
            quoted_property_key(&property.key, &self.external_member_starts, self.allocator)
        {
            property.key = PropertyKey::new_string_literal(span, name, None, &self.builder);
            property.shorthand = false;
            property.computed = false;
        }
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        walk_mut::walk_object_property(self, property);
        if let Some((span, name)) =
            quoted_property_key(&property.key, &self.external_member_starts, self.allocator)
        {
            property.key = PropertyKey::new_string_literal(span, name, None, &self.builder);
            property.shorthand = false;
            property.computed = false;
        }
    }
}

fn quoted_property_key<'a>(
    key: &PropertyKey<'a>,
    external_member_starts: &HashSet<u32>,
    allocator: &'a Allocator,
) -> Option<(Span, Ident<'a>)> {
    let PropertyKey::StaticIdentifier(identifier) = key else {
        return None;
    };
    external_member_starts
        .contains(&identifier.span.start)
        .then(|| {
            (
                identifier.span,
                Ident::from_in(identifier.name.as_str(), allocator),
            )
        })
}
