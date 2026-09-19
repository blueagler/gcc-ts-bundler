use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, FromIn, ReplaceWith};
use oxc_ast::ast::{BindingPattern, Expression, Statement};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Str;

use super::super::super::identity::{BindingKey, BindingKeySet, ModuleIdentity};
use super::super::super::lowering::EnumValues;

pub(crate) fn quote_runtime_enum_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    enum_values: &EnumValues,
) -> Result<(), String> {
    let mut bindings = HashMap::<BindingKey, HashSet<String>>::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::VariableDeclaration(declaration) => Some(&**declaration),
            Statement::ExportDeclaration(export) => match &export.declaration {
                oxc_ast::ast::Declaration::VariableDeclaration(declaration) => Some(&**declaration),
                _ => None,
            },
            _ => None,
        };
        let Some(declaration) = declaration else {
            continue;
        };
        for declarator in &declaration.declarations {
            let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                continue;
            };
            let Some(members) = enum_values.get(binding.name.as_str()) else {
                continue;
            };
            bindings.insert(
                ModuleIdentity::key_of_binding(binding)?,
                members.keys().cloned().collect(),
            );
        }
    }
    if bindings.is_empty() {
        return Ok(());
    }
    struct EnumMemberQuoter<'a, 'i> {
        allocator: &'a Allocator,
        builder: AstBuilder<'a>,
        identity: &'i ModuleIdentity,
        bindings: HashMap<BindingKey, HashSet<String>>,
    }
    impl<'a> VisitMut<'a> for EnumMemberQuoter<'a, '_> {
        fn visit_expression(&mut self, expression: &mut Expression<'a>) {
            walk_mut::walk_expression(self, expression);
            let Expression::StaticMemberExpression(member) = expression else {
                return;
            };
            let Expression::Identifier(object) = &member.object else {
                return;
            };
            let Some(binding) = self.identity.key_of_reference(object) else {
                return;
            };
            if !self
                .bindings
                .get(&binding)
                .is_some_and(|members| members.contains(member.property.name.as_str()))
            {
                return;
            }
            expression.replace_with(|expression| match expression {
                Expression::StaticMemberExpression(member) => {
                    let member = member.unbox();
                    let key = Expression::new_string_literal(
                        SPAN,
                        Str::from_in(member.property.name.as_str(), self.allocator),
                        None,
                        &self.builder,
                    );
                    Expression::new_computed_member_expression(
                        SPAN,
                        member.object,
                        key,
                        member.optional,
                        &self.builder,
                    )
                }
                expression => expression,
            });
        }
    }
    EnumMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        bindings,
    }
    .visit_program(program);
    Ok(())
}

pub(crate) fn quote_opaque_commonjs_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    names: &HashSet<String>,
) -> Result<(), String> {
    if names.is_empty() {
        return Ok(());
    }
    let mut bindings = BindingKeySet::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = specifier.local();
                    if names.contains(local.name.as_str()) {
                        bindings.insert(ModuleIdentity::key_of_binding(local)?);
                    }
                }
            }
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                        if names.contains(binding.name.as_str()) {
                            bindings.insert(ModuleIdentity::key_of_binding(binding)?);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    OpaqueCommonJsMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        bindings,
        identity,
    }
    .visit_program(program);
    Ok(())
}

struct OpaqueCommonJsMemberQuoter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    bindings: BindingKeySet,
    identity: &'i ModuleIdentity,
}

impl<'a> VisitMut<'a> for OpaqueCommonJsMemberQuoter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        let Expression::Identifier(object) = &member.object else {
            return;
        };
        if !self
            .identity
            .key_of_reference(object)
            .is_some_and(|binding| self.bindings.contains(&binding))
        {
            return;
        }
        expression.replace_with(|expression| match expression {
            Expression::StaticMemberExpression(member) => {
                let member = member.unbox();
                Expression::new_computed_member_expression(
                    SPAN,
                    member.object,
                    Expression::new_string_literal(
                        SPAN,
                        Str::from_in(member.property.name.as_str(), self.allocator),
                        None,
                        &self.builder,
                    ),
                    member.optional,
                    &self.builder,
                )
            }
            expression => expression,
        });
    }
}
