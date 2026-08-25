//! Member-expression lowering for BundlerRuntimeNamespaceVisitor.

use std::collections::BTreeSet;

use oxc_allocator::{FromIn, TakeIn};
use oxc_ast::ast::*;
use oxc_span::SPAN;
use oxc_str::Str;
use oxc_syntax::number::NumberBase;

use super::super::flow_helpers::{
    computed_property_name, finite_computed_property, lower_bound_finite_namespace_member,
    lower_finite_namespace_member,
};
use super::super::flow_visitors::BundlerRuntimeNamespaceVisitor;
use crate::transpile::to_bundler_runtime_module_id;

impl<'a> BundlerRuntimeNamespaceVisitor<'a, '_> {
    pub(crate) fn lower_finite_computed_member(&mut self, expression: &mut Expression<'a>) -> bool {
        let Expression::ComputedMemberExpression(member) = expression else {
            return false;
        };
        if computed_property_name(&member.expression).is_some() {
            return false;
        }
        let Expression::Identifier(object_identifier) = &member.object else {
            return false;
        };
        let Some(object_binding) = self.identity.key_of_reference(object_identifier) else {
            return false;
        };
        if !self.namespace_bindings.contains_key(&object_binding)
            && !self.direct_namespace_targets.contains_key(&object_binding)
        {
            return false;
        }

        if finite_computed_property(&member.expression) {
            let object = member.object.take_in(&self.builder);
            let property = member.expression.take_in(&self.builder);
            *expression = lower_finite_namespace_member(
                object,
                property,
                member.optional,
                self.allocator,
                &self.builder,
            );
            return true;
        }

        let Expression::Identifier(property_identifier) = &member.expression else {
            return false;
        };
        let Some(properties) = self
            .identity
            .key_of_reference(property_identifier)
            .and_then(|key| self.finite_property_bindings.get(&key))
            .cloned()
        else {
            return false;
        };
        let object = member.object.take_in(&self.builder);
        let property = member.expression.take_in(&self.builder);
        *expression = lower_bound_finite_namespace_member(
            object,
            property,
            &properties,
            member.optional,
            self.allocator,
            &self.builder,
        );
        true
    }

    pub(crate) fn rewrite_member_expression(&mut self, expression: &mut Expression<'a>) -> bool {
        let (object, property, optional) = match expression {
            Expression::StaticMemberExpression(member) => (
                &member.object,
                Some(member.property.name.to_string()),
                member.optional,
            ),
            Expression::ComputedMemberExpression(member) => (
                &member.object,
                computed_property_name(&member.expression),
                member.optional,
            ),
            _ => return false,
        };
        let Some(module_ids) = self.module_ids_for_namespace(object) else {
            return false;
        };
        let Some(property) = property else {
            self.reify(&module_ids, expression);
            return true;
        };
        let slot = match self.slot_for_module_ids(&module_ids, &property) {
            Ok(slot) => slot,
            Err(message) => {
                self.push_error(message);
                return true;
            }
        };
        let object = match expression {
            Expression::StaticMemberExpression(member) => member.object.take_in(&self.builder),
            Expression::ComputedMemberExpression(member) => member.object.take_in(&self.builder),
            _ => unreachable!(),
        };
        let slot = Expression::new_numeric_literal(
            SPAN,
            slot as f64,
            None,
            NumberBase::Decimal,
            &self.builder,
        );
        *expression =
            Expression::new_computed_member_expression(SPAN, object, slot, optional, &self.builder);
        true
    }

    pub(crate) fn rewrite_direct_namespace_member(
        &mut self,
        expression: &mut Expression<'a>,
    ) -> bool {
        let (object, property) = match expression {
            Expression::StaticMemberExpression(member) => {
                (&member.object, Some(member.property.name.to_string()))
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, computed_property_name(&member.expression))
            }
            _ => return false,
        };
        let Expression::Identifier(identifier) = object else {
            return false;
        };
        let Some(binding) = self.identity.key_of_reference(identifier) else {
            return false;
        };
        let Some(target_module_id) = self.direct_namespace_targets.get(&binding).cloned() else {
            return false;
        };
        let Some(property) = property else {
            self.reify(&BTreeSet::from([target_module_id]), expression);
            return true;
        };
        let Some(hoist) = &self.hoist else {
            return false;
        };
        let Some(resolved) = hoist.plan.resolve_export(&target_module_id, &property) else {
            self.push_error(format!(
                "bundler-runtime cannot rewrite namespace access for export {property:?} from {target_module_id}"
            ));
            return true;
        };
        if hoist
            .plan
            .is_direct_binding(hoist.consumer_module_id, resolved)
        {
            if let Some(direct_name) = hoist.plan.direct_binding_name(resolved) {
                if !hoist.lexical_binding_names.contains(&direct_name) {
                    *expression = Expression::new_identifier(
                        SPAN,
                        oxc_str::Ident::from_in(&direct_name, self.allocator),
                        &self.builder,
                    );
                    return true;
                }
            }
        }
        let Some(owner_slots) = self
            .context
            .bundler_module_slots
            .get(&resolved.owner_module_id)
        else {
            self.push_error(format!(
                "Missing bundler-runtime export slot metadata for {}",
                resolved.owner_module_id
            ));
            return true;
        };
        let Some(owner_slot) = owner_slots.slot_for(&resolved.owner_export_name) else {
            self.push_error(format!(
                "bundler-runtime cannot rewrite namespace access for export {:?} from {}",
                resolved.owner_export_name, resolved.owner_module_id
            ));
            return true;
        };
        let callee = Expression::new_identifier(SPAN, "__require", &self.builder);
        let runtime_module_id = to_bundler_runtime_module_id(&resolved.owner_module_id);
        let module_id = Expression::new_string_literal(
            SPAN,
            Str::from_in(&runtime_module_id, self.allocator),
            None,
            &self.builder,
        );
        let arguments =
            oxc_allocator::Vec::from_value_in(Argument::from(module_id), &self.allocator);
        let require = Expression::new_call_expression(
            SPAN,
            callee,
            None::<oxc_allocator::Box<'a, TSTypeParameterInstantiation<'a>>>,
            arguments,
            false,
            &self.builder,
        );
        let slot = Expression::new_numeric_literal(
            SPAN,
            owner_slot as f64,
            None,
            NumberBase::Decimal,
            &self.builder,
        );
        *expression =
            Expression::new_computed_member_expression(SPAN, require, slot, false, &self.builder);
        true
    }
}
