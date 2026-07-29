use std::collections::HashSet;

use swc_core::ecma::ast::{Id, Ident, Module, Program};
use swc_core::ecma::visit::{Visit, VisitWith};

/// Allocates compiler bindings against every identifier visible in the
/// lexical region where generated references may be inserted.
#[derive(Clone, Debug, Default)]
pub(crate) struct FreshNameAllocator {
    used: HashSet<String>,
}

impl FreshNameAllocator {
    pub(crate) fn from_program(program: &Program) -> Self {
        let mut collector = IdentifierNameCollector::default();
        program.visit_with(&mut collector);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn from_module(module: &Module) -> Self {
        let mut collector = IdentifierNameCollector::default();
        module.visit_with(&mut collector);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn from_module_excluding(module: &Module, excluded_ids: &HashSet<Id>) -> Self {
        let mut collector = IdentifierNameCollector {
            excluded_ids: Some(excluded_ids),
            ..Default::default()
        };
        module.visit_with(&mut collector);
        Self {
            used: collector.names,
        }
    }

    pub(crate) fn fresh(&mut self, preferred: &str) -> String {
        if self.used.insert(preferred.to_string()) {
            return preferred.to_string();
        }
        let mut suffix = 1usize;
        loop {
            let candidate = format!("{preferred}_{suffix}");
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
            suffix += 1;
        }
    }
}

pub(crate) fn collect_lexical_binding_names(module: &Module) -> HashSet<String> {
    let mut collector = LexicalBindingNameCollector::default();
    module.visit_with(&mut collector);
    collector.names
}

#[derive(Default)]
struct IdentifierNameCollector<'a> {
    excluded_ids: Option<&'a HashSet<Id>>,
    names: HashSet<String>,
}

impl Visit for IdentifierNameCollector<'_> {
    fn visit_ident(&mut self, ident: &Ident) {
        if self
            .excluded_ids
            .is_some_and(|excluded| excluded.contains(&ident.to_id()))
        {
            return;
        }
        self.names.insert(ident.sym.to_string());
    }
}

#[derive(Default)]
struct LexicalBindingNameCollector {
    names: HashSet<String>,
}

impl Visit for LexicalBindingNameCollector {
    fn visit_binding_ident(&mut self, binding: &swc_core::ecma::ast::BindingIdent) {
        self.names.insert(binding.id.sym.to_string());
        binding.visit_children_with(self);
    }

    fn visit_fn_decl(&mut self, declaration: &swc_core::ecma::ast::FnDecl) {
        self.names.insert(declaration.ident.sym.to_string());
        declaration.function.visit_with(self);
    }

    fn visit_fn_expr(&mut self, expression: &swc_core::ecma::ast::FnExpr) {
        if let Some(ident) = &expression.ident {
            self.names.insert(ident.sym.to_string());
        }
        expression.function.visit_with(self);
    }

    fn visit_class_decl(&mut self, declaration: &swc_core::ecma::ast::ClassDecl) {
        self.names.insert(declaration.ident.sym.to_string());
        declaration.class.visit_with(self);
    }

    fn visit_class_expr(&mut self, expression: &swc_core::ecma::ast::ClassExpr) {
        if let Some(ident) = &expression.ident {
            self.names.insert(ident.sym.to_string());
        }
        expression.class.visit_with(self);
    }

    fn visit_import_default_specifier(
        &mut self,
        specifier: &swc_core::ecma::ast::ImportDefaultSpecifier,
    ) {
        self.names.insert(specifier.local.sym.to_string());
    }

    fn visit_import_named_specifier(
        &mut self,
        specifier: &swc_core::ecma::ast::ImportNamedSpecifier,
    ) {
        self.names.insert(specifier.local.sym.to_string());
    }

    fn visit_import_star_as_specifier(
        &mut self,
        specifier: &swc_core::ecma::ast::ImportStarAsSpecifier,
    ) {
        self.names.insert(specifier.local.sym.to_string());
    }
}
