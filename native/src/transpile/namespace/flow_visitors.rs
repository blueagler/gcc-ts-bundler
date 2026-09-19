//! Bundler-runtime namespace visitor.

use std::collections::{BTreeMap, BTreeSet};

use oxc_allocator::Allocator;

use oxc_ast::ast::{
    Argument, AssignmentExpression, AssignmentTarget, BindingPattern, CallExpression, Expression,
    ForInStatement, ForOfStatement, ImportDeclarationSpecifier, Program, ReturnStatement,
    SimpleAssignmentTarget, Statement, UnaryExpression, UpdateExpression, VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_syntax::operator::{AssignmentOperator, UnaryOperator};

use super::flow_helpers::{
    assignment_target_namespace_object, expression_namespace_object, member_call_parts,
    remove_assignment_target_carriers, remove_for_left_carriers,
    simple_assignment_target_namespace_object, HoistNamespaceInfo,
};
use super::wrappers::{DynamicImportObjectWrapper, DynamicImportWrappers};
use crate::transpile::identity::{BindingKeyMap, ModuleIdentity};
use crate::transpile::{resolve_module_id_for_specifier, TranspileContext};

pub(super) struct BundlerRuntimeNamespaceVisitor<'a, 'i> {
    pub(super) allocator: &'a Allocator,
    pub(super) builder: AstBuilder<'a>,
    pub(super) context: &'i TranspileContext,
    pub(super) direct_namespace_targets: BindingKeyMap<String>,
    pub(super) errors: Vec<String>,
    pub(super) file_path: std::path::PathBuf,
    pub(super) finite_property_bindings: BindingKeyMap<Vec<String>>,
    pub(super) hoist: Option<HoistNamespaceInfo<'i>>,
    pub(super) identity: &'i ModuleIdentity,
    pub(super) namespace_bindings: BindingKeyMap<BTreeSet<String>>,
    pub(super) object_carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(super) promise_carriers: BindingKeyMap<BTreeSet<String>>,
    pub(super) reifications: BTreeMap<String, String>,
    pub(super) wrappers: DynamicImportWrappers,
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
            if self.context.preserved_modules.contains_key(&module_id) {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) = specifier {
                    let binding = match ModuleIdentity::key_of_binding(&namespace.local) {
                        Ok(binding) => binding,
                        Err(error) => {
                            self.push_error(error);
                            return;
                        }
                    };
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
        if self.lower_finite_computed_member(expression) {
            self.visit_expression(expression);
            return;
        }
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
            if !self.rewrite_namespace_pattern(&mut declarator.id, &module_ids) {
                self.reify(&module_ids, initializer);
            }
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
        match ModuleIdentity::key_of_binding(binding) {
            Ok(binding) => {
                self.promise_carriers.insert(binding, module_ids);
            }
            Err(error) => self.push_error(error),
        }
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
            let mutates_first = matches!(object, Expression::Identifier(identifier)
                    if identifier.name == "Object" && self.identity.is_global(identifier))
                && matches!(
                    method.as_str(),
                    "assign" | "defineProperty" | "defineProperties"
                )
                || matches!(object, Expression::Identifier(identifier)
                    if identifier.name == "Reflect" && self.identity.is_global(identifier))
                    && matches!(method.as_str(), "set" | "deleteProperty" | "defineProperty");
            if mutates_first
                && call
                    .arguments
                    .first()
                    .and_then(Argument::as_expression)
                    .is_some_and(|expression| self.namespace_binding(expression).is_some())
            {
                self.push_error("bundler-runtime cannot mutate a read-only module namespace");
            }
        }
        for argument in &call.arguments {
            if let Some(expression) = argument.as_expression() {
                self.reify_namespace_value(expression);
            }
        }
    }

    fn visit_return_statement(&mut self, statement: &mut ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.reify_namespace_value(argument);
        }
        walk_mut::walk_return_statement(self, statement);
    }

    fn visit_assignment_expression(&mut self, assignment: &mut AssignmentExpression<'a>) {
        if assignment_target_namespace_object(&assignment.left)
            .and_then(|object| self.namespace_binding(object))
            .is_some()
        {
            self.push_error("bundler-runtime cannot mutate a read-only module namespace");
        }
        self.reify_namespace_value(&assignment.right);
        walk_mut::walk_assignment_expression(self, assignment);
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
    }

    fn visit_unary_expression(&mut self, unary: &mut UnaryExpression<'a>) {
        if unary.operator == UnaryOperator::Delete
            && expression_namespace_object(&unary.argument)
                .and_then(|object| self.namespace_binding(object))
                .is_some()
        {
            self.push_error("bundler-runtime cannot mutate a read-only module namespace");
        }
        walk_mut::walk_unary_expression(self, unary);
    }

    fn visit_update_expression(&mut self, update: &mut UpdateExpression<'a>) {
        if simple_assignment_target_namespace_object(&update.argument)
            .and_then(|object| self.namespace_binding(object))
            .is_some()
        {
            self.push_error("bundler-runtime cannot mutate a read-only module namespace");
        }
        walk_mut::walk_update_expression(self, update);
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = &update.argument {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                self.namespace_bindings.remove(&binding);
                self.promise_carriers.remove(&binding);
            }
        }
    }

    fn visit_for_in_statement(&mut self, statement: &mut ForInStatement<'a>) {
        self.reify_namespace_value(&statement.right);
        walk_mut::walk_for_in_statement(self, statement);
        if let Err(error) =
            remove_for_left_carriers(&statement.left, self.identity, &mut self.namespace_bindings)
        {
            self.push_error(error);
        }
        if let Err(error) =
            remove_for_left_carriers(&statement.left, self.identity, &mut self.promise_carriers)
        {
            self.push_error(error);
        }
    }

    fn visit_for_of_statement(&mut self, statement: &mut ForOfStatement<'a>) {
        self.reify_namespace_value(&statement.right);
        walk_mut::walk_for_of_statement(self, statement);
        if let Err(error) =
            remove_for_left_carriers(&statement.left, self.identity, &mut self.namespace_bindings)
        {
            self.push_error(error);
        }
        if let Err(error) =
            remove_for_left_carriers(&statement.left, self.identity, &mut self.promise_carriers)
        {
            self.push_error(error);
        }
    }
}
