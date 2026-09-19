//! Shared helpers for Oxc namespace-slot rewriting.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn, FromIn};
use oxc_ast::ast::{
    AssignmentTarget, AssignmentTargetMaybeDefault, AssignmentTargetProperty, Expression,
    ForStatementLeft, FunctionBody, Program, PropertyKey, SimpleAssignmentTarget, Statement,
    VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, Visit};
use oxc_codegen::Codegen;
use oxc_span::SPAN;
use oxc_str::Str;
use oxc_syntax::operator::BinaryOperator;

use crate::transpile::emit_runtime::binding_names_with_ids;
use crate::transpile::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use crate::transpile::lowering::closure_input_codegen_options;
use crate::transpile::HoistPlan;

#[derive(Clone, Debug)]
pub(crate) struct NamespaceReification {
    pub(crate) module_id: String,
    pub(crate) warning: String,
}

pub(crate) struct HoistNamespaceInfo<'i> {
    pub(crate) consumer_module_id: &'i str,
    pub(crate) direct_namespace_ids: &'i BindingKeySet,
    pub(crate) lexical_binding_names: &'i HashSet<String>,
    pub(crate) plan: &'i HoistPlan,
}

pub(super) struct FinitePropertyBindingCollector<'i> {
    bindings: BindingKeyMap<Vec<String>>,
    identity: &'i ModuleIdentity,
    seen: BindingKeySet,
    error: Option<String>,
}

impl FinitePropertyBindingCollector<'_> {
    fn collect_declarator(&mut self, declarator: &VariableDeclarator<'_>) -> Result<(), String> {
        let candidate = declarator
            .id
            .get_binding_identifier()
            .map(ModuleIdentity::key_of_binding)
            .transpose()?;
        let mut candidate_is_unique = true;
        for (key, _) in binding_names_with_ids(&declarator.id)? {
            if !self.seen.insert(key) {
                self.bindings.remove(&key);
                candidate_is_unique &= candidate != Some(key);
            }
        }
        if let Some(key) = candidate.filter(|_| candidate_is_unique) {
            if self.identity.is_stable_local_binding(key) {
                if let Some(properties) = declarator.init.as_ref().and_then(finite_property_names) {
                    self.bindings.insert(key, properties);
                }
            }
        }
        Ok(())
    }
}

impl<'a> Visit<'a> for FinitePropertyBindingCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let Err(error) = self.collect_declarator(declarator) {
            self.error.get_or_insert(error);
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

pub(crate) fn collect_finite_property_bindings(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> Result<BindingKeyMap<Vec<String>>, String> {
    let mut collector = FinitePropertyBindingCollector {
        bindings: HashMap::new(),
        identity,
        seen: HashSet::new(),
        error: None,
    };
    collector.visit_program(program);
    match collector.error {
        Some(error) => Err(error),
        None => Ok(collector.bindings),
    }
}

pub(super) fn single_return_argument<'b, 'a>(
    body: &'b FunctionBody<'a>,
) -> Option<&'b Expression<'a>> {
    let [Statement::ReturnStatement(statement)] = body.statements.as_slice() else {
        return None;
    };
    statement.argument.as_ref()
}

pub(super) fn property_key_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        PropertyKey::NumericLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

pub(super) fn computed_property_name(expression: &Expression<'_>) -> Option<String> {
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

pub(crate) fn finite_property_names(expression: &Expression<'_>) -> Option<Vec<String>> {
    if let Some(property) = computed_property_name(expression) {
        return Some(vec![property]);
    }
    match expression {
        Expression::ConditionalExpression(conditional) => {
            let mut properties = finite_property_names(&conditional.consequent)?;
            for property in finite_property_names(&conditional.alternate)? {
                if !properties.contains(&property) {
                    properties.push(property);
                }
            }
            Some(properties)
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            finite_property_names(&parenthesized.expression)
        }
        _ => None,
    }
}

pub(super) fn finite_computed_property(expression: &Expression<'_>) -> bool {
    if computed_property_name(expression).is_some() {
        return true;
    }
    match expression {
        Expression::ConditionalExpression(conditional) => {
            finite_computed_property(&conditional.consequent)
                && finite_computed_property(&conditional.alternate)
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            finite_computed_property(&parenthesized.expression)
        }
        _ => false,
    }
}

pub(super) fn clone_namespace_object<'a>(
    object: &Expression<'a>,
    allocator: &'a Allocator,
) -> Expression<'a> {
    let cloned = object.clone_in(allocator);
    if let (Expression::Identifier(source), Expression::Identifier(target)) = (object, &cloned) {
        target.reference_id.set(source.reference_id.get());
    }
    cloned
}

pub(super) fn lower_finite_namespace_member<'a>(
    object: Expression<'a>,
    property: Expression<'a>,
    optional: bool,
    allocator: &'a Allocator,
    builder: &AstBuilder<'a>,
) -> Expression<'a> {
    match property {
        Expression::ConditionalExpression(conditional) => {
            let conditional = conditional.unbox();
            let test = conditional.test;
            let consequent = conditional.consequent;
            let alternate = conditional.alternate;
            let consequent_object = clone_namespace_object(&object, allocator);
            Expression::new_conditional_expression(
                conditional.span,
                test,
                lower_finite_namespace_member(
                    consequent_object,
                    consequent,
                    optional,
                    allocator,
                    builder,
                ),
                lower_finite_namespace_member(object, alternate, optional, allocator, builder),
                builder,
            )
        }
        Expression::ParenthesizedExpression(parenthesized) => lower_finite_namespace_member(
            object,
            parenthesized.unbox().expression,
            optional,
            allocator,
            builder,
        ),
        property => {
            Expression::new_computed_member_expression(SPAN, object, property, optional, builder)
        }
    }
}

