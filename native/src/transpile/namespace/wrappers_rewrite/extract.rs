//! Extract helpers for dynamic-import wrapper-flow analysis.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use oxc_ast::ast::{
    ArrayExpression, ArrowFunctionExpression, CallExpression, Expression, Function,
    ObjectExpression, ObjectPropertyKind, PropertyKey, PropertyKind, Statement,
};

use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use super::resolve_dynamic_import_object_wrapper;
use crate::transpile::identity::ModuleIdentity;

pub(crate) fn extract_dynamic_import_module_ids_from_function(
    function: &Function<'_>,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    if !function.params.items.is_empty() || function.params.rest.is_some() {
        return None;
    }
    let body = function.body.as_ref()?;
    let [Statement::ReturnStatement(return_statement)] = body.statements.as_slice() else {
        return None;
    };
    extract_dynamic_import_module_ids_from_expr(return_statement.argument.as_ref()?, identity)
}

pub(crate) fn extract_dynamic_import_module_ids_from_expr(
    expression: &Expression<'_>,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    match expression {
        Expression::ArrowFunctionExpression(arrow) => {
            extract_dynamic_import_module_ids_from_arrow(arrow, identity)
        }
        Expression::FunctionExpression(function) => {
            extract_dynamic_import_module_ids_from_function(function, identity)
        }
        Expression::CallExpression(call) => dynamic_import_module_ids_from_call(call, identity),
        Expression::ParenthesizedExpression(parenthesized) => {
            extract_dynamic_import_module_ids_from_expr(&parenthesized.expression, identity)
        }
        _ => None,
    }
}

fn extract_dynamic_import_module_ids_from_arrow(
    arrow: &ArrowFunctionExpression<'_>,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    if !arrow.params.items.is_empty() || arrow.params.rest.is_some() {
        return None;
    }
    if let Some(expression) = arrow.get_expression() {
        return extract_dynamic_import_module_ids_from_expr(expression, identity);
    }
    let [Statement::ReturnStatement(return_statement)] =
        arrow.get_function_body()?.statements.as_slice()
    else {
        return None;
    };
    extract_dynamic_import_module_ids_from_expr(return_statement.argument.as_ref()?, identity)
}

pub(crate) fn extract_dynamic_import_object_wrappers(
    expression: &Expression<'_>,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    match expression {
        Expression::ObjectExpression(object) => {
            extract_dynamic_import_object_wrappers_from_object(object, identity)
        }
        Expression::ArrayExpression(array) => {
            extract_dynamic_import_object_wrappers_from_array(array, identity)
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            extract_dynamic_import_object_wrappers(&parenthesized.expression, identity)
        }
        _ => None,
    }
}

pub(crate) fn extract_dynamic_import_object_wrapper_from_callable_expr(
    expression: &Expression<'_>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    match expression {
        Expression::ArrowFunctionExpression(arrow) => {
            extract_dynamic_import_object_wrapper_from_arrow(arrow, wrappers, identity)
        }
        Expression::FunctionExpression(function) => {
            extract_dynamic_import_object_wrapper_from_function(function, wrappers, identity)
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            extract_dynamic_import_object_wrapper_from_callable_expr(
                &parenthesized.expression,
                wrappers,
                identity,
            )
        }
        _ => None,
    }
}

pub(crate) fn extract_dynamic_import_object_wrapper_from_function(
    function: &Function<'_>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    let body = function.body.as_ref()?;
    let argument = extract_wrapper_return_argument(&body.statements)?;
    resolve_dynamic_import_object_wrapper(argument, &HashMap::new(), wrappers, identity)
}

fn extract_dynamic_import_object_wrapper_from_arrow(
    arrow: &ArrowFunctionExpression<'_>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    if let Some(expression) = arrow.get_expression() {
        return resolve_dynamic_import_object_wrapper(
            expression,
            &HashMap::new(),
            wrappers,
            identity,
        );
    }
    let argument = extract_wrapper_return_argument(&arrow.get_function_body()?.statements)?;
    resolve_dynamic_import_object_wrapper(argument, &HashMap::new(), wrappers, identity)
}

fn extract_wrapper_return_argument<'a>(
    statements: &'a [Statement<'a>],
) -> Option<&'a Expression<'a>> {
    let (return_statement, prelude) = statements.split_last()?;
    if !prelude.iter().all(is_wrapper_prelude_statement) {
        return None;
    }
    let Statement::ReturnStatement(return_statement) = return_statement else {
        return None;
    };
    return_statement.argument.as_ref()
}

fn is_wrapper_prelude_statement(statement: &Statement<'_>) -> bool {
    let Statement::VariableDeclaration(declaration) = statement else {
        return false;
    };
    declaration
        .declarations
        .iter()
        .all(|declarator| declarator.init.is_none())
}

pub(crate) fn dynamic_import_module_ids_from_call(
    call: &CallExpression<'_>,
    identity: &ModuleIdentity,
) -> Option<BTreeSet<String>> {
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    if callee.name != "__dynamicImport" || !identity.is_global(callee) {
        return None;
    }
    let [argument] = call.arguments.as_slice() else {
        return None;
    };
    let Expression::StringLiteral(module_id) = argument.as_expression()? else {
        return None;
    };
    Some(BTreeSet::from([module_id.value.to_string()]))
}

fn extract_dynamic_import_object_wrappers_from_object(
    object: &ObjectExpression<'_>,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    let mut wrappers = BTreeMap::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        if property.kind != PropertyKind::Init || property.method || property.shorthand {
            continue;
        }
        let Some(property_name) = property_key_to_string(&property.key) else {
            continue;
        };
        let Some(module_ids) =
            extract_dynamic_import_module_ids_from_expr(&property.value, identity)
        else {
            continue;
        };
        wrappers.insert(property_name, module_ids);
    }
    (!wrappers.is_empty()).then_some(wrappers)
}

fn extract_dynamic_import_object_wrappers_from_array(
    array: &ArrayExpression<'_>,
    identity: &ModuleIdentity,
) -> Option<DynamicImportObjectWrapper> {
    let mut merged = BTreeMap::new();
    for element in &array.elements {
        let Some(expression) = element.as_expression() else {
            continue;
        };
        let Some(wrapper) = extract_dynamic_import_object_wrappers(expression, identity) else {
            continue;
        };
        merge_wrapper_map_into(&mut merged, wrapper);
    }
    (!merged.is_empty()).then_some(merged)
}

pub(crate) fn merge_wrapper_map_into(
    target: &mut DynamicImportObjectWrapper,
    wrapper: DynamicImportObjectWrapper,
) {
    for (property, module_ids) in wrapper {
        target.entry(property).or_default().extend(module_ids);
    }
}

fn property_key_to_string(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(value) => Some(value.value.to_string()),
        PropertyKey::NumericLiteral(value) => Some(value.value.to_string()),
        _ => None,
    }
}

pub(crate) fn literal_property_name(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::StringLiteral(value) => Some(value.value.to_string()),
        Expression::NumericLiteral(value) => Some(value.value.to_string()),
        _ => None,
    }
}
