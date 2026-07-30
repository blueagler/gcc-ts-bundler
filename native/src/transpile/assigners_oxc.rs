//! Oxc counterpart of `assigners.rs`'s read-only declaration and write scans.

#![allow(dead_code)]

use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use super::assigners::NOINLINE_TAG;

pub(crate) fn assigner_function_name(
    statement: &Statement<'_>,
    module_bindings: &HashSet<String>,
) -> Option<String> {
    assigner_function_names(statement, module_bindings)
        .into_iter()
        .next()
}

pub(crate) fn assigner_function_names(
    statement: &Statement<'_>,
    module_bindings: &HashSet<String>,
) -> Vec<String> {
    if module_bindings.is_empty() {
        return Vec::new();
    }
    callable_declarations(statement)
        .into_iter()
        .filter_map(|callable| {
            let mut visitor = ModuleStateAssignmentVisitor {
                module_bindings,
                found: false,
            };
            match callable.body {
                CallableBody::Function(function) => {
                    visitor.visit_function(function, oxc_syntax::scope::ScopeFlags::Function);
                }
                CallableBody::Arrow(arrow) => visitor.visit_arrow_function_expression(arrow),
            }
            visitor.found.then(|| callable.name.name.to_string())
        })
        .collect()
}

struct CallableDeclaration<'a> {
    name: &'a BindingIdentifier<'a>,
    body: CallableBody<'a>,
}

enum CallableBody<'a> {
    Function(&'a Function<'a>),
    Arrow(&'a ArrowFunctionExpression<'a>),
}

fn callable_declarations<'a>(statement: &'a Statement<'a>) -> Vec<CallableDeclaration<'a>> {
    match statement {
        Statement::FunctionDeclaration(function) => function
            .id
            .as_ref()
            .map(|name| {
                vec![CallableDeclaration {
                    name,
                    body: CallableBody::Function(function),
                }]
            })
            .unwrap_or_default(),
        Statement::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .filter_map(|declarator| {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    return None;
                };
                let initializer = declarator.init.as_ref()?.without_parentheses();
                let body = match initializer {
                    Expression::FunctionExpression(function) => CallableBody::Function(function),
                    Expression::ArrowFunctionExpression(arrow) => CallableBody::Arrow(arrow),
                    _ => return None,
                };
                Some(CallableDeclaration {
                    name: binding,
                    body,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

struct ModuleStateAssignmentVisitor<'a> {
    module_bindings: &'a HashSet<String>,
    found: bool,
}

impl ModuleStateAssignmentVisitor<'_> {
    fn note(&mut self, name: &str) {
        if self.module_bindings.contains(name) {
            self.found = true;
        }
    }

    fn note_simple_target(&mut self, target: &SimpleAssignmentTarget<'_>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
                self.note(identifier.name.as_str());
            }
            SimpleAssignmentTarget::TSAsExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSNonNullExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSTypeAssertion(expression) => {
                self.note_expression_target(&expression.expression);
            }
            _ => {}
        }
    }

    fn note_target(&mut self, target: &AssignmentTarget<'_>) {
        if let Some(simple) = target.as_simple_assignment_target() {
            self.note_simple_target(simple);
            return;
        }
        match target {
            AssignmentTarget::ArrayAssignmentTarget(pattern) => {
                for element in pattern.elements.iter().flatten() {
                    self.note_maybe_default_target(element);
                }
                if let Some(rest) = &pattern.rest {
                    self.note_target(&rest.target);
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(pattern) => {
                for property in &pattern.properties {
                    match property {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                            self.note(property.binding.name.as_str());
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                            self.note_maybe_default_target(&property.binding);
                        }
                    }
                }
                if let Some(rest) = &pattern.rest {
                    self.note_target(&rest.target);
                }
            }
            _ => {}
        }
    }

    fn note_maybe_default_target(&mut self, target: &AssignmentTargetMaybeDefault<'_>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
                self.note_target(&default.binding);
            }
            _ => self.note_target(target.to_assignment_target()),
        }
    }

    fn note_expression_target(&mut self, expression: &Expression<'_>) {
        match expression.without_parentheses() {
            Expression::Identifier(identifier) => self.note(identifier.name.as_str()),
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    if let Some(expression) = element.as_expression() {
                        self.note_expression_target(expression);
                    }
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    if property.shorthand {
                        if let PropertyKey::StaticIdentifier(identifier) = &property.key {
                            self.note(identifier.name.as_str());
                        }
                    } else {
                        self.note_expression_target(&property.value);
                    }
                }
            }
            _ => {}
        }
    }

    fn note_for_left(&mut self, left: &ForStatementLeft<'_>) {
        if let Some(target) = left.as_assignment_target() {
            self.note_target(target);
        }
    }
}

