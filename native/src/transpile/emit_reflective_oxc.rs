//! Oxc read-only property-flow analysis for reflective property names.

use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_syntax::operator::BinaryOperator;

use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};

pub(crate) fn collect_reflective_property_names(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BTreeSet<String> {
    let mut lists = ReflectiveListBindings {
        identity,
        lists: HashMap::new(),
    };
    lists.visit_program(program);

    let mut functions = LocalFunctionRoles {
        ambiguous: HashSet::new(),
        identity,
        roles: HashMap::new(),
    };
    functions.visit_program(program);
    functions.drop_ambiguous_bindings();

    let mut collector = ReflectiveKeys {
        for_in_bindings: HashSet::new(),
        functions,
        identity,
        lists: lists.lists,
        names: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.names
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParameterRole {
    KeyRead,
    ExclusionList,
}

struct ReflectiveListBindings<'a> {
    identity: &'a ModuleIdentity,
    lists: BindingKeyMap<Vec<String>>,
}

impl<'a> Visit<'a> for ReflectiveListBindings<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        walk::walk_variable_declarator(self, declarator);
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            return;
        };
        let Some(initializer) = &declarator.init else {
            return;
        };
        if let Some(values) = string_list(initializer) {
            self.lists
                .insert(self.identity.key_of_binding(binding), values);
        }
    }
}

struct LocalFunctionRoles<'a> {
    roles: BindingKeyMap<Vec<Option<ParameterRole>>>,
    ambiguous: BindingKeySet,
    identity: &'a ModuleIdentity,
}

impl LocalFunctionRoles<'_> {
    fn record(&mut self, binding: BindingKey, roles: Vec<Option<ParameterRole>>) {
        if self.roles.insert(binding, roles).is_some() {
            self.ambiguous.insert(binding);
        }
    }

    fn record_function(&mut self, function: &Function<'_>) {
        let (Some(binding), Some(body)) = (&function.id, &function.body) else {
            return;
        };
        let parameters = formal_parameter_ids(&function.params, self.identity);
        self.record(
            self.identity.key_of_binding(binding),
            classify_parameters(&parameters, body, self.identity),
        );
    }

    fn drop_ambiguous_bindings(&mut self) {
        for binding in &self.ambiguous {
            self.roles.remove(binding);
        }
    }

    fn roles_for(&self, binding: BindingKey) -> Option<&[Option<ParameterRole>]> {
        self.roles.get(&binding).map(Vec::as_slice)
    }
}

impl<'a> Visit<'a> for LocalFunctionRoles<'_> {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        walk::walk_statement(self, statement);
        match statement {
            Statement::FunctionDeclaration(function) => self.record_function(function),
            Statement::ExportNamedDeclaration(export) => {
                if let Some(Declaration::FunctionDeclaration(function)) = &export.declaration {
                    self.record_function(function);
                }
            }
            _ => {}
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        walk::walk_variable_declarator(self, declarator);
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            return;
        };
        let Some(initializer) = &declarator.init else {
            return;
        };
        let (parameters, body) = match initializer.without_parentheses() {
            Expression::FunctionExpression(function) => {
                let Some(body) = &function.body else {
                    return;
                };
                (
                    formal_parameter_ids(&function.params, self.identity),
                    &**body,
                )
            }
            Expression::ArrowFunctionExpression(arrow) if !arrow.expression => (
                formal_parameter_ids(&arrow.params, self.identity),
                &*arrow.body,
            ),
            _ => return,
        };
        self.record(
            self.identity.key_of_binding(binding),
            classify_parameters(&parameters, body, self.identity),
        );
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        let Some(SimpleAssignmentTarget::AssignmentTargetIdentifier(target)) =
            assignment.left.as_simple_assignment_target()
        else {
            return;
        };
        if let Some(binding) = self.identity.key_of_reference(target) {
            self.ambiguous.insert(binding);
        }
    }
}

fn formal_parameter_ids(
    parameters: &FormalParameters<'_>,
    identity: &ModuleIdentity,
) -> Vec<Option<BindingKey>> {
    let mut ids = parameters
        .items
        .iter()
        .map(|parameter| binding_id(&parameter.pattern, identity))
        .collect::<Vec<_>>();
    if let Some(rest) = &parameters.rest {
        ids.push(binding_id(&rest.rest.argument, identity));
    }
    ids
}

fn classify_parameters(
    parameters: &[Option<BindingKey>],
    body: &FunctionBody<'_>,
    identity: &ModuleIdentity,
) -> Vec<Option<ParameterRole>> {
    let indices = parameters
        .iter()
        .enumerate()
        .filter_map(|(index, binding)| binding.map(|binding| (binding, index)))
        .collect::<HashMap<_, _>>();
    if indices.is_empty() {
        return vec![None; parameters.len()];
    }
    let mut scan = ParameterUseScan {
        for_in_keys: Vec::new(),
        identity,
        parameters: indices,
        roles: vec![None; parameters.len()],
    };
    scan.visit_function_body(body);
    scan.roles
}

