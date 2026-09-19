//! Resolve dynamic-import object wrappers from expressions.

use std::collections::BTreeSet;

use oxc_ast::ast::{CallExpression, Expression};

use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use super::extract::merge_wrapper_map_into;
use super::members::{
    is_member_expression, member_is_literal_computed, member_object, member_property_name,
};
use crate::transpile::identity::{BindingKeyMap, ModuleIdentity};

pub(crate) fn resolve_dynamic_import_object_wrapper(
    expression: &Expression<'_>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    match expression {
        Expression::Identifier(identifier) => {
            identity.key_of_reference(identifier).and_then(|binding| {
                object_carriers
                    .get(&binding)
                    .cloned()
                    .or_else(|| wrappers.objects.get(&binding).cloned())
            })
        }
        Expression::CallExpression(call) => resolve_dynamic_import_object_wrapper_from_call(
            call,
            object_carriers,
            wrappers,
            identity,
        ),
        member if is_member_expression(member) => {
            resolve_dynamic_import_object_wrapper_from_member(
                member,
                object_carriers,
                wrappers,
                identity,
            )
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            resolve_dynamic_import_object_wrapper(
                &parenthesized.expression,
                object_carriers,
                wrappers,
                identity,
            )
        }
        Expression::ConditionalExpression(conditional) => merge_object_wrappers(
            resolve_dynamic_import_object_wrapper(
                &conditional.consequent,
                object_carriers,
                wrappers,
                identity,
            ),
            resolve_dynamic_import_object_wrapper(
                &conditional.alternate,
                object_carriers,
                wrappers,
                identity,
            ),
        ),
        Expression::LogicalExpression(logical) => merge_object_wrappers(
            resolve_dynamic_import_object_wrapper(
                &logical.left,
                object_carriers,
                wrappers,
                identity,
            ),
            resolve_dynamic_import_object_wrapper(
                &logical.right,
                object_carriers,
                wrappers,
                identity,
            ),
        ),
        _ => None,
    }
}

fn resolve_dynamic_import_object_wrapper_from_call(
    call: &CallExpression<'_>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    match &call.callee {
        Expression::Identifier(identifier) => identity
            .key_of_reference(identifier)
            .and_then(|binding| wrappers.object_factories.get(&binding).cloned())
            .or_else(|| {
                (call.arguments.len() == 1)
                    .then(|| call.arguments[0].as_expression())
                    .flatten()
                    .and_then(|argument| {
                        resolve_dynamic_import_object_wrapper(
                            argument,
                            object_carriers,
                            wrappers,
                            identity,
                        )
                    })
            }),
        callee if is_member_expression(callee) => {
            if let Some(wrapper) = resolve_dynamic_import_object_wrapper(
                member_object(callee)?,
                object_carriers,
                wrappers,
                identity,
            ) {
                if matches!(member_property_name(callee)?.as_str(), "find" | "at") {
                    return Some(wrapper);
                }
            }
            if call.arguments.len() == 1 {
                resolve_dynamic_import_object_wrapper(
                    call.arguments[0].as_expression()?,
                    object_carriers,
                    wrappers,
                    identity,
                )
            } else {
                None
            }
        }
        _ if call.arguments.len() == 1 => resolve_dynamic_import_object_wrapper(
            call.arguments[0].as_expression()?,
            object_carriers,
            wrappers,
            identity,
        ),
        _ => None,
    }
}

fn resolve_dynamic_import_object_wrapper_from_member(
    member: &Expression<'_>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    let wrapper = resolve_dynamic_import_object_wrapper(
        member_object(member)?,
        object_carriers,
        wrappers,
        identity,
    )?;
    member_is_literal_computed(member).then_some(wrapper)
}

pub(crate) fn collect_wrapper_module_ids(
    wrapper: &DynamicImportObjectWrapper,
) -> Option<BTreeSet<String>> {
    let mut module_ids = BTreeSet::new();
    for ids in wrapper.values() {
        module_ids.extend(ids.iter().cloned());
    }
    (!module_ids.is_empty()).then_some(module_ids)
}

fn merge_object_wrappers(
    left: Option<DynamicImportObjectWrapper>,
    right: Option<DynamicImportObjectWrapper>,
) -> Option<DynamicImportObjectWrapper> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            merge_wrapper_map_into(&mut left, right);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}
