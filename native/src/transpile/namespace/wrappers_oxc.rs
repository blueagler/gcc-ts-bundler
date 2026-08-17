//! Oxc read-only wrapper-flow analysis for dynamic-import carriers.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_syntax::operator::AssignmentOperator;

use crate::transpile::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};

#[derive(Clone, Debug, Default)]
pub(crate) struct DynamicImportWrappers {
    pub(crate) function_wrappers: BindingKeyMap<BTreeSet<String>>,
    pub(crate) object_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(crate) object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
}

pub(crate) type DynamicImportObjectWrapper = BTreeMap<String, BTreeSet<String>>;

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

fn resolve_dynamic_import_module_ids_strict(
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

fn collect_flow_storage_cells(program: &Program<'_>, identity: &ModuleIdentity) -> BindingKeySet {
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

fn remove_assignment_target_carriers<T>(
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

fn remove_simple_assignment_target_carrier<T>(
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

fn remove_for_statement_left_carriers<T>(
    left: &ForStatementLeft<'_>,
    carriers: &mut BindingKeyMap<T>,
    identity: &ModuleIdentity,
) {
    if let Some(target) = left.as_assignment_target() {
        remove_assignment_target_carriers(target, carriers, identity);
    }
}

pub(crate) fn collect_dynamic_import_wrappers(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> DynamicImportWrappers {
    let mut collector = DynamicImportWrapperCollector {
        identity,
        wrappers: DynamicImportWrappers::default(),
    };
    collector.visit_program(program);

    let mut wrappers = collector.wrappers;
    let mut object_function_wrappers = HashMap::new();
    loop {
        let mut collector = DynamicImportObjectFunctionCollector {
            object_function_wrappers: object_function_wrappers.clone(),
            wrappers: DynamicImportWrappers {
                object_function_wrappers: object_function_wrappers.clone(),
                ..wrappers.clone()
            },
            identity,
        };
        collector.visit_program(program);
        if collector.object_function_wrappers == object_function_wrappers {
            wrappers.object_function_wrappers = collector.object_function_wrappers;
            return wrappers;
        }
        object_function_wrappers = collector.object_function_wrappers;
    }
}

struct DynamicImportWrapperCollector<'a> {
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
}

impl DynamicImportWrapperCollector<'_> {
    fn collect_function_declaration(&mut self, function: &Function<'_>) {
        let Some(binding) = &function.id else {
            return;
        };
        if let Some(module_ids) =
            extract_dynamic_import_module_ids_from_function(function, self.identity)
        {
            self.wrappers
                .function_wrappers
                .insert(self.identity.key_of_binding(binding), module_ids);
        }
    }
}

impl<'a> Visit<'a> for DynamicImportWrapperCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::FunctionDeclaration(function)) = &export.declaration {
                    self.collect_function_declaration(function);
                }
            }
            _ => {}
        }
        walk::walk_statement(self, statement);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            walk::walk_variable_declarator(self, declarator);
            return;
        };
        if let Some(initializer) = &declarator.init {
            if let Some(module_ids) =
                extract_dynamic_import_module_ids_from_expr(initializer, self.identity)
            {
                self.wrappers
                    .function_wrappers
                    .insert(self.identity.key_of_binding(binding), module_ids);
            } else if let Some(object_wrappers) =
                extract_dynamic_import_object_wrappers(initializer, self.identity)
            {
                self.wrappers
                    .object_wrappers
                    .insert(self.identity.key_of_binding(binding), object_wrappers);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

struct DynamicImportObjectFunctionCollector<'a> {
    object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    wrappers: DynamicImportWrappers,
    identity: &'a ModuleIdentity,
}

impl DynamicImportObjectFunctionCollector<'_> {
    fn insert_wrapper(&mut self, binding: BindingKey, wrapper: DynamicImportObjectWrapper) {
        self.wrappers
            .object_function_wrappers
            .insert(binding, wrapper.clone());
        self.object_function_wrappers.insert(binding, wrapper);
    }

    fn collect_function_declaration(&mut self, function: &Function<'_>) {
        let Some(binding) = &function.id else {
            return;
        };
        if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_function(
            function,
            &self.wrappers,
            self.identity,
        ) {
            self.insert_wrapper(self.identity.key_of_binding(binding), wrapper);
        }
    }
}

impl<'a> Visit<'a> for DynamicImportObjectFunctionCollector<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::FunctionDeclaration(function) => {
                self.collect_function_declaration(function);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::FunctionDeclaration(function)) = &export.declaration {
                    self.collect_function_declaration(function);
                }
            }
            _ => {}
        }
        walk::walk_statement(self, statement);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            walk::walk_variable_declarator(self, declarator);
            return;
        };
        if let Some(initializer) = &declarator.init {
            if let Some(wrapper) = extract_dynamic_import_object_wrapper_from_callable_expr(
                initializer,
                &self.wrappers,
                self.identity,
            ) {
                self.insert_wrapper(self.identity.key_of_binding(binding), wrapper);
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn extract_dynamic_import_module_ids_from_function(
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

fn extract_dynamic_import_module_ids_from_expr(
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
    let [Statement::ReturnStatement(return_statement)] = arrow.body.statements.as_slice() else {
        return None;
    };
    extract_dynamic_import_module_ids_from_expr(return_statement.argument.as_ref()?, identity)
}

fn extract_dynamic_import_object_wrappers(
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

fn extract_dynamic_import_object_wrapper_from_callable_expr(
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

fn extract_dynamic_import_object_wrapper_from_function(
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
    let argument = extract_wrapper_return_argument(&arrow.body.statements)?;
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
            .and_then(|binding| wrappers.function_wrappers.get(&binding).cloned()),
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
                    .or_else(|| wrappers.object_wrappers.get(&binding).cloned())
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
            .and_then(|binding| wrappers.object_function_wrappers.get(&binding).cloned())
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

fn collect_wrapper_module_ids(wrapper: &DynamicImportObjectWrapper) -> Option<BTreeSet<String>> {
    let mut module_ids = BTreeSet::new();
    for ids in wrapper.values() {
        module_ids.extend(ids.iter().cloned());
    }
    (!module_ids.is_empty()).then_some(module_ids)
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

fn merge_wrapper_map_into(
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

fn literal_property_name(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::StringLiteral(value) => Some(value.value.to_string()),
        Expression::NumericLiteral(value) => Some(value.value.to_string()),
        _ => None,
    }
}

fn is_member_expression(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::PrivateFieldExpression(_)
    )
}

fn member_object<'a>(expression: &'a Expression<'a>) -> Option<&'a Expression<'a>> {
    match expression {
        Expression::StaticMemberExpression(member) => Some(&member.object),
        Expression::ComputedMemberExpression(member) => Some(&member.object),
        Expression::PrivateFieldExpression(member) => Some(&member.object),
        _ => None,
    }
}

fn member_property_name(expression: &Expression<'_>) -> Option<String> {
    match expression {
        Expression::StaticMemberExpression(member) => Some(member.property.name.to_string()),
        Expression::ComputedMemberExpression(member) => literal_property_name(&member.expression),
        _ => None,
    }
}

fn member_is_literal_computed(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ComputedMemberExpression(member)
            if matches!(
                member.expression,
                Expression::StringLiteral(_) | Expression::NumericLiteral(_)
            )
    )
}