struct ParameterUseScan<'a> {
    for_in_keys: Vec<(BindingKey, usize)>,
    identity: &'a ModuleIdentity,
    parameters: BindingKeyMap<usize>,
    roles: Vec<Option<ParameterRole>>,
}

impl ParameterUseScan<'_> {
    fn iterated_parameter(&self, key: BindingKey) -> Option<usize> {
        self.for_in_keys
            .iter()
            .rev()
            .find_map(|(binding, index)| (*binding == key).then_some(*index))
    }
}

impl<'a> Visit<'a> for ParameterUseScan<'_> {
    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        self.visit_expression(&statement.right);
        let iterated = match &statement.right {
            Expression::Identifier(object) => self
                .identity
                .key_of_reference(object)
                .and_then(|binding| self.parameters.get(&binding).copied()),
            _ => None,
        };
        let binding = for_in_binding_id(&statement.left, self.identity);
        let tracked = match (binding, iterated) {
            (Some(binding), Some(iterated)) => {
                self.for_in_keys.push((binding, iterated));
                true
            }
            _ => false,
        };
        self.visit_statement(&statement.body);
        if tracked {
            self.for_in_keys.pop();
        }
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        walk::walk_computed_member_expression(self, member);
        let (Expression::Identifier(object), Expression::Identifier(key)) =
            (&member.object, &member.expression)
        else {
            return;
        };
        let (Some(object_index), Some(key_index)) = (
            self.identity
                .key_of_reference(object)
                .and_then(|binding| self.parameters.get(&binding).copied()),
            self.identity
                .key_of_reference(key)
                .and_then(|binding| self.parameters.get(&binding).copied()),
        ) else {
            return;
        };
        if object_index != key_index {
            self.roles[key_index] = Some(ParameterRole::KeyRead);
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        let Some(test) = membership_test(call, self.identity) else {
            return;
        };
        let Expression::Identifier(list) = test.list else {
            return;
        };
        let Some(list_index) = self
            .identity
            .key_of_reference(list)
            .and_then(|binding| self.parameters.get(&binding).copied())
        else {
            return;
        };
        let Some(iterated_index) = self.iterated_parameter(test.key) else {
            return;
        };
        if list_index != iterated_index {
            self.roles[list_index] = Some(ParameterRole::ExclusionList);
        }
    }
}

struct ReflectiveKeys<'a> {
    for_in_bindings: BindingKeySet,
    functions: LocalFunctionRoles<'a>,
    identity: &'a ModuleIdentity,
    lists: BindingKeyMap<Vec<String>>,
    names: BTreeSet<String>,
}

impl ReflectiveKeys<'_> {
    fn collect_string_list(&mut self, expression: &Expression<'_>) {
        let values = match expression {
            Expression::Identifier(list) => self
                .identity
                .key_of_reference(list)
                .and_then(|binding| self.lists.get(&binding).cloned()),
            other => string_list(other),
        };
        self.names.extend(values.unwrap_or_default());
    }

    fn collect_from_local_call(&mut self, call: &CallExpression<'_>) {
        let Expression::Identifier(callee) = &call.callee else {
            return;
        };
        let Some(binding) = self.identity.key_of_reference(callee) else {
            return;
        };
        let Some(roles) = self.functions.roles_for(binding) else {
            return;
        };
        let roles = roles.to_vec();
        for (argument, role) in call.arguments.iter().zip(roles) {
            let Some(argument) = argument.as_expression() else {
                return;
            };
            match role {
                Some(ParameterRole::KeyRead) => {
                    if let Expression::StringLiteral(literal) = argument {
                        self.names.insert(literal.value.to_string());
                    }
                }
                Some(ParameterRole::ExclusionList) => self.collect_string_list(argument),
                None => {}
            }
        }
    }
}

impl<'a> Visit<'a> for ReflectiveKeys<'_> {
    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        let binding = for_in_binding_id(&statement.left, self.identity);
        if let Some(binding) = binding {
            self.for_in_bindings.insert(binding);
        }
        walk::walk_for_in_statement(self, statement);
        if let Some(binding) = binding {
            self.for_in_bindings.remove(&binding);
        }
    }

    fn visit_binary_expression(&mut self, expression: &BinaryExpression<'a>) {
        walk::walk_binary_expression(self, expression);
        if !matches!(
            expression.operator,
            BinaryOperator::Equality
                | BinaryOperator::Inequality
                | BinaryOperator::StrictEquality
                | BinaryOperator::StrictInequality
        ) {
            return;
        }
        for (identifier, literal) in [
            (&expression.left, &expression.right),
            (&expression.right, &expression.left),
        ] {
            let Expression::Identifier(identifier) = identifier else {
                continue;
            };
            let Some(binding) = self.identity.key_of_reference(identifier) else {
                continue;
            };
            if !self.for_in_bindings.contains(&binding) {
                continue;
            }
            if let Expression::StringLiteral(literal) = literal {
                self.names.insert(literal.value.to_string());
            }
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        self.collect_from_local_call(call);
        let Some(test) = membership_test(call, self.identity) else {
            return;
        };
        if self.for_in_bindings.contains(&test.key) {
            self.collect_string_list(test.list);
        }
    }
}

