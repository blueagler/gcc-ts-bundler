//! Oxc counterpart of `emit_helpers.rs`.

use std::collections::{BTreeSet, HashSet};

use oxc_allocator::{Allocator, FromIn, TakeIn, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_span::SPAN;
use oxc_str::Ident;
use oxc_syntax::operator::AssignmentOperator;

use super::emit_helpers::{is_shared_helper_base_name, SharedHelperDeclaration};

pub(super) fn helper_initializer_source(declaration: &VariableDeclaration<'_>) -> Option<String> {
    let [declarator] = declaration.declarations.as_slice() else {
        return None;
    };
    let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
        return None;
    };
    if !is_shared_helper_base_name(binding.name.as_str()) {
        return None;
    }
    let initializer = declarator.init.as_ref()?;
    if !is_helper_initializer(initializer) {
        return None;
    }
    let mut codegen = Codegen::new();
    codegen.print_expression(initializer);
    Some(codegen.into_source_text())
}

fn is_helper_initializer(initializer: &Expression<'_>) -> bool {
    match initializer {
        Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => true,
        Expression::LogicalExpression(logical) => is_helper_initializer(&logical.right),
        Expression::ParenthesizedExpression(parenthesized) => {
            is_helper_initializer(&parenthesized.expression)
        }
        _ => false,
    }
}

pub(super) fn take_shared_helper_declarations<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    canonical_names: &HashSet<String>,
) -> Vec<SharedHelperDeclaration> {
    if canonical_names.is_empty() {
        return Vec::new();
    }
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    let mut kept = ArenaVec::with_capacity_in(body.len(), &allocator);
    let mut taken = Vec::new();
    for statement in body {
        let Some(name) = pooled_declaration_name(&statement, canonical_names) else {
            kept.push(statement);
            continue;
        };
        taken.push(SharedHelperDeclaration {
            canonical_name: name,
            text: print_statement(&statement).trim().to_string(),
        });
    }
    program.body = kept;
    taken
}

fn pooled_declaration_name(
    statement: &Statement<'_>,
    canonical_names: &HashSet<String>,
) -> Option<String> {
    let binding_name = match statement {
        Statement::VariableDeclaration(declaration) => {
            let [declarator] = declaration.declarations.as_slice() else {
                return None;
            };
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                return None;
            };
            binding.name.as_str()
        }
        Statement::ClassDeclaration(class) => class.id.as_ref()?.name.as_str(),
        _ => return None,
    };
    canonical_names
        .contains(binding_name)
        .then(|| binding_name.to_string())
}

fn print_statement(statement: &Statement<'_>) -> String {
    let mut codegen = Codegen::new();
    statement.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

pub(super) fn collect_lowered_define_property_names(program: &Program<'_>) -> BTreeSet<String> {
    let mut collector = LoweredDefinePropertyNames {
        names: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.names
}

/// Turn identifier `defineProperty(this, "x", v)` / `__publicField(this, "x", v)`
/// into `this.x = v` so the key is no longer string-defined.
///
/// Only statement-level calls on `this` with an identifier key. Nested calls
/// keep the helper return value. `Object.defineProperty` stays a descriptor
/// write.
pub(super) fn rewrite_this_field_helper_assignments<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
) {
    ThisFieldHelperRewriter {
        allocator,
        builder: AstBuilder::new(allocator),
    }
    .visit_program(program);
}

struct ThisFieldHelperRewriter<'a> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
}

impl<'a> ThisFieldHelperRewriter<'a> {
    fn rewrite_statement_call(&self, expression: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::CallExpression(call) = expression else {
            return None;
        };
        if !is_named_field_helper_callee(&call.callee) || call.arguments.len() < 3 {
            return None;
        }
        let receiver = call.arguments.first().and_then(Argument::as_expression)?;
        if !matches!(
            receiver.without_parentheses(),
            Expression::ThisExpression(_)
        ) {
            return None;
        }
        let key = call.arguments.get(1).and_then(Argument::as_expression)?;
        let Expression::StringLiteral(literal) = key.without_parentheses() else {
            return None;
        };
        let name = literal.value.as_str();
        if !is_identifier_property_name(name) {
            return None;
        }
        let this_expr = call
            .arguments
            .first_mut()
            .and_then(Argument::as_expression_mut)?
            .take_in(&self.builder);
        let value = call
            .arguments
            .get_mut(2)
            .and_then(Argument::as_expression_mut)?
            .take_in(&self.builder);
        let property =
            IdentifierName::new(SPAN, Ident::from_in(name, self.allocator), &self.builder);
        Some(Expression::new_assignment_expression(
            SPAN,
            AssignmentOperator::Assign,
            AssignmentTarget::new_static_member_expression(
                SPAN,
                this_expr,
                property,
                false,
                &self.builder,
            ),
            value,
            &self.builder,
        ))
    }
}

