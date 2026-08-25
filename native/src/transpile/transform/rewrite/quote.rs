use std::collections::{HashMap, HashSet};

use oxc_allocator::FromIn;
use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::{BindingPattern, Expression, Statement};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Str;

use super::super::super::identity::{BindingKey, BindingKeySet, ModuleIdentity};
use super::super::super::lowering::EnumValue;

pub(crate) fn quote_runtime_enum_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    enum_values: &HashMap<String, HashMap<String, EnumValue>>,
) {
    let mut bindings = HashMap::<BindingKey, HashSet<String>>::new();
    for statement in &program.body {
        let declaration = match statement {
            Statement::VariableDeclaration(declaration) => Some(&**declaration),
            Statement::ExportNamedDeclaration(export) => match export.declaration.as_ref() {
                Some(oxc_ast::ast::Declaration::VariableDeclaration(declaration)) => {
                    Some(&**declaration)
                }
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
                identity.key_of_binding(binding),
                members.keys().cloned().collect(),
            );
        }
    }
    if bindings.is_empty() {
        return;
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
            let property = member.property.name.to_string();
            if !self
                .bindings
                .get(&binding)
                .is_some_and(|members| members.contains(&property))
            {
                return;
            }
            let object = member.object.take_in(&self.builder);
            let key = Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            );
            *expression =
                Expression::new_computed_member_expression(SPAN, object, key, false, &self.builder);
        }
    }
    EnumMemberQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        bindings,
    }
    .visit_program(program);
}

pub(crate) fn quote_opaque_commonjs_members<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
    identity: &ModuleIdentity,
    names: &HashSet<String>,
) {
    if names.is_empty() {
        return;
    }
    let mut bindings = BindingKeySet::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = specifier.local();
                    if names.contains(local.name.as_str()) {
                        bindings.insert(identity.key_of_binding(local));
                    }
                }
            }
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    if let BindingPattern::BindingIdentifier(binding) = &declarator.id {
                        if names.contains(binding.name.as_str()) {
                            bindings.insert(identity.key_of_binding(binding));
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
        let property = member.property.name.to_string();
        let optional = member.optional;
        let object = std::mem::replace(
            &mut member.object,
            Expression::new_null_literal(SPAN, &self.builder),
        );
        *expression = Expression::new_computed_member_expression(
            SPAN,
            object,
            Expression::new_string_literal(
                SPAN,
                Str::from_in(&property, self.allocator),
                None,
                &self.builder,
            ),
            optional,
            &self.builder,
        );
    }
}