pub(super) fn lower_bound_finite_namespace_member<'a>(
    object: Expression<'a>,
    property: Expression<'a>,
    last: &str,
    preceding: &[String],
    optional: bool,
    allocator: &'a Allocator,
    builder: &AstBuilder<'a>,
) -> Expression<'a> {
    let string = |value: &str| {
        Expression::new_string_literal(SPAN, Str::from_in(value, allocator), None, builder)
    };
    let mut consequents = preceding
        .iter()
        .map(|name| {
            Expression::new_computed_member_expression(
                SPAN,
                clone_namespace_object(&object, allocator),
                string(name),
                optional,
                builder,
            )
        })
        .collect::<Vec<_>>();
    let mut selection =
        Expression::new_computed_member_expression(SPAN, object, string(last), optional, builder);
    for (name, consequent) in preceding.iter().zip(consequents.drain(..)).rev() {
        selection = Expression::new_conditional_expression(
            SPAN,
            Expression::new_binary_expression(
                SPAN,
                clone_namespace_object(&property, allocator),
                BinaryOperator::StrictEquality,
                string(name),
                builder,
            ),
            consequent,
            selection,
            builder,
        );
    }
    selection
}

pub(super) fn print_node(node: &Expression<'_>) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    codegen.print_expression(node);
    codegen.into_source_text()
}

pub(super) fn member_call_parts<'b, 'a>(
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

pub(super) fn expression_namespace_object<'b, 'a>(
    expression: &'b Expression<'a>,
) -> Option<&'b Expression<'a>> {
    match expression {
        Expression::StaticMemberExpression(member) => Some(&member.object),
        Expression::ComputedMemberExpression(member) => Some(&member.object),
        _ => None,
    }
}

pub(super) fn assignment_target_namespace_object<'b, 'a>(
    target: &'b AssignmentTarget<'a>,
) -> Option<&'b Expression<'a>> {
    match target {
        AssignmentTarget::StaticMemberExpression(member) => Some(&member.object),
        AssignmentTarget::ComputedMemberExpression(member) => Some(&member.object),
        _ => None,
    }
}

pub(super) fn simple_assignment_target_namespace_object<'b, 'a>(
    target: &'b SimpleAssignmentTarget<'a>,
) -> Option<&'b Expression<'a>> {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => Some(&member.object),
        SimpleAssignmentTarget::ComputedMemberExpression(member) => Some(&member.object),
        _ => None,
    }
}

pub(super) fn remove_for_left_carriers<T>(
    left: &ForStatementLeft<'_>,
    identity: &ModuleIdentity,
    carriers: &mut BindingKeyMap<T>,
) -> Result<(), String> {
    if let ForStatementLeft::VariableDeclaration(declaration) = left {
        for declarator in &declaration.declarations {
            for (binding, _) in binding_names_with_ids(&declarator.id)? {
                carriers.remove(&binding);
            }
        }
    } else if let Some(target) = left.as_assignment_target() {
        remove_assignment_target_carriers(target, identity, carriers);
    }
    Ok(())
}

