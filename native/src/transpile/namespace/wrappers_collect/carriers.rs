//! Object and promise carrier walks for dynamic-import analysis.

use std::collections::{BTreeSet, HashMap};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_syntax::operator::AssignmentOperator;

use super::super::wrappers_rewrite::{
    resolve_dynamic_import_module_ids_strict, resolve_dynamic_import_object_wrapper,
};
use super::super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
use super::helpers::{
    collect_flow_storage_cells, remove_assignment_target_carriers,
    remove_for_statement_left_carriers, remove_simple_assignment_target_carrier,
};
use crate::transpile::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};

pub(crate) fn collect_dynamic_import_promise_carriers(
    program: &Program<'_>,
    object_carriers: &BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> BindingKeyMap<BTreeSet<String>> {
    let storage_cells = collect_flow_storage_cells(program, identity);
    let mut collector = PromiseCarrierCollector {
        carriers: HashMap::new(),
        object_carriers: object_carriers.clone(),
        wrappers: wrappers.clone(),
        identity,
        storage_cells,
    };
    collector.visit_program(program);
    collector.carriers
}

pub(crate) fn collect_dynamic_import_object_carriers(
    program: &Program<'_>,
    wrappers: &DynamicImportWrappers,
    identity: &ModuleIdentity,
) -> BindingKeyMap<DynamicImportObjectWrapper> {
    let mut collector = ObjectCarrierCollector {
        carriers: HashMap::new(),
        wrappers: wrappers.clone(),
        identity,
        storage_cells: collect_flow_storage_cells(program, identity),
    };
    collector.visit_program(program);
    collector.carriers
}

#[derive(Clone)]
struct PromiseCarrierCollector<'a> {
    carriers: BindingKeyMap<BTreeSet<String>>,
    object_carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
    storage_cells: BindingKeySet,
}

impl PromiseCarrierCollector<'_> {
    fn module_ids_for_promise_expr(&self, expression: &Expression<'_>) -> Option<BTreeSet<String>> {
        resolve_dynamic_import_module_ids_strict(
            expression,
            &self.carriers,
            &self.object_carriers,
            &self.wrappers,
            self.identity,
        )
    }
}

impl<'a> Visit<'a> for PromiseCarrierCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        walk::walk_variable_declarator(self, declarator);
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            return;
        };
        let binding = self.identity.key_of_binding(binding);
        let module_ids = declarator
            .init
            .as_ref()
            .and_then(|initializer| self.module_ids_for_promise_expr(initializer));
        if let Some(module_ids) = module_ids {
            self.carriers.insert(binding, module_ids);
        } else {
            self.carriers.remove(&binding);
        }
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        let Some(SimpleAssignmentTarget::AssignmentTargetIdentifier(target)) =
            assignment.left.as_simple_assignment_target()
        else {
            remove_assignment_target_carriers(&assignment.left, &mut self.carriers, self.identity);
            return;
        };
        let Some(binding) = self.identity.key_of_reference(target) else {
            return;
        };
        let module_ids = (assignment.operator == AssignmentOperator::Assign)
            .then(|| self.module_ids_for_promise_expr(&assignment.right))
            .flatten();
        if let Some(module_ids) = module_ids {
            self.carriers.insert(binding, module_ids);
        } else {
            self.carriers.remove(&binding);
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        if call.arguments.len() < 2 {
            return;
        }
        let Some(Expression::Identifier(carrier)) = call.arguments[0].as_expression() else {
            return;
        };
        let Some(carrier) = self.identity.key_of_reference(carrier) else {
            return;
        };
        if !self.storage_cells.contains(&carrier) {
            return;
        }
        let module_ids = call.arguments[1]
            .as_expression()
            .and_then(|expression| self.module_ids_for_promise_expr(expression));
        if let Some(module_ids) = module_ids {
            self.carriers.insert(carrier, module_ids);
        } else {
            self.carriers.remove(&carrier);
        }
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, update);
        remove_simple_assignment_target_carrier(
            &update.argument,
            &mut self.carriers,
            self.identity,
        );
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        walk::walk_for_in_statement(self, statement);
        remove_for_statement_left_carriers(&statement.left, &mut self.carriers, self.identity);
    }

    fn visit_for_of_statement(&mut self, statement: &ForOfStatement<'a>) {
        walk::walk_for_of_statement(self, statement);
        remove_for_statement_left_carriers(&statement.left, &mut self.carriers, self.identity);
    }
}

#[derive(Clone)]
struct ObjectCarrierCollector<'a> {
    carriers: BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
    storage_cells: BindingKeySet,
}

impl ObjectCarrierCollector<'_> {
    fn object_wrapper_for_expr(
        &self,
        expression: &Expression<'_>,
    ) -> Option<DynamicImportObjectWrapper> {
        resolve_dynamic_import_object_wrapper(
            expression,
            &self.carriers,
            &self.wrappers,
            self.identity,
        )
    }
}

impl<'a> Visit<'a> for ObjectCarrierCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        walk::walk_variable_declarator(self, declarator);
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            return;
        };
        let binding = self.identity.key_of_binding(binding);
        let wrapper = declarator
            .init
            .as_ref()
            .and_then(|initializer| self.object_wrapper_for_expr(initializer));
        if let Some(wrapper) = wrapper {
            self.carriers.insert(binding, wrapper);
        } else {
            self.carriers.remove(&binding);
        }
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        let Some(SimpleAssignmentTarget::AssignmentTargetIdentifier(target)) =
            assignment.left.as_simple_assignment_target()
        else {
            remove_assignment_target_carriers(&assignment.left, &mut self.carriers, self.identity);
            return;
        };
        let Some(binding) = self.identity.key_of_reference(target) else {
            return;
        };
        let wrapper = (assignment.operator == AssignmentOperator::Assign)
            .then(|| self.object_wrapper_for_expr(&assignment.right))
            .flatten();
        if let Some(wrapper) = wrapper {
            self.carriers.insert(binding, wrapper);
        } else {
            self.carriers.remove(&binding);
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        if call.arguments.len() < 2 {
            return;
        }
        let Some(Expression::Identifier(carrier)) = call.arguments[0].as_expression() else {
            return;
        };
        let Some(carrier) = self.identity.key_of_reference(carrier) else {
            return;
        };
        if !self.storage_cells.contains(&carrier) {
            return;
        }
        let wrapper = call.arguments[1]
            .as_expression()
            .and_then(|expression| self.object_wrapper_for_expr(expression));
        if let Some(wrapper) = wrapper {
            self.carriers.insert(carrier, wrapper);
        } else {
            self.carriers.remove(&carrier);
        }
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, update);
        remove_simple_assignment_target_carrier(
            &update.argument,
            &mut self.carriers,
            self.identity,
        );
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        walk::walk_for_in_statement(self, statement);
        remove_for_statement_left_carriers(&statement.left, &mut self.carriers, self.identity);
    }

    fn visit_for_of_statement(&mut self, statement: &ForOfStatement<'a>) {
        walk::walk_for_of_statement(self, statement);
        remove_for_statement_left_carriers(&statement.left, &mut self.carriers, self.identity);
    }
}
