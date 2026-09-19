use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn, FromIn};
use oxc_ast::ast::{
    AssignmentTarget, AssignmentTargetMaybeDefault, AssignmentTargetProperty, BindingIdentifier,
    BindingPattern, BindingProperty, Declaration, ExportDefaultDeclarationKind, Expression,
    IdentifierReference, ObjectProperty, Program, PropertyKey, Statement,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_str::Ident;

use super::super::emit_helpers::{canonical_shared_helper_name, helper_initializer_source};
use super::super::emit_runtime::binding_names_with_ids;
use super::super::hoist::suffixed_name;
use super::super::identity::{BindingKeyMap, ModuleIdentity};

const SHARED_PRIVATE_SLOT_NAME: &str = "gccPrivateSlot$$shared";
const SHARED_PRIVATE_HELPERS_NAME: &str = "babelHelpers$$shared";

pub(super) struct TopLevelRenames {
    pub(super) renames: BindingKeyMap<String>,
    pub(super) shared_helper_names: HashSet<String>,
}

pub(super) fn collect_top_level_renames(
    program: &Program<'_>,
    ordinal: usize,
) -> Result<TopLevelRenames, String> {
    let mut renames = HashMap::new();
    let mut shared_helper_names = HashSet::new();
    for statement in &program.body {
        if let Statement::ClassDeclaration(class) = statement {
            if let Some(binding) = &class.id {
                if binding.name == "gccPrivateSlot" {
                    renames.insert(
                        ModuleIdentity::key_of_binding(binding)?,
                        SHARED_PRIVATE_SLOT_NAME.to_string(),
                    );
                    shared_helper_names.insert(SHARED_PRIVATE_SLOT_NAME.to_string());
                }
            }
            continue;
        }
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        let [declarator] = declaration.declarations.as_slice() else {
            continue;
        };
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            continue;
        };
        if binding.name == "babelHelpers" {
            renames.insert(
                ModuleIdentity::key_of_binding(binding)?,
                SHARED_PRIVATE_HELPERS_NAME.to_string(),
            );
            shared_helper_names.insert(SHARED_PRIVATE_HELPERS_NAME.to_string());
            continue;
        }
        let Some(initializer_source) = helper_initializer_source(declaration) else {
            continue;
        };
        let canonical_name =
            canonical_shared_helper_name(binding.name.as_str(), &initializer_source);
        renames.insert(
            ModuleIdentity::key_of_binding(binding)?,
            canonical_name.clone(),
        );
        shared_helper_names.insert(canonical_name);
    }

    let add_declaration = |declaration: &Declaration<'_>,
                           renames: &mut BindingKeyMap<String>|
     -> Result<(), String> {
        match declaration {
            Declaration::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    for (binding, name) in binding_names_with_ids(&declarator.id)? {
                        renames
                            .entry(binding)
                            .or_insert_with(|| suffixed_name(&name, ordinal));
                    }
                }
            }
            Declaration::FunctionDeclaration(function) => {
                if let Some(binding) = &function.id {
                    renames.insert(
                        ModuleIdentity::key_of_binding(binding)?,
                        suffixed_name(binding.name.as_str(), ordinal),
                    );
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(binding) = &class.id {
                    if binding.name != "gccPrivateSlot" {
                        renames.insert(
                            ModuleIdentity::key_of_binding(binding)?,
                            suffixed_name(binding.name.as_str(), ordinal),
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    };
    for statement in &program.body {
        if let Some(declaration) = statement.as_declaration() {
            add_declaration(declaration, &mut renames)?;
            continue;
        }
        match statement {
            Statement::ExportDeclaration(export) => {
                add_declaration(&export.declaration, &mut renames)?;
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        renames.insert(
                            ModuleIdentity::key_of_binding(binding)?,
                            suffixed_name(binding.name.as_str(), ordinal),
                        );
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        renames.insert(
                            ModuleIdentity::key_of_binding(binding)?,
                            suffixed_name(binding.name.as_str(), ordinal),
                        );
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(TopLevelRenames {
        renames,
        shared_helper_names,
    })
}

pub(super) fn apply_top_level_renames<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &mut ModuleIdentity,
    renames: &BindingKeyMap<String>,
) -> Result<(), String> {
    if renames.is_empty() {
        return Ok(());
    }
    for (binding, name) in renames {
        identity.rename(*binding, Ident::from_in(name, allocator));
    }
    let mut visitor = TopLevelRenameVisitor {
        allocator,
        identity,
        renames,
        error: None,
    };
    visitor.visit_program(program);
    match visitor.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

struct TopLevelRenameVisitor<'a, 'i> {
    allocator: &'a Allocator,
    identity: &'i ModuleIdentity,
    renames: &'i BindingKeyMap<String>,
    error: Option<String>,
}

impl TopLevelRenameVisitor<'_, '_> {
    fn binding_name(&self, binding: &BindingIdentifier<'_>) -> Result<Option<&str>, String> {
        Ok(self
            .renames
            .get(&ModuleIdentity::key_of_binding(binding)?)
            .map(String::as_str))
    }

    fn reference_name(&self, reference: &IdentifierReference<'_>) -> Option<&str> {
        self.identity
            .key_of_reference(reference)
            .and_then(|binding| self.renames.get(&binding))
            .map(String::as_str)
    }
}

impl<'a> VisitMut<'a> for TopLevelRenameVisitor<'a, '_> {
    fn visit_binding_identifier(&mut self, binding: &mut BindingIdentifier<'a>) {
        match self.binding_name(binding) {
            Ok(Some(name)) => binding.name = Ident::from_in(name, self.allocator),
            Ok(None) => {}
            Err(error) => {
                self.error.get_or_insert(error);
            }
        }
    }

    fn visit_identifier_reference(&mut self, reference: &mut IdentifierReference<'a>) {
        if let Some(name) = self.reference_name(reference) {
            reference.name = Ident::from_in(name, self.allocator);
        }
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(reference) = &property.value {
                if self.reference_name(reference).is_some() {
                    property.shorthand = false;
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        if property.shorthand {
            if let Some(binding) = immediate_binding(&property.value) {
                match self.binding_name(binding) {
                    Ok(Some(_)) => property.shorthand = false,
                    Ok(None) => {}
                    Err(error) => {
                        self.error.get_or_insert(error);
                        return;
                    }
                }
            }
        }
        walk_mut::walk_binding_property(self, property);
    }

    fn visit_assignment_target_property(&mut self, property: &mut AssignmentTargetProperty<'a>) {
        let AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) = property
        else {
            walk_mut::walk_assignment_target_property(self, property);
            return;
        };
        let Some(reference_id) = shorthand
            .binding
            .reference_id
            .get()
            .filter(|_| self.reference_name(&shorthand.binding).is_some())
        else {
            walk_mut::walk_assignment_target_property(self, property);
            return;
        };

        let builder = AstBuilder::new(self.allocator);
        let span = shorthand.span;
        let binding_span = shorthand.binding.span;
        let binding_name = shorthand.binding.name.as_str();
        let name = PropertyKey::new_static_identifier(
            binding_span,
            Ident::from_in(binding_name, self.allocator),
            &builder,
        );
        let binding = match &shorthand.init {
            Some(init) => AssignmentTargetMaybeDefault::new_assignment_target_with_default(
                span,
                AssignmentTarget::new_assignment_target_identifier_with_reference_id(
                    binding_span,
                    Ident::from_in(binding_name, self.allocator),
                    reference_id,
                    &builder,
                ),
                init.clone_in(self.allocator),
                &builder,
            ),
            None => {
                AssignmentTargetMaybeDefault::new_assignment_target_identifier_with_reference_id(
                    binding_span,
                    Ident::from_in(binding_name, self.allocator),
                    reference_id,
                    &builder,
                )
            }
        };
        *property = AssignmentTargetProperty::new_assignment_target_property_property(
            span, name, binding, false, &builder,
        );
        walk_mut::walk_assignment_target_property(self, property);
    }
}

fn immediate_binding<'b, 'a>(pattern: &'b BindingPattern<'a>) -> Option<&'b BindingIdentifier<'a>> {
    match pattern {
        BindingPattern::BindingIdentifier(binding) => Some(binding),
        BindingPattern::AssignmentPattern(assignment) => immediate_binding(&assignment.left),
        _ => None,
    }
}
