//! Oxc namespace-slot rewriting for bundler-runtime emission.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Str;
use oxc_syntax::number::NumberBase;
use oxc_syntax::operator::AssignmentOperator;

use super::wrappers_oxc::{
    collect_dynamic_import_object_carriers, collect_dynamic_import_promise_carriers,
    collect_dynamic_import_wrappers, resolve_dynamic_import_module_ids, DynamicImportObjectWrapper,
    DynamicImportWrappers,
};
use crate::transpile::emit_runtime_oxc::binding_names_with_ids;
use crate::transpile::identity_oxc::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use crate::transpile::{
    resolve_module_id_for_specifier, to_bundler_runtime_module_id, HoistPlan, TranspileContext,
};

pub(crate) fn rewrite_bundler_runtime_namespace_usage<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<(), String> {
    rewrite_namespace_usage(allocator, program, identity, file_path, context, None)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn rewrite_hoisted_namespace_usage<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
    consumer_module_id: &str,
    direct_namespace_ids: &BindingKeySet,
    lexical_binding_names: &HashSet<String>,
) -> std::result::Result<(), String> {
    rewrite_namespace_usage(
        allocator,
        program,
        identity,
        file_path,
        context,
        Some(HoistNamespaceInfo {
            consumer_module_id,
            direct_namespace_ids,
            lexical_binding_names,
            plan,
        }),
    )
}

fn rewrite_namespace_usage<'a, 'i>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &'i ModuleIdentity,
    file_path: &Path,
    context: &'i TranspileContext,
    hoist: Option<HoistNamespaceInfo<'i>>,
) -> std::result::Result<(), String> {
    let wrappers = collect_dynamic_import_wrappers(program, identity);
    let object_carriers = collect_dynamic_import_object_carriers(program, &wrappers, identity);
    let promise_carriers =
        collect_dynamic_import_promise_carriers(program, &object_carriers, &wrappers, identity);
    let mut visitor = BundlerRuntimeNamespaceVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        context,
        direct_namespace_targets: HashMap::new(),
        errors: Vec::new(),
        file_path: file_path.to_path_buf(),
        hoist,
        identity,
        namespace_bindings: HashMap::new(),
        object_carriers,
        promise_carriers,
        wrappers,
    };
    visitor.visit_program(program);
    if visitor.errors.is_empty() {
        Ok(())
    } else {
        Err(visitor.errors.join("\n"))
    }
}

struct HoistNamespaceInfo<'i> {
    consumer_module_id: &'i str,
    direct_namespace_ids: &'i BindingKeySet,
    lexical_binding_names: &'i HashSet<String>,
    plan: &'i HoistPlan,
}

struct BundlerRuntimeNamespaceVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    context: &'i TranspileContext,
    direct_namespace_targets: BindingKeyMap<String>,
    errors: Vec<String>,
    file_path: std::path::PathBuf,
    hoist: Option<HoistNamespaceInfo<'i>>,
    identity: &'i ModuleIdentity,
    namespace_bindings: BindingKeyMap<BTreeSet<String>>,
    object_carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    promise_carriers: BindingKeyMap<BTreeSet<String>>,
    wrappers: DynamicImportWrappers,
}

