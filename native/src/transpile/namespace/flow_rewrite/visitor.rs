//! BundlerRuntimeNamespaceVisitor rewrite helpers.

use std::collections::BTreeSet;

use oxc_ast::ast::*;
use oxc_ast_visit::VisitMut;
use oxc_span::SPAN;
use oxc_syntax::number::NumberBase;

use super::super::flow_helpers::{print_node, property_key_name, single_return_argument};
use super::super::flow_visitors::BundlerRuntimeNamespaceVisitor;
use super::super::wrappers::resolve_dynamic_import_module_ids;
use crate::transpile::identity::BindingKey;

impl<'a> BundlerRuntimeNamespaceVisitor<'a, '_> {
    pub(crate) fn push_error(&mut self, message: impl Into<String>) {
        self.errors
            .push(format!("{}: {}", self.file_path.display(), message.into()));
    }

    pub(crate) fn reify(&mut self, module_ids: &BTreeSet<String>, expression: &Expression<'a>) {
        let rendered = print_node(expression);
        for module_id in module_ids {
            self.reifications
                .entry(module_id.clone())
                .or_insert_with(|| {
                    format!(
                        "reified namespace {module_id} for dynamic member access at {}:{rendered}",
                        self.file_path.display()
                    )
                });
        }
    }

    pub(crate) fn reify_binding(&mut self, binding: BindingKey, expression: &Expression<'a>) {
        if let Some(module_ids) = self.namespace_bindings.get(&binding).cloned() {
            self.reify(&module_ids, expression);
        } else if let Some(module_id) = self.direct_namespace_targets.get(&binding).cloned() {
            self.reify(&BTreeSet::from([module_id]), expression);
        }
    }

    pub(crate) fn namespace_binding(&self, expression: &Expression<'a>) -> Option<BindingKey> {
        let Expression::Identifier(identifier) = expression else {
            return None;
        };
        self.identity
            .key_of_reference(identifier)
            .filter(|binding| {
                self.namespace_bindings.contains_key(binding)
                    || self.direct_namespace_targets.contains_key(binding)
            })
    }

    pub(crate) fn reify_namespace_value(&mut self, expression: &Expression<'a>) {
        if let Some(binding) = self.namespace_binding(expression) {
            self.reify_binding(binding, expression);
        }
    }

    pub(crate) fn module_ids_for_promise(
        &self,
        expression: &Expression<'a>,
    ) -> Option<BTreeSet<String>> {
        resolve_dynamic_import_module_ids(
            expression,
            &self.promise_carriers,
            &self.object_carriers,
            &self.wrappers,
            self.identity,
        )
    }

    pub(crate) fn module_ids_for_namespace(
        &self,
        expression: &Expression<'a>,
    ) -> Option<BTreeSet<String>> {
        match expression {
            Expression::Identifier(identifier) => self
                .identity
                .key_of_reference(identifier)
                .and_then(|binding| self.namespace_bindings.get(&binding).cloned()),
            Expression::AwaitExpression(await_expression) => {
                self.module_ids_for_promise(&await_expression.argument)
            }
            Expression::CallExpression(call) if call.arguments.len() == 1 => call.arguments[0]
                .as_expression()
                .and_then(|expression| self.module_ids_for_namespace(expression)),
            Expression::ParenthesizedExpression(parenthesized) => {
                self.module_ids_for_namespace(&parenthesized.expression)
            }
            _ => None,
        }
    }

    pub(crate) fn slot_for_module_ids(
        &self,
        module_ids: &BTreeSet<String>,
        export_name: &str,
    ) -> std::result::Result<usize, String> {
        let mut resolved = None;
        for module_id in module_ids {
            let logical_id = self
                .context
                .bundler_runtime_logical_ids
                .get(module_id)
                .map(String::as_str)
                .unwrap_or(module_id);
            let slots = self
                .context
                .bundler_module_slots
                .get(logical_id)
                .ok_or_else(|| {
                    format!("Missing bundler-runtime export slot metadata for {module_id}")
                })?;
            let slot = slots.slot_for(export_name).ok_or_else(|| {
                format!(
                    "bundler-runtime cannot rewrite namespace access for export {:?} from {}",
                    export_name, module_id
                )
            })?;
            if resolved.is_some_and(|existing| existing != slot) {
                return Err(format!(
                    "bundler-runtime cannot rewrite namespace access for export {:?} because slot assignments diverge across dynamic import targets",
                    export_name
                ));
            }
            resolved = Some(slot);
        }
        resolved.ok_or_else(|| "Missing bundler-runtime namespace slots".to_string())
    }

    pub(crate) fn rewrite_namespace_pattern(
        &mut self,
        pattern: &mut BindingPattern<'a>,
        module_ids: &BTreeSet<String>,
    ) -> bool {
        match pattern {
            BindingPattern::BindingIdentifier(binding) => {
                self.namespace_bindings
                    .insert(self.identity.key_of_binding(binding), module_ids.clone());
                true
            }
            BindingPattern::ObjectPattern(object) if object.rest.is_none() => {
                let slots = object
                    .properties
                    .iter()
                    .map(|property| {
                        property_key_name(&property.key)
                            .and_then(|name| self.slot_for_module_ids(module_ids, &name).ok())
                    })
                    .collect::<Option<Vec<_>>>();
                let Some(slots) = slots else {
                    return false;
                };
                for (property, slot) in object.properties.iter_mut().zip(slots) {
                    property.key = PropertyKey::new_numeric_literal(
                        SPAN,
                        slot as f64,
                        None,
                        NumberBase::Decimal,
                        &self.builder,
                    );
                    property.computed = false;
                    property.shorthand = false;
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) fn promise_from_supplier(
        &self,
        expression: &Expression<'a>,
    ) -> Option<BTreeSet<String>> {
        match expression {
            Expression::ArrowFunctionExpression(arrow) if arrow.params.items.is_empty() => {
                if let Some(expression) = arrow.get_expression() {
                    self.module_ids_for_promise(expression)
                } else {
                    single_return_argument(&arrow.body)
                        .and_then(|argument| self.module_ids_for_promise(argument))
                }
            }
            Expression::FunctionExpression(function)
                if function.params.items.is_empty() && function.params.rest.is_none() =>
            {
                function
                    .body
                    .as_ref()
                    .and_then(|body| single_return_argument(body))
                    .and_then(|argument| self.module_ids_for_promise(argument))
            }
            _ => None,
        }
    }

    pub(crate) fn visit_callback_with_namespace(
        &mut self,
        expression: &mut Expression<'a>,
        module_ids: &BTreeSet<String>,
        first: bool,
    ) {
        match expression {
            Expression::ArrowFunctionExpression(arrow) => {
                let parameter = if first {
                    arrow.params.items.first_mut()
                } else {
                    arrow.params.items.last_mut()
                };
                let Some(parameter) = parameter else {
                    self.visit_expression(expression);
                    return;
                };
                let mut inserted = Vec::new();
                if let BindingPattern::BindingIdentifier(binding) = &parameter.pattern {
                    let key = self.identity.key_of_binding(binding);
                    self.namespace_bindings.insert(key, module_ids.clone());
                    inserted.push(key);
                } else if !self.rewrite_namespace_pattern(&mut parameter.pattern, module_ids) {
                    return;
                }
                if let Some(body) = arrow.get_expression_mut() {
                    self.visit_expression(body);
                } else {
                    self.visit_function_body(&mut arrow.body);
                }
                for binding in inserted {
                    self.namespace_bindings.remove(&binding);
                }
            }
            Expression::FunctionExpression(function) => {
                let parameter = if first {
                    function.params.items.first_mut()
                } else {
                    function.params.items.last_mut()
                };
                let Some(parameter) = parameter else {
                    self.visit_expression(expression);
                    return;
                };
                let mut inserted = Vec::new();
                if let BindingPattern::BindingIdentifier(binding) = &parameter.pattern {
                    let key = self.identity.key_of_binding(binding);
                    self.namespace_bindings.insert(key, module_ids.clone());
                    inserted.push(key);
                } else if !self.rewrite_namespace_pattern(&mut parameter.pattern, module_ids) {
                    return;
                }
                if let Some(body) = &mut function.body {
                    self.visit_function_body(body);
                }
                for binding in inserted {
                    self.namespace_bindings.remove(&binding);
                }
            }
            _ => self.visit_expression(expression),
        }
    }
}
