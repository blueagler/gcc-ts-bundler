use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::*;
use oxc_ast_visit::VisitMut;
use oxc_str::Ident;

use super::super::super::fresh::FreshNameAllocator;
use super::super::super::identity::ModuleIdentity;

#[derive(Clone, Debug)]
pub(crate) struct RuntimeBindingNames {
    pub(crate) require: String,
    pub(crate) exports: String,
    pub(crate) dynamic_import: String,
    pub(crate) preload_dynamic_import: String,
    pub(crate) live: String,
}

impl RuntimeBindingNames {
    pub(crate) fn allocate<'a>(
        allocator: &'a Allocator,
        program: &mut Program<'a>,
        identity: &ModuleIdentity,
    ) -> (Self, FreshNameAllocator) {
        let generated = HashSet::from([
            "__require".to_string(),
            "__exports".to_string(),
            "__dynamicImport".to_string(),
            "__preloadDynamicImport".to_string(),
            "__live".to_string(),
        ]);
        let mut fresh_names = FreshNameAllocator::from_program_excluding_synthesized_globals(
            program, identity, &generated,
        );
        let names = Self {
            require: fresh_names.fresh("__require"),
            exports: fresh_names.fresh("__exports"),
            dynamic_import: fresh_names.fresh("__dynamicImport"),
            preload_dynamic_import: fresh_names.fresh("__preloadDynamicImport"),
            live: fresh_names.fresh("__live"),
        };
        let replacements = HashMap::from([
            ("__require".to_string(), names.require.clone()),
            ("__exports".to_string(), names.exports.clone()),
            ("__dynamicImport".to_string(), names.dynamic_import.clone()),
            (
                "__preloadDynamicImport".to_string(),
                names.preload_dynamic_import.clone(),
            ),
            ("__live".to_string(), names.live.clone()),
        ]);
        GeneratedRuntimeBindingRenameVisitor {
            allocator,
            identity,
            replacements,
        }
        .visit_program(program);
        (names, fresh_names)
    }
}

struct GeneratedRuntimeBindingRenameVisitor<'a, 'i> {
    allocator: &'a Allocator,
    identity: &'i ModuleIdentity,
    replacements: HashMap<String, String>,
}

impl<'a> VisitMut<'a> for GeneratedRuntimeBindingRenameVisitor<'a, '_> {
    fn visit_identifier_reference(&mut self, identifier: &mut IdentifierReference<'a>) {
        if !self.identity.is_synthesized_reference(identifier) {
            return;
        }
        let Some(replacement) = self.replacements.get(identifier.name.as_str()) else {
            return;
        };
        identifier.name = Ident::from_in(replacement, self.allocator);
    }
}