impl<'a> VisitMut<'a> for ThisFieldHelperRewriter<'a> {
    fn visit_expression_statement(&mut self, statement: &mut ExpressionStatement<'a>) {
        if let Some(assignment) = self.rewrite_statement_call(&mut statement.expression) {
            statement.expression = assignment;
            return;
        }
        walk_mut::walk_expression_statement(self, statement);
    }
}

fn is_named_field_helper_callee(callee: &Expression<'_>) -> bool {
    match callee.without_parentheses() {
        Expression::Identifier(identifier) => is_field_helper_binding_name(&identifier.name),
        Expression::StaticMemberExpression(member) => {
            let property = member.property.name.as_str();
            match property {
                "default" => matches!(
                    member.object.without_parentheses(),
                    Expression::Identifier(identifier)
                        if is_field_helper_binding_name(&identifier.name)
                ),
                "defineProperty" => matches!(
                    member.object.without_parentheses(),
                    Expression::Identifier(identifier)
                        if is_babel_helpers_binding_name(&identifier.name)
                ),
                _ => false,
            }
        }
        _ => false,
    }
}

fn is_field_helper_binding_name(name: &str) -> bool {
    name.starts_with("__publicField") || is_define_property_helper_name(name)
}

fn is_define_property_helper_name(name: &str) -> bool {
    let trimmed = name.trim_start_matches('_');
    trimmed == "defineProperty"
        || trimmed
            .strip_prefix("defineProperty")
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            })
}

fn is_babel_helpers_binding_name(name: &str) -> bool {
    name == "babelHelpers" || name.starts_with("babelHelpers$$")
}

fn is_identifier_property_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

struct LoweredDefinePropertyNames {
    names: BTreeSet<String>,
}

impl<'a> Visit<'a> for LoweredDefinePropertyNames {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        let Expression::StaticMemberExpression(callee) = &call.callee else {
            return;
        };
        let Expression::Identifier(object) = &callee.object else {
            return;
        };
        if object.name != "babelHelpers" || callee.property.name != "defineProperty" {
            return;
        }
        if let Some(Expression::StringLiteral(key)) =
            call.arguments.get(1).and_then(Argument::as_expression)
        {
            self.names.insert(key.value.to_string());
        }
    }
}

pub(super) fn collect_decorator_metadata_property_names(program: &Program<'_>) -> BTreeSet<String> {
    let mut collector = DecoratorMetadataNames {
        names: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.names
}

struct DecoratorMetadataNames {
    names: BTreeSet<String>,
}

impl<'a> Visit<'a> for DecoratorMetadataNames {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        walk::walk_call_expression(self, call);
        let Expression::Identifier(identifier) = &call.callee else {
            return;
        };
        if is_legacy_decorator_helper_name(identifier.name.as_str()) {
            if let Some(Expression::StringLiteral(literal)) =
                call.arguments.get(2).and_then(Argument::as_expression)
            {
                self.names.insert(literal.value.to_string());
            }
            return;
        }
        if identifier.name != "__esDecorate" {
            return;
        }
        let Some(Expression::ObjectExpression(object)) =
            call.arguments.get(3).and_then(Argument::as_expression)
        else {
            return;
        };
        for property in &object.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            if property.kind != PropertyKind::Init || property.method || property.shorthand {
                continue;
            }
            if property_key_name(&property.key).as_deref() != Some("name") {
                continue;
            }
            if let Expression::StringLiteral(literal) = &property.value {
                self.names.insert(literal.value.to_string());
            }
        }
    }
}

