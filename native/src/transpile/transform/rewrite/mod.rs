mod imports;
mod quote;

use std::collections::HashSet;

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::Statement;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::Visit;

use super::super::identity::{BindingKeySet, ModuleIdentity};

pub(crate) use imports::{collect_imported_enum_values, rewrite_dynamic_imports};
pub(crate) use quote::{quote_opaque_commonjs_members, quote_runtime_enum_members};

pub(crate) fn rewrite_ts_export_assignments<'a>(
    allocator: &'a Allocator,
    program: &mut oxc_ast::ast::Program<'a>,
) {
    let builder = AstBuilder::new(allocator);
    for statement in &mut program.body {
        let Statement::TSExportAssignment(assignment) = statement else {
            continue;
        };
        let span = assignment.span;
        let expression = assignment.expression.take_in(&builder);
        *statement = Statement::new_export_default_declaration(
            span,
            oxc_ast::ast::ExportDefaultDeclarationKind::from(expression),
            &builder,
        );
    }
}

pub(crate) fn remove_unused_imported_enums(
    program: &mut oxc_ast::ast::Program<'_>,
    identity: &ModuleIdentity,
    imported_enum_names: &HashSet<String>,
) {
    if imported_enum_names.is_empty() {
        return;
    }
    let mut references = BindingKeySet::default();
    struct ReferenceCollector<'a> {
        identity: &'a ModuleIdentity,
        references: &'a mut BindingKeySet,
    }
    impl<'a> Visit<'a> for ReferenceCollector<'_> {
        fn visit_identifier_reference(
            &mut self,
            reference: &oxc_ast::ast::IdentifierReference<'a>,
        ) {
            if let Some(key) = self.identity.key_of_reference(reference) {
                self.references.insert(key);
            }
        }
    }
    ReferenceCollector {
        identity,
        references: &mut references,
    }
    .visit_program(program);
    program.body.retain_mut(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return true;
        };
        let Some(specifiers) = import.specifiers.as_mut() else {
            return true;
        };
        specifiers.retain(|specifier| {
            let local = specifier.local();
            !imported_enum_names.contains(local.name.as_str())
                || references.contains(&identity.key_of_binding(local))
        });
        !specifiers.is_empty()
    });
}