impl<'a> Visit<'a> for ModuleStateAssignmentVisitor<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        self.note_target(&assignment.left);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, update);
        self.note_simple_target(&update.argument);
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        walk::walk_for_in_statement(self, statement);
        self.note_for_left(&statement.left);
    }

    fn visit_for_of_statement(&mut self, statement: &ForOfStatement<'a>) {
        walk::walk_for_of_statement(self, statement);
        self.note_for_left(&statement.left);
    }
}

/// Post-Closure reader: switched independently because it consumes text rather
/// than the transpile monolith's AST.
pub(crate) fn collect_annotated_assigner_names(chunk_text: &str) -> Vec<String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, chunk_text, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Vec::new();
    }
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let mut previous_end = 0usize;
    for statement in &parsed.program.body {
        let span = statement.span();
        let start = span.start as usize;
        let end = span.end as usize;
        let leading = chunk_text
            .get(previous_end.min(chunk_text.len())..start.min(chunk_text.len()))
            .unwrap_or_default();
        previous_end = end.min(chunk_text.len());
        if !has_noinline_leading_comment(leading) {
            continue;
        }
        for callable in callable_declarations(statement) {
            let name = callable.name.name.to_string();
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
    }
    names
}

fn has_noinline_leading_comment(leading: &str) -> bool {
    let trimmed = leading.trim();
    let Some(comment_start) = trimmed.rfind("/**") else {
        return false;
    };
    let comment = &trimmed[comment_start..];
    comment.ends_with("*/") && comment.contains(NOINLINE_TAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(source: &str, bindings: &[&str]) -> Vec<String> {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let bindings = bindings
            .iter()
            .map(|name| name.to_string())
            .collect::<HashSet<_>>();
        parsed
            .program
            .body
            .iter()
            .filter_map(|statement| assigner_function_name(statement, &bindings))
            .collect()
    }

    fn swc_names(source: &str, bindings: &[&str]) -> Vec<String> {
        let bindings = bindings
            .iter()
            .map(|name| name.to_string())
            .collect::<HashSet<_>>();
        super::super::assigners::assigner_function_names_for_test(source, &bindings)
    }

    #[test]
    fn every_assignment_target_shape_matches_the_swc_contract() {
        let source = concat!(
            "function plain() { state = 1; }\n",
            "function compound() { state += 1; }\n",
            "function update() { ++state; }\n",
            "function array() { [state] = values; }\n",
            "function defaulted() { [state = 1] = values; }\n",
            "function object() { ({value: state} = source); }\n",
            "function shorthand() { ({state} = source); }\n",
            "function rest() { ({...state} = source); }\n",
            "function forOf() { for (state of values) {} }\n",
            "function forIn() { for (state in source) {} }\n",
            "function declaredLoop() { for (let state of values) {} }\n",
            "function member() { state.value = 1; state.value++; }\n",
            "const arrow = () => { state = 2; };\n",
            "const fn = function () { return () => { state ??= 3; }; };\n",
        );
        let oxc = names(source, &["state"]);
        assert_eq!(oxc, swc_names(source, &["state"]));
        assert_eq!(
            oxc,
            vec![
                "plain",
                "compound",
                "update",
                "array",
                "defaulted",
                "object",
                "shorthand",
                "rest",
                "forOf",
                "forIn",
                "arrow",
                "fn",
            ]
        );
    }

    #[test]
    fn annotated_chunk_reader_preserves_source_order_and_callable_shapes() {
        let chunk = concat!(
            "/** @noinline */\nfunction first(){}\n",
            "const plain = 1;\n",
            "/** @pureOrBreakMyCode @noinline */\nconst second=()=>{}, third=function(){};\n",
            "function ignored(){}\n",
        );
        assert_eq!(
            collect_annotated_assigner_names(chunk),
            vec!["first", "second", "third"]
        );
    }

    #[test]
    fn malformed_chunk_is_fail_closed() {
        assert!(collect_annotated_assigner_names("function {").is_empty());
    }
}
