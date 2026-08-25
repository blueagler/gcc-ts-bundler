//! Shared flow-cell and assignment-target helpers for carrier walks.

use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};

use super::super::wrappers_rewrite::literal_property_name;
use crate::transpile::identity::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};

pub(crate) fn collect_flow_storage_cells(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BindingKeySet {
    let mut collector = FlowStorageCellCollector {
        identity,
        initialized_by_call: HashMap::new(),
        read_by_unary_call: HashSet::new(),
    };
    collector.visit_program(program);
    let evidenced_initializers = collector
        .initialized_by_call
        .iter()
        .filter_map(|(callee, bindings)| {
            bindings
                .iter()
                .any(|binding| collector.read_by_unary_call.contains(binding))
                .then_some(callee.clone())
        })
        .collect::<HashSet<_>>();
    collector
        .initialized_by_call
        .into_iter()
        .filter(|(callee, _)| evidenced_initializers.contains(callee))
        .flat_map(|(_, bindings)| bindings)
        .collect()
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum FlowReferenceKey {
    Binding(BindingKey),
    Global(String),
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum FlowCalleeKey {
    Ident(FlowReferenceKey),
    Member(FlowReferenceKey, String),
}

struct FlowStorageCellCollector<'a> {
    identity: &'a ModuleIdentity,
    initialized_by_call: HashMap<FlowCalleeKey, BindingKeySet>,
    read_by_unary_call: BindingKeySet,
}

impl<'a> Visit<'a> for FlowStorageCellCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (
            BindingPattern::BindingIdentifier(binding),
            Some(Expression::CallExpression(call)),
        ) = (&declarator.id, &declarator.init)
        {
            if let Some(callee) = flow_callee_key(&call.callee, self.identity) {
                self.initialized_by_call
                    .entry(callee)
                    .or_default()
                    .insert(self.identity.key_of_binding(binding));
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let [argument] = call.arguments.as_slice() {
            if let Some(Expression::Identifier(identifier)) = argument.as_expression() {
                if let Some(binding) = self.identity.key_of_reference(identifier) {
                    self.read_by_unary_call.insert(binding);
                }
            }
        }
        walk::walk_call_expression(self, call);
    }
}

fn flow_reference_key(
    identifier: &IdentifierReference<'_>,
    identity: &ModuleIdentity,
) -> FlowReferenceKey {
    identity
        .key_of_reference(identifier)
        .map(FlowReferenceKey::Binding)
        .unwrap_or_else(|| FlowReferenceKey::Global(identifier.name.to_string()))
}

fn flow_callee_key(callee: &Expression<'_>, identity: &ModuleIdentity) -> Option<FlowCalleeKey> {
    match callee {
        Expression::Identifier(identifier) => Some(FlowCalleeKey::Ident(flow_reference_key(
            identifier, identity,
        ))),
        Expression::StaticMemberExpression(member) => Some(FlowCalleeKey::Member(
            flow_reference_key(member.object.get_identifier_reference()?, identity),
            member.property.name.to_string(),
        )),
        Expression::ComputedMemberExpression(member) => Some(FlowCalleeKey::Member(
            flow_reference_key(member.object.get_identifier_reference()?, identity),
            literal_property_name(&member.expression)?,
        )),
        Expression::ParenthesizedExpression(parenthesized) => {
            flow_callee_key(&parenthesized.expression, identity)
        }
        _ => None,
    }
}

pub(crate) fn remove_assignment_target_carriers<T>(
    target: &AssignmentTarget<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    if let Some(simple) = target.as_simple_assignment_target() {
        remove_simple_assignment_target_carrier(simple, carriers, identity);
        return;
    }
    match target {
        AssignmentTarget::ArrayAssignmentTarget(array) => {
            for element in array.elements.iter().flatten() {
                remove_maybe_default_target_carriers(element, carriers, identity);
            }
            if let Some(rest) = &array.rest {
                remove_assignment_target_carriers(&rest.target, carriers, identity);
            }
        }
        AssignmentTarget::ObjectAssignmentTarget(object) => {
            for property in &object.properties {
                match property {
                    AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                        if let Some(binding) = identity.key_of_reference(&property.binding) {
                            carriers.remove(&binding);
                        }
                    }
                    AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                        remove_maybe_default_target_carriers(&property.binding, carriers, identity);
                    }
                }
            }
            if let Some(rest) = &object.rest {
                remove_assignment_target_carriers(&rest.target, carriers, identity);
            }
        }
        _ => {}
    }
}

fn remove_maybe_default_target_carriers<T>(
    target: &AssignmentTargetMaybeDefault<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    match target {
        AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
            remove_assignment_target_carriers(&default.binding, carriers, identity);
        }
        _ => remove_assignment_target_carriers(target.to_assignment_target(), carriers, identity),
    }
}

pub(crate) fn remove_simple_assignment_target_carrier<T>(
    target: &SimpleAssignmentTarget<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    match target {
        SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
            if let Some(binding) = identity.key_of_reference(identifier) {
                carriers.remove(&binding);
            }
        }
        SimpleAssignmentTarget::TSAsExpression(expression) => {
            remove_expression_carrier(&expression.expression, carriers, identity);
        }
        SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
            remove_expression_carrier(&expression.expression, carriers, identity);
        }
        SimpleAssignmentTarget::TSNonNullExpression(expression) => {
            remove_expression_carrier(&expression.expression, carriers, identity);
        }
        SimpleAssignmentTarget::TSTypeAssertion(expression) => {
            remove_expression_carrier(&expression.expression, carriers, identity);
        }
        _ => {}
    }
}

fn remove_expression_carrier<T>(
    expression: &Expression<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    if let Expression::Identifier(identifier) = expression.without_parentheses() {
        if let Some(binding) = identity.key_of_reference(identifier) {
            carriers.remove(&binding);
        }
    }
}

pub(crate) fn remove_for_statement_left_carriers<T>(
    left: &ForStatementLeft<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    if let Some(target) = left.as_assignment_target() {
        remove_assignment_target_carriers(target, carriers, identity);
    }
}
