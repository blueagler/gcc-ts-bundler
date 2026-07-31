use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_span::SPAN;
use oxc_str::Str;

use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::ClassMapCallInput;

pub(crate) fn apply<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    calls: &[ClassMapCallInput],
) {
    if calls.is_empty() {
        return;
    }
    let import_aliases = collect_import_aliases(program, identity);
    let mut visitor = ClassMapVisitor::new(allocator, calls, import_aliases, program, identity);
    visitor.visit_program(program);
}

#[derive(Clone)]
struct Rule {
    arg_index: usize,
    key_exclude_pattern: Option<regex::Regex>,
    key_pattern: Option<regex::Regex>,
    string_literal_arg_index: Option<usize>,
}

struct ClassMapVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    calls: HashMap<String, Vec<Rule>>,
    identity: &'i ModuleIdentity,
    import_aliases: BindingKeyMap<String>,
    literal_contract_bindings: BindingKeySet,
    object_binding_rules: BindingKeyMap<Vec<Rule>>,
}

impl<'a, 'i> ClassMapVisitor<'a, 'i> {
    fn new(
        allocator: &'a Allocator,
        calls: &[ClassMapCallInput],
        import_aliases: BindingKeyMap<String>,
        program: &Program<'a>,
        identity: &'i ModuleIdentity,
    ) -> Self {
        let mut grouped = HashMap::<String, Vec<Rule>>::new();
        for call in calls {
            if call.keySource.as_deref() == Some("pairArray") {
                continue;
            }
            grouped.entry(call.callee.clone()).or_default().push(Rule {
                arg_index: call.argIndex as usize,
                key_exclude_pattern: call
                    .keyExcludePattern
                    .as_deref()
                    .and_then(|pattern| regex::Regex::new(pattern).ok()),
                key_pattern: call
                    .keyPattern
                    .as_deref()
                    .and_then(|pattern| regex::Regex::new(pattern).ok()),
                string_literal_arg_index: call.stringLiteralArgIndex.map(|index| index as usize),
            });
        }
        let mut visitor = Self {
            allocator,
            builder: AstBuilder::new(allocator),
            calls: grouped,
            identity,
            import_aliases,
            literal_contract_bindings: HashSet::new(),
            object_binding_rules: HashMap::new(),
        };
        visitor.literal_contract_bindings = visitor.collect_literal_contract_bindings(program);
        visitor.object_binding_rules = visitor.collect_object_binding_rules(program);
        visitor
    }

    fn rules_for_call(&self, call: &CallExpression<'_>) -> Option<&Vec<Rule>> {
        let (local_name, local_binding) = callee_local_binding(&call.callee, self.identity)?;
        let callee = local_binding
            .and_then(|binding| self.import_aliases.get(&binding))
            .map(String::as_str)
            .unwrap_or(local_name.as_str());
        self.calls.get(callee)
    }

    fn expr_has_literal_contract(
        &self,
        expression: &Expression<'_>,
        bindings: &BindingKeySet,
    ) -> bool {
        match expression.without_parentheses() {
            Expression::StringLiteral(_) => true,
            Expression::TemplateLiteral(template)
                if template.expressions.is_empty() && template.quasis.len() == 1 =>
            {
                true
            }
            Expression::Identifier(identifier) => self
                .identity
                .key_of_reference(identifier)
                .is_some_and(|binding| bindings.contains(&binding)),
            Expression::CallExpression(call) => self.call_has_literal_contract(call, bindings),
            _ => false,
        }
    }

    fn call_has_literal_contract(
        &self,
        call: &CallExpression<'_>,
        bindings: &BindingKeySet,
    ) -> bool {
        self.rules_for_call(call).is_some_and(|rules| {
            rules.iter().any(|rule| {
                rule.string_literal_arg_index.is_some_and(|index| {
                    call.arguments
                        .get(index)
                        .and_then(Argument::as_expression)
                        .is_some_and(|argument| self.expr_has_literal_contract(argument, bindings))
                })
            })
        })
    }

    fn gate_matches(&self, call: &CallExpression<'_>, rule: &Rule) -> bool {
        rule.string_literal_arg_index.is_none_or(|index| {
            call.arguments
                .get(index)
                .and_then(Argument::as_expression)
                .is_some_and(|argument| {
                    self.expr_has_literal_contract(argument, &self.literal_contract_bindings)
                })
        })
    }

    fn collect_literal_contract_bindings(&self, program: &Program<'a>) -> BindingKeySet {
        let initializers = collect_const_initializers(program, self.identity);
        let mut bindings = HashSet::new();
        loop {
            let mut changed = false;
            for (binding, initializer) in &initializers {
                if !bindings.contains(binding)
                    && self.expr_has_literal_contract(initializer, &bindings)
                {
                    bindings.insert(*binding);
                    changed = true;
                }
            }
            if !changed {
                return bindings;
            }
        }
    }

    fn collect_object_binding_rules(&self, program: &Program<'a>) -> BindingKeyMap<Vec<Rule>> {
        let const_bindings = collect_const_initializers(program, self.identity)
            .into_iter()
            .map(|(binding, _)| binding)
            .collect::<HashSet<_>>();
        let mut collector = ObjectBindingCollector {
            const_bindings: &const_bindings,
            identity: self.identity,
            rules: HashMap::new(),
            visitor: self,
        };
        collector.visit_program(program);
        collector.rules
    }

