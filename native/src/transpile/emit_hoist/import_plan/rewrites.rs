use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::SPAN;
use oxc_str::Ident;
use oxc_syntax::number::NumberBase;

use super::super::super::identity::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::super::super::imports_exports::ImportBindingSlotAlias;

#[derive(Clone, Debug)]
pub(crate) enum ImportReplacement {
    Name(String),
    Slot(ImportBindingSlotAlias),
}

#[derive(Clone, Debug)]
pub(crate) struct ImportBindingRewrite {
    pub(crate) binding_id: BindingKey,
    pub(crate) replacement: ImportReplacement,
    pub(crate) replacement_code: String,
}

impl ImportBindingRewrite {
    pub(crate) fn slot_alias(&self) -> Option<&ImportBindingSlotAlias> {
        match &self.replacement {
            ImportReplacement::Name(_) => None,
            ImportReplacement::Slot(alias) => Some(alias),
        }
    }
}

pub(crate) fn apply_import_binding_rewrites<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    rewrites: &[ImportBindingRewrite],
) {
    if rewrites.is_empty() {
        return;
    }
    ImportBindingRewriteVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        rewrites: rewrites
            .iter()
            .map(|rewrite| (rewrite.binding_id, rewrite.replacement.clone()))
            .collect(),
    }
    .visit_program(program);
}

struct ImportBindingRewriteVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    rewrites: BindingKeyMap<ImportReplacement>,
}

impl<'a> ImportBindingRewriteVisitor<'a, '_> {
    fn replacement(&self, replacement: &ImportReplacement) -> Expression<'a> {
        match replacement {
            ImportReplacement::Name(name) => Expression::new_identifier(
                SPAN,
                Ident::from_in(name, self.allocator),
                &self.builder,
            ),
            ImportReplacement::Slot(alias) => {
                let object = Expression::new_identifier(
                    SPAN,
                    Ident::from_in(&alias.source_object_name, self.allocator),
                    &self.builder,
                );
                let slot = Expression::new_numeric_literal(
                    SPAN,
                    alias.source_slot as f64,
                    None,
                    NumberBase::Decimal,
                    &self.builder,
                );
                Expression::new_computed_member_expression(SPAN, object, slot, false, &self.builder)
            }
        }
    }
}

impl<'a> VisitMut<'a> for ImportBindingRewriteVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::Identifier(identifier) = expression {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                if let Some(replacement) = self.rewrites.get(&binding) {
                    *expression = self.replacement(replacement);
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(identifier) = &property.value {
                if let Some(binding) = self.identity.key_of_reference(identifier) {
                    if let Some(replacement) = self.rewrites.get(&binding) {
                        property.shorthand = false;
                        property.value = self.replacement(replacement);
                        return;
                    }
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }
}