impl<'a> BundlerRuntimeNamespaceVisitor<'a, '_> {
    fn push_error(&mut self, message: impl Into<String>) {
        self.errors
            .push(format!("{}: {}", self.file_path.display(), message.into()));
    }

    fn module_ids_for_promise(&self, expression: &Expression<'a>) -> Option<BTreeSet<String>> {
        resolve_dynamic_import_module_ids(
            expression,
            &self.promise_carriers,
            &self.object_carriers,
            &self.wrappers,
            self.identity,
        )
    }

    fn module_ids_for_namespace(&self, expression: &Expression<'a>) -> Option<BTreeSet<String>> {
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

    fn slot_for_module_ids(
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

    fn rewrite_namespace_pattern(
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
            BindingPattern::ObjectPattern(object) => {
                for property in &mut object.properties {
                    let Some(export_name) = property_key_name(&property.key) else {
                        self.push_error(
                            "bundler-runtime only supports literal namespace destructuring keys",
                        );
                        return false;
                    };
                    let Ok(slot) = self.slot_for_module_ids(module_ids, &export_name) else {
                        self.push_error(format!(
                            "bundler-runtime cannot destructure namespace export {:?}",
                            export_name
                        ));
                        return false;
                    };
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
                if object.rest.is_some() {
                    self.push_error(
                        "bundler-runtime does not support namespace rest destructuring",
                    );
                    return false;
                }
                true
            }
            _ => {
                self.push_error(
                    "bundler-runtime only supports identifier and object destructuring for namespace values",
                );
                false
            }
        }
    }

    fn promise_from_supplier(&self, expression: &Expression<'a>) -> Option<BTreeSet<String>> {
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

    fn visit_callback_with_namespace(
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

    fn rewrite_member_expression(&mut self, expression: &mut Expression<'a>) -> bool {
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
            self.push_error("bundler-runtime does not support computed namespace property access");
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

    fn rewrite_direct_namespace_member(&mut self, expression: &mut Expression<'a>) -> bool {
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
            self.push_error("bundler-runtime does not support computed namespace property access");
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

impl<'a> VisitMut<'a> for BundlerRuntimeNamespaceVisitor<'a, '_> {
    fn visit_program(&mut self, program: &mut Program<'a>) {
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            let Ok(module_id) = resolve_module_id_for_specifier(
                &self.file_path,
                import.source.value.as_str(),
                self.context,
            ) else {
                continue;
            };
            for specifier in import.specifiers.iter().flatten() {
                if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) = specifier {
                    let binding = self.identity.key_of_binding(&namespace.local);
                    if self
                        .hoist
                        .as_ref()
                        .is_some_and(|hoist| hoist.direct_namespace_ids.contains(&binding))
                    {
                        self.direct_namespace_targets
                            .insert(binding, module_id.clone());
                    } else {
                        self.namespace_bindings
                            .insert(binding, BTreeSet::from([module_id.clone()]));
                    }
                }
            }
        }
        walk_mut::walk_program(self, program);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if self.rewrite_direct_namespace_member(expression) {
            return;
        }
        walk_mut::walk_expression(self, expression);
        self.rewrite_member_expression(expression);
    }

    fn visit_variable_declarator(&mut self, declarator: &mut VariableDeclarator<'a>) {
        walk_mut::walk_variable_declarator(self, declarator);
        let Some(initializer) = &declarator.init else {
            return;
        };
        if let Some(module_ids) = self.module_ids_for_namespace(initializer) {
            self.rewrite_namespace_pattern(&mut declarator.id, &module_ids);
            return;
        }
        let Some(module_ids) = self.module_ids_for_promise(initializer) else {
            return;
        };
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            self.push_error(
                "bundler-runtime only supports binding promise-like import values to identifiers",
            );
            return;
        };
        self.promise_carriers
            .insert(self.identity.key_of_binding(binding), module_ids);
    }

    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        let promise_from_then = member_call_parts(&call.callee).and_then(|(object, property)| {
            (property == "then")
                .then(|| self.module_ids_for_promise(object))
                .flatten()
        });
        let suppliers = call
            .arguments
            .iter()
            .enumerate()
            .filter_map(|(index, argument)| {
                argument
                    .as_expression()
                    .and_then(|expression| self.promise_from_supplier(expression))
                    .map(|module_ids| (index, module_ids))
            })
            .collect::<Vec<_>>();

        self.visit_expression(&mut call.callee);
        for (index, argument) in call.arguments.iter_mut().enumerate() {
            let Some(expression) = argument.as_expression_mut() else {
                walk_mut::walk_argument(self, argument);
                continue;
            };
            if index == 0 {
                if let Some(module_ids) = &promise_from_then {
                    self.visit_callback_with_namespace(expression, module_ids, true);
                    continue;
                }
            }
            if let Some((_, module_ids)) = suppliers
                .iter()
                .find(|(source_index, _)| *source_index != index)
            {
                self.visit_callback_with_namespace(expression, module_ids, false);
                continue;
            }
            self.visit_expression(expression);
        }

        if let Some((object, method)) = member_call_parts(&call.callee) {
            if matches!(object, Expression::Identifier(identifier)
                if identifier.name == "Object" && self.identity.is_global(identifier))
                && matches!(method.as_str(), "assign" | "entries" | "keys" | "values")
                && call.arguments.iter().any(|argument| {
                    argument.as_expression().is_some_and(|expression| {
                        matches!(expression, Expression::Identifier(identifier)
                            if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)))
                    })
                })
            {
                self.push_error(
                    "bundler-runtime does not support reflective Object.* operations on module namespace values",
                );
            }
        }

        let passthrough = call.arguments.len() == 1
            && call.arguments[0].as_expression().is_some_and(|expression| {
                matches!(expression, Expression::Identifier(identifier)
                    if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)))
            });
        if !passthrough
            && call.arguments.iter().any(|argument| {
                argument.as_expression().is_some_and(|expression| {
                    matches!(expression, Expression::Identifier(identifier)
                        if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)))
                })
            })
        {
            self.push_error(
                "bundler-runtime does not support passing module namespace values to calls",
            );
        }
    }

    fn visit_return_statement(&mut self, statement: &mut ReturnStatement<'a>) {
        walk_mut::walk_return_statement(self, statement);
        if statement.argument.as_ref().is_some_and(|argument| {
            matches!(argument, Expression::Identifier(identifier)
                if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)))
        }) {
            self.push_error(
                "bundler-runtime does not support returning module namespace values",
            );
        }
    }

    fn visit_assignment_expression(&mut self, assignment: &mut AssignmentExpression<'a>) {
        walk_mut::walk_assignment_expression(self, assignment);
        let stores_namespace = matches!(&assignment.right, Expression::Identifier(identifier)
            if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)));
        if let AssignmentTarget::AssignmentTargetIdentifier(identifier) = &assignment.left {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                self.namespace_bindings.remove(&binding);
                let module_ids = (assignment.operator == AssignmentOperator::Assign)
                    .then(|| self.module_ids_for_promise(&assignment.right))
                    .flatten();
                if let Some(module_ids) = module_ids {
                    self.promise_carriers.insert(binding, module_ids);
                } else {
                    self.promise_carriers.remove(&binding);
                }
            }
        } else {
            remove_assignment_target_carriers(
                &assignment.left,
                self.identity,
                &mut self.namespace_bindings,
            );
            remove_assignment_target_carriers(
                &assignment.left,
                self.identity,
                &mut self.promise_carriers,
            );
        }
        if stores_namespace {
            self.push_error(
                "bundler-runtime does not support reassigning or storing module namespace values",
            );
        }
    }

    fn visit_update_expression(&mut self, update: &mut UpdateExpression<'a>) {
        walk_mut::walk_update_expression(self, update);
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = &update.argument {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                self.namespace_bindings.remove(&binding);
                self.promise_carriers.remove(&binding);
            }
        }
    }

    fn visit_for_in_statement(&mut self, statement: &mut ForInStatement<'a>) {
        walk_mut::walk_for_in_statement(self, statement);
        let iterates_namespace = matches!(&statement.right, Expression::Identifier(identifier)
            if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)));
        remove_for_left_carriers(&statement.left, self.identity, &mut self.namespace_bindings);
        remove_for_left_carriers(&statement.left, self.identity, &mut self.promise_carriers);
        if iterates_namespace {
            self.push_error(
                "bundler-runtime does not support iterating over module namespace values",
            );
        }
    }

    fn visit_for_of_statement(&mut self, statement: &mut ForOfStatement<'a>) {
        walk_mut::walk_for_of_statement(self, statement);
        let iterates_namespace = matches!(&statement.right, Expression::Identifier(identifier)
            if self.identity.key_of_reference(identifier).is_some_and(|binding| self.namespace_bindings.contains_key(&binding)));
        remove_for_left_carriers(&statement.left, self.identity, &mut self.namespace_bindings);
        remove_for_left_carriers(&statement.left, self.identity, &mut self.promise_carriers);
        if iterates_namespace {
            self.push_error(
                "bundler-runtime does not support iterating over module namespace values",
            );
        }
    }
}