struct MembershipTest<'a> {
    key: BindingKey,
    list: &'a Expression<'a>,
}

fn membership_test<'a>(
    call: &'a CallExpression<'a>,
    identity: &ModuleIdentity,
) -> Option<MembershipTest<'a>> {
    let Expression::StaticMemberExpression(member) = &call.callee else {
        return None;
    };
    if !matches!(
        member.property.name.as_str(),
        "includes" | "indexOf" | "lastIndexOf"
    ) {
        return None;
    }
    let [argument] = call.arguments.as_slice() else {
        return None;
    };
    let Expression::Identifier(key) = argument.as_expression()? else {
        return None;
    };
    Some(MembershipTest {
        key: identity.key_of_reference(key)?,
        list: &member.object,
    })
}

fn binding_id(pattern: &BindingPattern<'_>, identity: &ModuleIdentity) -> Option<BindingKey> {
    let BindingPattern::BindingIdentifier(binding) = pattern else {
        return None;
    };
    Some(identity.key_of_binding(binding))
}

fn for_in_binding_id(left: &ForStatementLeft<'_>, identity: &ModuleIdentity) -> Option<BindingKey> {
    match left {
        ForStatementLeft::VariableDeclaration(declaration) => {
            let [declarator] = declaration.declarations.as_slice() else {
                return None;
            };
            binding_id(&declarator.id, identity)
        }
        ForStatementLeft::AssignmentTargetIdentifier(identifier) => {
            identity.key_of_reference(identifier)
        }
        _ => None,
    }
}

fn string_list(expression: &Expression<'_>) -> Option<Vec<String>> {
    match expression {
        Expression::ArrayExpression(array) => {
            let mut values = Vec::with_capacity(array.elements.len());
            for element in &array.elements {
                let Expression::StringLiteral(literal) = element.as_expression()? else {
                    return None;
                };
                values.push(literal.value.to_string());
            }
            (!values.is_empty()).then_some(values)
        }
        Expression::CallExpression(call) => {
            let Expression::StaticMemberExpression(member) = &call.callee else {
                return None;
            };
            if member.property.name != "split" {
                return None;
            }
            let Expression::StringLiteral(source) = &member.object else {
                return None;
            };
            let [separator] = call.arguments.as_slice() else {
                return None;
            };
            let Expression::StringLiteral(separator) = separator.as_expression()? else {
                return None;
            };
            let separator = separator.value.as_str();
            if separator.is_empty() {
                return None;
            }
            let values = source
                .value
                .as_str()
                .split(separator)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            (!values.is_empty()).then_some(values)
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            string_list(&parenthesized.expression)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    fn collect(source: &str) -> BTreeSet<String> {
        let allocator = Allocator::default();
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let identity = ModuleIdentity::new(
            SemanticBuilder::new()
                .with_build_nodes(true)
                .with_enum_eval(true)
                .build(&parsed.program)
                .semantic
                .into_scoping(),
        );
        collect_reflective_property_names(&parsed.program, &identity)
    }

    fn assert_names(source: &str, expected: BTreeSet<String>) {
        assert_eq!(collect(source), expected);
    }

    #[test]
    fn direct_and_cross_function_reflective_flows_are_collected() {
        assert_names(
            r#"
for (const key in attrs) {
  if (key === "class" || key !== "style") use(key);
}
const exclude = "$$slots $$events".split(" ");
for (const key in props) { if (exclude.includes(key)) continue; use(key); }
function prop(object, key) { return object[key]; }
function rest(object, keys) {
  for (const key in object) { if (keys.includes(key)) continue; use(key); }
}
const named = ["a", "b"];
function render(props) {
  prop(props, "variant");
  rest(props, named);
  rest(props, ["x", "y"]);
}
function ignored(object, key) { return object[key]; }
ignored = replacement;
ignored(props, "wrong");
"#,
            BTreeSet::from([
                "$$events".to_string(),
                "$$slots".to_string(),
                "a".to_string(),
                "b".to_string(),
                "class".to_string(),
                "style".to_string(),
                "variant".to_string(),
                "x".to_string(),
                "y".to_string(),
            ]),
        );
    }

    #[test]
    fn shadowed_callee_binding_does_not_inherit_outer_function_roles() {
        assert_names(
            r#"
function prop(object, key) { return object[key]; }
function invoke(prop) { prop(source, "shadowed"); }
prop(source, "real");
"#,
            BTreeSet::from(["real".to_string()]),
        );
    }
}
