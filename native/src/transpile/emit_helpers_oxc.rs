//! Oxc counterpart of `emit_helpers.rs`.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashSet};

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_codegen::{Codegen, Gen};

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
    let Statement::VariableDeclaration(declaration) = statement else {
        return None;
    };
    let [declarator] = declaration.declarations.as_slice() else {
        return None;
    };
    let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
        return None;
    };
    canonical_names
        .contains(binding.name.as_str())
        .then(|| binding.name.to_string())
}

fn print_statement(statement: &Statement<'_>) -> String {
    let mut codegen = Codegen::new();
    statement.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
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
        let source = format!("var {canonical} = function(a) {{ return a; }};\nvar keep = 1;");
        let mut program = parse(&allocator, &source);
        let taken = take_shared_helper_declarations(
            &allocator,
            &mut program,
            &HashSet::from([canonical.clone()]),
        );
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].canonical_name, canonical);
        assert!(taken[0].text.contains("function"), "{:?}", taken[0]);
        assert_eq!(program.body.len(), 1);
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
