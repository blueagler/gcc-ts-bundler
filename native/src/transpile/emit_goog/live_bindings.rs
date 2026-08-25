//! Live-binding rewrite for goog.module import and export accessors.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, SPAN};
use oxc_str::Ident;

use super::super::emit_runtime::{binding_names_with_ids, collect_reassigned_binding_ids};
use super::super::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::super::{is_valid_js_identifier, live_export_accessor_name, resolve_relative_module};
use super::imports::module_export_name;

pub(crate) fn live_export_bindings(file_path: &Path) -> BTreeMap<String, String> {
    let Ok(source) = std::fs::read_to_string(file_path) else {
        return BTreeMap::new();
    };
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .unwrap_or_default()
        .with_module(true);
    let parsed = Parser::new(&allocator, &source, source_type).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return BTreeMap::new();
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return BTreeMap::new();
    }
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    live_export_bindings_of_program(&parsed.program, &identity)
}

pub(super) fn live_export_bindings_of_program(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> BTreeMap<String, String> {
    let mut declared = BindingKeyMap::<String>::new();
    let mut exported = BindingKeyMap::<(String, String)>::new();
    for statement in &program.body {
        let (declaration, is_exported) = match statement {
            Statement::VariableDeclaration(declaration) => (declaration.as_ref(), false),
            Statement::ExportNamedDeclaration(export) => {
                let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration
                else {
                    continue;
                };
                (declaration.as_ref(), true)
            }
            _ => continue,
        };
        if declaration.kind == VariableDeclarationKind::Const || declaration.declare {
            continue;
        }
        for declarator in &declaration.declarations {
            for (binding, name) in binding_names_with_ids(&declarator.id, identity) {
                if is_exported {
                    exported.insert(binding, (name.clone(), name));
                } else {
                    declared.insert(binding, name);
                }
            }
        }
    }

    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export) = statement else {
            continue;
        };
        if export.source.is_some() {
            continue;
        }
        for specifier in &export.specifiers {
            let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                continue;
            };
            let Some(binding) = identity.key_of_reference(local) else {
                continue;
            };
            let Some(local_name) = declared.get(&binding) else {
                continue;
            };
            exported.insert(
                binding,
                (module_export_name(&specifier.exported), local_name.clone()),
            );
        }
    }
    if exported.is_empty() {
        return BTreeMap::new();
    }

    let reassigned =
        collect_reassigned_binding_ids(program, identity, exported.keys().copied().collect());
    exported
        .into_iter()
        .filter(|(binding, (export_name, _))| {
            reassigned.contains(binding) && is_valid_js_identifier(export_name)
        })
        .map(|(_, value)| value)
        .collect()
}

pub(super) fn collect_live_imported_binding_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    file_path: &Path,
) -> BindingKeySet {
    let mut ids = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let specifier_text = import.source.value.as_str();
        if !specifier_text.starts_with('.') {
            continue;
        }
        let Some(target_path) = resolve_relative_module(file_path, specifier_text) else {
            continue;
        };
        let live = live_export_bindings(&target_path);
        if live.is_empty() {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };
            if named.import_kind == ImportOrExportKind::Type {
                continue;
            }
            let imported_name = module_export_name(&named.imported);
            if live.contains_key(&imported_name) {
                ids.insert(identity.key_of_binding(&named.local));
            }
        }
    }
    ids
}

pub(super) fn render_live_export_accessors(bindings: &BTreeMap<String, String>) -> Vec<String> {
    bindings
        .iter()
        .map(|(export_name, local_name)| {
            format!(
                "exports.{} = function() {{ return {local_name}; }};",
                live_export_accessor_name(export_name)
            )
        })
        .collect()
}

pub(super) struct LiveImportCallRewriter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    bindings: BindingKeySet,
}

impl<'a, 'i> LiveImportCallRewriter<'a, 'i> {
    pub(super) fn new(
        allocator: &'a Allocator,
        identity: &'i ModuleIdentity,
        bindings: BindingKeySet,
    ) -> Self {
        Self {
            allocator,
            builder: AstBuilder::new(allocator),
            identity,
            bindings,
        }
    }

    fn is_live(&self, identifier: &IdentifierReference<'_>) -> bool {
        self.identity
            .key_of_reference(identifier)
            .is_some_and(|binding| self.bindings.contains(&binding))
    }

    fn call(&self, name: &str) -> Expression<'a> {
        let name: Ident<'a> = Ident::from_in(name, self.allocator);
        Expression::new_call_expression(
            SPAN,
            Expression::new_identifier(SPAN, name, &self.builder),
            None::<oxc_allocator::Box<'a, TSTypeParameterInstantiation<'a>>>,
            ArenaVec::new_in(&self.allocator),
            false,
            &self.builder,
        )
    }
}

impl<'a> VisitMut<'a> for LiveImportCallRewriter<'a, '_> {
    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand
            && matches!(&property.value, Expression::Identifier(identifier) if self.is_live(identifier))
        {
            property.shorthand = false;
        }
        walk_mut::walk_object_property(self, property);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::Identifier(identifier) = expression else {
            return;
        };
        if self.is_live(identifier) {
            *expression = self.call(identifier.name.as_str());
        }
    }
}
