use std::collections::HashSet;

use oxc_allocator::{Allocator, FromIn, ReplaceWith, Vec};
use oxc_ast::ast::{
    Argument, ArrowFunctionBody, ArrowFunctionExpression, AssignmentTarget, BindingPattern,
    BindingProperty, Expression, ForStatementLeft, FormalParameterKind, FormalParameters, Function,
    FunctionType, IdentifierName, ModuleExportName, ObjectPattern, Program, PropertyKey, Statement,
    VariableDeclarationKind, VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::{GetSpan, SPAN};
use oxc_str::{Ident, Str};
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, LogicalOperator};

use crate::transpile::commonjs::variable_statement;
use crate::transpile::ChunkMode;

pub(crate) fn apply_compatibility_transforms<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    chunk_mode: ChunkMode,
    used: &mut HashSet<String>,
) {
    CompatibilityRewriter {
        allocator,
        builder: AstBuilder::new(allocator),
        wrap_throws: chunk_mode == ChunkMode::Off,
        used,
    }
    .visit_program(program);
}

struct CompatibilityRewriter<'a, 'u> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    wrap_throws: bool,
    used: &'u mut HashSet<String>,
}

impl<'a> CompatibilityRewriter<'a, '_> {
    fn identifier(&self, name: &str) -> Expression<'a> {
        Expression::new_identifier(SPAN, Ident::from_in(name, self.allocator), &self.builder)
    }

    fn reflected_key(&self, key: &str, props: &str) -> Expression<'a> {
        let reflect = Expression::new_static_member_expression(
            SPAN,
            self.identifier("goog"),
            IdentifierName::new(SPAN, "reflect", &self.builder),
            false,
            &self.builder,
        );
        let callee = Expression::new_static_member_expression(
            SPAN,
            reflect,
            IdentifierName::new(SPAN, "objectProperty", &self.builder),
            false,
            &self.builder,
        );
        Expression::new_call_expression(
            SPAN,
            callee,
            None,
            [
                Argument::from(Expression::new_string_literal(
                    SPAN,
                    Str::from_in(key, self.allocator),
                    None,
                    &self.builder,
                )),
                Argument::from(self.identifier(props)),
            ],
            false,
            &self.builder,
        )
    }

    fn component_setup(
        &mut self,
        mut pattern: ObjectPattern<'a>,
        props: &str,
    ) -> Vec<'a, Statement<'a>> {
        let mut setup = Vec::new_in(&self.allocator);
        let simple = pattern.properties.iter().all(|property| {
            !property.computed
                && matches!(
                    &property.key,
                    PropertyKey::StaticIdentifier(_) | PropertyKey::StringLiteral(_)
                )
                && matches!(&property.value, BindingPattern::BindingIdentifier(_))
        }) && pattern
            .rest
            .as_ref()
            .is_none_or(|rest| matches!(&rest.argument, BindingPattern::BindingIdentifier(_)));
        if !simple {
            // Keep defaults, nested patterns and computed keys as AST rather
            // than regenerating text; only literal keys are protected.
            PatternKeyQuoter {
                allocator: self.allocator,
                builder: AstBuilder::new(self.allocator),
            }
            .visit_object_pattern(&mut pattern);
            setup.push(variable_statement(
                &self.builder,
                SPAN,
                VariableDeclarationKind::Const,
                BindingPattern::ObjectPattern(oxc_allocator::Box::new_in(pattern, &self.allocator)),
                self.identifier(props),
            ));
            return setup;
        }
        let mut omitted = std::vec::Vec::new();
        for property in pattern.properties {
            let key = match &property.key {
                PropertyKey::StaticIdentifier(identifier) => identifier.name.as_str(),
                PropertyKey::StringLiteral(literal) => literal.value.as_str(),
                _ => unreachable!("simple component property"),
            };
            omitted.push(key.to_string());
            let access = Expression::new_computed_member_expression(
                SPAN,
                self.identifier(props),
                self.reflected_key(key, props),
                false,
                &self.builder,
            );
            setup.push(variable_statement(
                &self.builder,
                SPAN,
                VariableDeclarationKind::Const,
                property.value,
                access,
            ));
        }
        if let Some(rest) = pattern.rest {
            let BindingPattern::BindingIdentifier(binding) = rest.unbox().argument else {
                unreachable!("simple component rest");
            };
            let rest_name = binding.name.to_string();
            setup.push(variable_statement(
                &self.builder,
                SPAN,
                VariableDeclarationKind::Const,
                BindingPattern::BindingIdentifier(binding),
                Expression::new_object_expression(SPAN, [], &self.builder),
            ));
            let key = fresh_name(self.used, "key");
            let mut guards = omitted.iter().map(|omitted| {
                Expression::new_binary_expression(
                    SPAN,
                    self.identifier(&key),
                    BinaryOperator::StrictInequality,
                    self.reflected_key(omitted, props),
                    &self.builder,
                )
            });
            let guard = guards.next().map_or_else(
                || Expression::new_boolean_literal(SPAN, true, &self.builder),
                |first| {
                    guards.fold(first, |left, right| {
                        Expression::new_logical_expression(
                            SPAN,
                            left,
                            LogicalOperator::And,
                            right,
                            &self.builder,
                        )
                    })
                },
            );
            let copy = Statement::new_expression_statement(
                SPAN,
                Expression::new_assignment_expression(
                    SPAN,
                    AssignmentOperator::Assign,
                    AssignmentTarget::new_computed_member_expression(
                        SPAN,
                        self.identifier(&rest_name),
                        self.identifier(&key),
                        false,
                        &self.builder,
                    ),
                    Expression::new_computed_member_expression(
                        SPAN,
                        self.identifier(props),
                        self.identifier(&key),
                        false,
                        &self.builder,
                    ),
                    &self.builder,
                ),
                &self.builder,
            );
            setup.push(Statement::new_for_in_statement(
                SPAN,
                ForStatementLeft::new_variable_declaration(
                    SPAN,
                    VariableDeclarationKind::Const,
                    [VariableDeclarator::new(
                        SPAN,
                        BindingPattern::new_binding_identifier(
                            SPAN,
                            Ident::from_in(key.as_str(), self.allocator),
                            &self.builder,
                        ),
                        None,
                        None,
                        false,
                        &self.builder,
                    )],
                    false,
                    &self.builder,
                ),
                self.identifier(props),
                Statement::new_block_statement(
                    SPAN,
                    [Statement::new_if_statement(
                        SPAN,
                        guard,
                        copy,
                        None,
                        &self.builder,
                    )],
                    &self.builder,
                ),
                &self.builder,
            ));
        }
        setup
    }

    fn take_component_pattern(
        &mut self,
        pattern: &mut BindingPattern<'a>,
    ) -> Option<Vec<'a, Statement<'a>>> {
        if !matches!(pattern, BindingPattern::ObjectPattern(_)) {
            return None;
        }
        let props = fresh_name(self.used, "__props");
        let original = std::mem::replace(
            pattern,
            BindingPattern::new_binding_identifier(
                SPAN,
                Ident::from_in(props.as_str(), self.allocator),
                &self.builder,
            ),
        );
        let BindingPattern::ObjectPattern(pattern) = original else {
            unreachable!("component object pattern");
        };
        Some(self.component_setup(pattern.unbox(), &props))
    }

    fn rewrite_function(&mut self, function: &mut Function<'a>) {
        let Some(body) = &mut function.body else {
            return;
        };
        let Some(parameter) = function.params.items.first_mut() else {
            return;
        };
        if let Some(mut setup) = self.take_component_pattern(&mut parameter.pattern) {
            setup.extend(body.statements.drain(..));
            body.statements = setup;
        }
    }

    fn rewrite_arrow(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let Some(parameter) = arrow.params.items.first_mut() else {
            return;
        };
        let Some(mut setup) = self.take_component_pattern(&mut parameter.pattern) else {
            return;
        };
        arrow.body.replace_with(|body| match body {
            ArrowFunctionBody::FunctionBody(mut body) => {
                setup.extend(body.statements.drain(..));
                body.statements = setup;
                ArrowFunctionBody::FunctionBody(body)
            }
            body => {
                let expression = body.into_expression();
                let span = expression.span();
                setup.push(Statement::new_return_statement(
                    span,
                    Some(expression),
                    &self.builder,
                ));
                ArrowFunctionBody::new_function_body(span, [], setup, &self.builder)
            }
        });
    }
}

