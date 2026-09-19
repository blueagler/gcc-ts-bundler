//! Resolve dynamic-import module ids from wrapper-flow expressions.

use std::collections::BTreeSet;

use oxc_ast::ast::{CallExpression, Expression};

use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use super::dynamic_import_module_ids_from_call;
use super::members::{is_member_expression, member_object, member_property_name};
use super::object::{collect_wrapper_module_ids, resolve_dynamic_import_object_wrapper};
use crate::transpile::identity::{BindingKeyMap, ModuleIdentity};

pub(crate) fn resolve_dynamic_import_module_ids(
    expression: &Expression<'_>,
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    resolve_dynamic_import_module_ids_with_options(
        expression,
        carriers,
        object_carriers,
        wrappers,
        identity,
        true,
    )
}

pub(crate) fn resolve_dynamic_import_module_ids_strict(
    expression: &Expression<'_>,
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    resolve_dynamic_import_module_ids_with_options(
        expression,
        carriers,
        object_carriers,
        wrappers,
        identity,
        false,
    )
}

fn resolve_dynamic_import_module_ids_with_options(
    expression: &Expression<'_>,
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
    allow_passthrough_calls: bool,
) -> Option<BTreeSet<String>> {
    match expression {
        Expression::Identifier(identifier) => identity
            .key_of_reference(identifier)
            .and_then(|binding| carriers.get(&binding).cloned()),
        Expression::CallExpression(call) => resolve_dynamic_import_call_module_ids(
            call,
            carriers,
            object_carriers,
            wrappers,
            identity,
            allow_passthrough_calls,
        ),
        Expression::ParenthesizedExpression(parenthesized) => {
            resolve_dynamic_import_module_ids_with_options(
                &parenthesized.expression,
                carriers,
                object_carriers,
                wrappers,
                identity,
                allow_passthrough_calls,
            )
        }
        Expression::ConditionalExpression(conditional) => merge_dynamic_import_module_ids(
            resolve_dynamic_import_module_ids_with_options(
                &conditional.consequent,
                carriers,
                object_carriers,
                wrappers,
                identity,
                allow_passthrough_calls,
            ),
            resolve_dynamic_import_module_ids_with_options(
                &conditional.alternate,
                carriers,
                object_carriers,
                wrappers,
                identity,
                allow_passthrough_calls,
            ),
        ),
        _ => None,
    }
}

fn resolve_dynamic_import_call_module_ids(
    call: &CallExpression<'_>,
    carriers: &BindingKeyMap<BTreeSet<String>>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
    allow_passthrough_calls: bool,
) -> Option<BTreeSet<String>> {
    if let Some(module_ids) = dynamic_import_module_ids_from_call(call, identity) {
        return Some(module_ids);
    }

    match &call.callee {
        Expression::Identifier(identifier) if call.arguments.is_empty() => identity
            .key_of_reference(identifier)
            .and_then(|binding| wrappers.functions.get(&binding).cloned()),
        callee if is_member_expression(callee) && call.arguments.is_empty() => {
            collect_member_wrapper_module_ids(callee, object_carriers, wrappers, identity)
        }
        _ if allow_passthrough_calls && call.arguments.len() == 1 => {
            let argument = call.arguments[0].as_expression()?;
            merge_dynamic_import_module_ids(
                resolve_dynamic_import_module_ids_with_options(
                    argument,
                    carriers,
                    object_carriers,
                    wrappers,
                    identity,
                    allow_passthrough_calls,
                ),
                resolve_dynamic_import_object_wrapper(
                    argument,
                    object_carriers,
                    wrappers,
                    identity,
                )
                .and_then(|wrapper| collect_wrapper_module_ids(&wrapper)),
            )
        }
        callee if is_member_expression(callee) => {
            if let Some(wrapper) = resolve_dynamic_import_object_wrapper(
                member_object(callee)?,
                object_carriers,
                wrappers,
                identity,
            ) {
                if call.arguments.is_empty() {
                    return wrapper.get(&member_property_name(callee)?).cloned();
                }
            }
            None
        }
        _ => None,
    }
}

fn collect_member_wrapper_module_ids(
    member: &Expression<'_>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    let wrapper = resolve_dynamic_import_object_wrapper(
        member_object(member)?,
        object_carriers,
        wrappers,
        identity,
    )?;
    if let Some(property) = member_property_name(member) {
        wrapper.get(&property).cloned()
    } else {
        collect_wrapper_module_ids(&wrapper)
    }
}

fn merge_dynamic_import_module_ids(
    left: Option<BTreeSet<String>>,
    right: Option<BTreeSet<String>>,
) -> Option<BTreeSet<String>> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.extend(right);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}