fn is_legacy_decorator_helper_name(name: &str) -> bool {
    let trimmed = name.trim_start_matches('_');
    let trimmed = trimmed.strip_prefix("ts_").unwrap_or(trimmed);
    trimmed.starts_with("decorate")
}

fn property_key_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> Program<'a> {
        let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        parsed.program
    }

    #[test]
    fn helper_initializer_printing_and_pooling_use_oxc_codegen() {
        let allocator = Allocator::default();
        let source = r#"
var __runInitializers = function(a) { return a; };
var __esDecorate = (this && this.__esDecorate) || function(a, b) { return a; };
var ordinary = function(a) { return a; };
"#;
        let program = parse(&allocator, source);
        let initializers = program
            .body
            .iter()
            .filter_map(|statement| {
                let Statement::VariableDeclaration(declaration) = statement else {
                    return None;
                };
                helper_initializer_source(declaration)
            })
            .collect::<Vec<_>>();
        assert_eq!(initializers.len(), 2);
        let canonical = super::super::emit_helpers::canonical_shared_helper_name(
            "__runInitializers",
            &initializers[0],
        );

        let allocator = Allocator::default();
        let shared_class = "gccPrivateSlot$$shared";
        let source = format!(
            "var {canonical} = function(a) {{ return a; }};\nclass {shared_class} {{}}\nvar keep = 1;"
        );
        let mut program = parse(&allocator, &source);
        let taken = take_shared_helper_declarations(
            &allocator,
            &mut program,
            &HashSet::from([canonical.clone(), shared_class.to_string()]),
        );
        assert_eq!(taken.len(), 2);
        assert_eq!(taken[0].canonical_name, canonical);
        assert!(taken[0].text.contains("function"), "{:?}", taken[0]);
        assert_eq!(taken[1].canonical_name, shared_class);
        assert!(taken[1].text.contains("class"), "{:?}", taken[1]);
        assert_eq!(program.body.len(), 1);
    }

    #[test]
    fn lowered_define_property_names_are_collected() {
        let allocator = Allocator::default();
        let program = parse(
            &allocator,
            r#"babelHelpers.defineProperty(this, "current", new Map());
other.defineProperty(this, "ignored", 1);"#,
        );
        assert_eq!(
            collect_lowered_define_property_names(&program),
            BTreeSet::from(["current".to_string()])
        );
    }

    #[test]
    fn identifier_this_field_helpers_become_dotted_assigns() {
        let allocator = Allocator::default();
        let mut program = parse(
            &allocator,
            r#"babelHelpers.defineProperty(this, "is_fork", false);
__publicField(this, "map", new Map());
_defineProperty2.default(this, "interop", 1);
babelHelpers.defineProperty(this, "not-id", 1);
Object.defineProperty(this, "descriptor", { value: 1 });
keep(babelHelpers.defineProperty(this, "nested", 1));
"#,
        );
        rewrite_this_field_helper_assignments(&allocator, &mut program);
        let printed = Codegen::new().build(&program).code;
        assert!(printed.contains("this.is_fork = false"), "{printed}");
        assert!(printed.contains("this.map ="), "{printed}");
        assert!(printed.contains("this.interop = 1"), "{printed}");
        assert!(
            printed.contains(r#"babelHelpers.defineProperty(this, "not-id""#),
            "{printed}"
        );
        assert!(
            printed.contains(r#"Object.defineProperty(this, "descriptor""#),
            "{printed}"
        );
        assert!(
            printed.contains(r#"babelHelpers.defineProperty(this, "nested""#),
            "{printed}"
        );
        assert_eq!(
            collect_lowered_define_property_names(&program),
            BTreeSet::from(["not-id".to_string(), "nested".to_string()])
        );
    }

    #[test]
    fn decorator_metadata_names_are_collected() {
        let source = r#"
__decorateClass([], Example.prototype, "legacy", void 0);
__esDecorate(null, null, null, { kind: "field", name: "modern" }, null, null);
_ts_decorate([], Example.prototype, "swcLegacy", void 0);
"#;
        let allocator = Allocator::default();
        let program = parse(&allocator, source);
        let oxc = collect_decorator_metadata_property_names(&program);
        assert_eq!(
            oxc,
            BTreeSet::from([
                "legacy".to_string(),
                "modern".to_string(),
                "swcLegacy".to_string(),
            ])
        );
    }
}