impl<'a> VisitMut<'a> for CompatibilityRewriter<'a, '_> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        // Walk authored children first; never revisit the generated throw.
        walk_mut::walk_statement(self, statement);
        if self.wrap_throws && matches!(statement, Statement::ThrowStatement(_)) {
            statement.replace_with(|statement| {
                let span = statement.span();
                let arrow = Expression::new_arrow_function_expression(
                    SPAN,
                    false,
                    None,
                    FormalParameters::boxed(
                        SPAN,
                        FormalParameterKind::ArrowFormalParameters,
                        [],
                        None,
                        &self.builder,
                    ),
                    None,
                    ArrowFunctionBody::new_function_body(SPAN, [], [statement], &self.builder),
                    &self.builder,
                );
                Statement::new_expression_statement(
                    span,
                    Expression::new_call_expression(SPAN, arrow, None, [], false, &self.builder),
                    &self.builder,
                )
            });
        }
    }

    fn visit_function(
        &mut self,
        function: &mut Function<'a>,
        flags: oxc_syntax::scope::ScopeFlags,
    ) {
        walk_mut::walk_function(self, function, flags);
        if function.r#type == FunctionType::FunctionDeclaration
            && function
                .id
                .as_ref()
                .is_some_and(|identifier| is_component_name(identifier.name.as_str()))
        {
            self.rewrite_function(function);
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &mut VariableDeclarator<'a>) {
        walk_mut::walk_variable_declarator(self, declarator);
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
            if is_component_name(binding.name.as_str()) {
                if let Some(initializer) = &mut declarator.init {
                    match initializer.without_parentheses_mut() {
                        Expression::FunctionExpression(function) => self.rewrite_function(function),
                        Expression::ArrowFunctionExpression(arrow) => self.rewrite_arrow(arrow),
                        _ => {}
                    }
                }
            }
        }
    }
}

struct PatternKeyQuoter<'a> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
}

impl<'a> VisitMut<'a> for PatternKeyQuoter<'a> {
    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        walk_mut::walk_binding_property(self, property);
        if !property.computed {
            if let PropertyKey::StaticIdentifier(identifier) = &property.key {
                property.key = PropertyKey::new_string_literal(
                    identifier.span,
                    Str::from_in(identifier.name.as_str(), self.allocator),
                    None,
                    &self.builder,
                );
                property.shorthand = false;
            }
        }
    }
}

fn is_component_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|character| character.is_ascii_uppercase())
}

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

pub(crate) fn fresh_name(used: &mut HashSet<String>, preferred: &str) -> String {
    if used.insert(preferred.to_string()) {
        return preferred.to_string();
    }
    let mut suffix = 1usize;
    loop {
        let candidate = format!("{preferred}_{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}