    fn quote_object(&self, object: &mut ObjectExpression<'a>, rule: &Rule) {
        for property in &mut object.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            let name = match &property.key {
                PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str()),
                PropertyKey::NumericLiteral(_)
                    if rule.key_pattern.is_none() && rule.key_exclude_pattern.is_none() =>
                {
                    Some("")
                }
                _ => None,
            };
            let Some(name) = name else { continue };
            if rule
                .key_exclude_pattern
                .as_ref()
                .is_some_and(|pattern| pattern.is_match(name))
                || rule
                    .key_pattern
                    .as_ref()
                    .is_some_and(|pattern| !pattern.is_match(name))
            {
                continue;
            }
            let value = match &property.key {
                PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
                PropertyKey::NumericLiteral(number) => number.value.to_string(),
                _ => continue,
            };
            property.key = PropertyKey::new_string_literal(
                SPAN,
                Str::from_in(&value, self.allocator),
                None,
                &self.builder,
            );
            property.computed = false;
            property.shorthand = false;
        }
    }
}

impl<'a> VisitMut<'a> for ClassMapVisitor<'a, '_> {
    fn visit_variable_declarator(&mut self, declarator: &mut VariableDeclarator<'a>) {
        walk_mut::walk_variable_declarator(self, declarator);
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            return;
        };
        let key = self.identity.key_of_binding(binding);
        let Some(rules) = self.object_binding_rules.get(&key).cloned() else {
            return;
        };
        let Some(initializer) = declarator.init.as_mut() else {
            return;
        };
        let Some(object) = object_expression_mut(initializer) else {
            return;
        };
        for rule in rules {
            self.quote_object(object, &rule);
        }
    }

    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, call);
        let Some(rules) = self.rules_for_call(call).cloned() else {
            return;
        };
        for rule in rules {
            if !self.gate_matches(call, &rule) {
                continue;
            }
            let Some(argument) = call
                .arguments
                .get_mut(rule.arg_index)
                .and_then(Argument::as_expression_mut)
            else {
                continue;
            };
            let Some(object) = object_expression_mut(argument) else {
                continue;
            };
            self.quote_object(object, &rule);
        }
    }
}

struct ObjectBindingCollector<'a, 'v> {
    const_bindings: &'a BindingKeySet,
    identity: &'v ModuleIdentity,
    rules: BindingKeyMap<Vec<Rule>>,
    visitor: &'a ClassMapVisitor<'v, 'v>,
}

impl<'a> Visit<'a> for ObjectBindingCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(rules) = self.visitor.rules_for_call(call) {
            for rule in rules {
                if !self.visitor.gate_matches(call, rule) {
                    continue;
                }
                let Some(Expression::Identifier(identifier)) = call
                    .arguments
                    .get(rule.arg_index)
                    .and_then(Argument::as_expression)
                    .map(Expression::without_parentheses)
                else {
                    continue;
                };
                let Some(binding) = self.identity.key_of_reference(identifier) else {
                    continue;
                };
                if self.const_bindings.contains(&binding) {
                    self.rules.entry(binding).or_default().push(rule.clone());
                }
            }
        }
        walk::walk_call_expression(self, call);
    }
}

fn collect_import_aliases(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BindingKeyMap<String> {
    let mut aliases = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };
            aliases.insert(
                identity.key_of_binding(&named.local),
                module_export_name(&named.imported),
            );
        }
    }
    aliases
}

fn collect_const_initializers<'a>(
    program: &'a Program<'a>,
    identity: &ModuleIdentity,
) -> Vec<(BindingKey, &'a Expression<'a>)> {
    let mut values = Vec::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::VariableDeclaration(declaration) => Some(&**declaration),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(Declaration::VariableDeclaration(declaration)) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        if declaration.kind != VariableDeclarationKind::Const {
            continue;
        }
        for declarator in &declaration.declarations {
            let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
                (&declarator.id, &declarator.init)
            else {
                continue;
            };
            values.push((identity.key_of_binding(binding), initializer));
        }
    }
    values
}

fn callee_local_binding(
    callee: &Expression<'_>,
    identity: &ModuleIdentity,
) -> Option<(String, Option<BindingKey>)> {
    match callee.without_parentheses() {
        Expression::Identifier(identifier) => Some((
            identifier.name.to_string(),
            identity.key_of_reference(identifier),
        )),
        Expression::StaticMemberExpression(member) => {
            Some((member.property.name.to_string(), None))
        }
        Expression::ComputedMemberExpression(member) => match &member.expression {
            Expression::StringLiteral(literal) => Some((literal.value.to_string(), None)),
            _ => None,
        },
        _ => None,
    }
}

fn object_expression_mut<'a, 'b>(
    expression: &'b mut Expression<'a>,
) -> Option<&'b mut ObjectExpression<'a>> {
    match expression {
        Expression::ObjectExpression(object) => Some(object),
        Expression::ParenthesizedExpression(parenthesized) => {
            object_expression_mut(&mut parenthesized.expression)
        }
        _ => None,
    }
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}