fn single_return_argument<'b, 'a>(body: &'b FunctionBody<'a>) -> Option<&'b Expression<'a>> {
    let [Statement::ReturnStatement(statement)] = body.statements.as_slice() else {
        return None;
    };
    statement.argument.as_ref()
}

fn property_key_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        PropertyKey::NumericLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn computed_property_name(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        Expression::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            template.quasis[0]
                .value
                .cooked
                .as_ref()
                .map(ToString::to_string)
        }
        _ => None,
    }
}

fn member_call_parts<'b, 'a>(
    expression: &'b Expression<'a>,
) -> Option<(&'b Expression<'a>, String)> {
    match expression {
        Expression::StaticMemberExpression(member) => {
            Some((&member.object, member.property.name.to_string()))
        }
        Expression::ComputedMemberExpression(member) => {
            computed_property_name(&member.expression).map(|property| (&member.object, property))
        }
        _ => None,
    }
}

fn remove_for_left_carriers<T>(
    left: &ForStatementLeft<'_>,
    identity: &ModuleIdentity,
    carriers: &mut BindingKeyMap<T>,
) {
    if let ForStatementLeft::VariableDeclaration(declaration) = left {
        for declarator in &declaration.declarations {
            for (binding, _) in binding_names_with_ids(&declarator.id, identity) {
                carriers.remove(&binding);
            }
        }
    } else if let Some(target) = left.as_assignment_target() {
        remove_assignment_target_carriers(target, identity, carriers);
    }
}

fn remove_assignment_target_carriers<T>(
    target: &AssignmentTarget<'_>,
    identity: &ModuleIdentity,
    carriers: &mut BindingKeyMap<T>,
) {
    if let Some(simple) = target.as_simple_assignment_target() {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = simple {
            if let Some(binding) = identity.key_of_reference(identifier) {
                carriers.remove(&binding);
            }
        }
        return;
    }
    match target {
        AssignmentTarget::ArrayAssignmentTarget(array) => {
            for element in array.elements.iter().flatten() {
                remove_maybe_default_carriers(element, identity, carriers);
            }
            if let Some(rest) = &array.rest {
                remove_assignment_target_carriers(&rest.target, identity, carriers);
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
                        remove_maybe_default_carriers(&property.binding, identity, carriers);
                    }
                }
            }
            if let Some(rest) = &object.rest {
                remove_assignment_target_carriers(&rest.target, identity, carriers);
            }
        }
        _ => {}
    }
}

fn remove_maybe_default_carriers<T>(
    target: &AssignmentTargetMaybeDefault<'_>,
    identity: &ModuleIdentity,
    carriers: &mut BindingKeyMap<T>,
) {
    match target {
        AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
            remove_assignment_target_carriers(&default.binding, identity, carriers);
        }
        _ => remove_assignment_target_carriers(target.to_assignment_target(), identity, carriers),
    }
}