pub(super) fn remove_assignment_target_carriers<T>(
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

pub(super) fn remove_maybe_default_carriers<T>(
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use oxc_allocator::{Allocator, TakeIn};
    use oxc_ast::ast::{ComputedMemberExpression, Expression, Program, Statement};
    use oxc_ast::builder::AstBuilder;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    use super::{
        collect_finite_property_bindings, finite_computed_property, lower_finite_namespace_member,
        print_node,
    };
    use crate::transpile::identity::ModuleIdentity;

    fn computed_initializer<'a>(
        program: &'a mut Program<'a>,
    ) -> Result<&'a mut ComputedMemberExpression<'a>, String> {
        let Some(Statement::VariableDeclaration(declaration)) = program.body.first_mut() else {
            return Err("expected variable declaration".to_string());
        };
        let Some(Expression::ComputedMemberExpression(member)) = declaration
            .declarations
            .first_mut()
            .and_then(|declarator| declarator.init.as_mut())
        else {
            return Err("expected computed initializer".to_string());
        };
        Ok(member)
    }

    fn finite_bindings(source: &str) -> Result<HashMap<String, Vec<String>>, String> {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let identity = ModuleIdentity::new(
            SemanticBuilder::new()
                .with_build_nodes(true)
                .build(&parsed.program)
                .semantic
                .into_scoping(),
        );
        Ok(
            collect_finite_property_bindings(&parsed.program, &identity)?
                .into_iter()
                .map(|(key, properties)| (identity.symbol(key).to_string(), properties))
                .collect(),
        )
    }

    #[test]
    fn follows_a_bound_finite_ternary() -> Result<(), String> {
        let bindings = finite_bindings(
            r#"function draw(condition) { const shapeType = condition ? "Circle" : "Arc"; return graphic[shapeType]; }"#,
        )?;
        assert_eq!(bindings["shapeType"], ["Circle", "Arc"]);
        Ok(())
    }

    #[test]
    fn follows_a_bound_nested_finite_ternary() -> Result<(), String> {
        let bindings = finite_bindings(
            r#"function draw(first, second) { const shapeType = first ? "Circle" : second ? "Arc" : "Line"; return graphic[shapeType]; }"#,
        )?;
        assert_eq!(bindings["shapeType"], ["Circle", "Arc", "Line"]);
        Ok(())
    }

    #[test]
    fn rejects_a_reassigned_finite_binding() -> Result<(), String> {
        let bindings = finite_bindings(
            r#"function draw(condition) { let shapeType = condition ? "Circle" : "Arc"; shapeType = "Line"; return graphic[shapeType]; }"#,
        )?;
        assert!(!bindings.contains_key("shapeType"));
        Ok(())
    }

    #[test]
    fn rejects_a_binding_with_multiple_declarations() -> Result<(), String> {
        let bindings = finite_bindings(
            r#"function draw(condition, source) { var shapeType = condition ? "Circle" : "Arc"; var { shapeType } = source; return graphic[shapeType]; }"#,
        )?;
        assert!(!bindings.contains_key("shapeType"));
        Ok(())
    }

    #[test]
    fn rejects_a_parameter_as_finite_binding() -> Result<(), String> {
        let bindings = finite_bindings(r"function draw(shapeType) { return graphic[shapeType]; }")?;
        assert!(!bindings.contains_key("shapeType"));
        Ok(())
    }

    #[test]
    fn lowers_nested_finite_namespace_members_to_static_selections() -> Result<(), String> {
        let allocator = Allocator::default();
        let source = r#"const value = ns[first ? "a" : second ? "b" : "c"];"#;
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            return Err(format!("{:?}", parsed.diagnostics));
        }
        let mut program = parsed.program;
        let builder = AstBuilder::new(&allocator);
        let member = computed_initializer(&mut program)?;
        assert!(finite_computed_property(&member.expression));
        let object = member.object.take_in(&builder);
        let property = member.expression.take_in(&builder);
        let lowered = lower_finite_namespace_member(object, property, false, &allocator, &builder);
        assert_eq!(
            print_node(&lowered),
            r#"first ? ns["a"] : second ? ns["b"] : ns["c"]"#
        );
        Ok(())
    }

    #[test]
    fn rejects_dynamic_namespace_member_evidence() -> Result<(), String> {
        let allocator = Allocator::default();
        let source = r#"const value = ns[first ? "a" : dynamicKey];"#;
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            return Err(format!("{:?}", parsed.diagnostics));
        }
        let mut program = parsed.program;
        let member = computed_initializer(&mut program)?;
        assert!(!finite_computed_property(&member.expression));
        Ok(())
    }
}
