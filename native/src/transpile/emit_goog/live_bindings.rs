//! Live-binding facts and rewrites for goog.module imports and exports.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, Vec as ArenaVec};
use oxc_ast::ast::{
    Declaration, Expression, IdentifierReference, ImportDeclarationSpecifier, ImportOrExportKind,
    ModuleExportName, ObjectProperty, Program, Statement, TSTypeParameterInstantiation,
    VariableDeclarationKind,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_semantic::SemanticBuilder;
use oxc_span::SPAN;
use oxc_str::Ident;

use super::super::emit_runtime::{binding_names_with_ids, collect_reassigned_binding_ids};
use super::super::identity::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::super::{
    is_valid_js_identifier, live_export_accessor_name, resolved_import_key, TranspileContext,
};
use super::imports::module_export_name;

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveModuleFacts {
    pub(crate) locals: BTreeMap<String, String>,
    pub(crate) names: BTreeSet<String>,
    pub(crate) explicit: BTreeSet<String>,
    pub(crate) namespace_export: String,
    forwards: Vec<(String, String, String)>,
    stars: Vec<String>,
}

pub(crate) fn collect_live_module_facts(
    program: &Program<'_>,
    file_path: &Path,
    context: &TranspileContext,
) -> Result<LiveModuleFacts, String> {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(false)
        .with_enum_eval(true)
        .build(program);
    if !semantic.diagnostics.is_empty() {
        return Err(format!(
            "{}: {:?}",
            file_path.display(),
            semantic.diagnostics
        ));
    }
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    let locals = live_export_bindings_of_program(program, &identity)?;
    let topology = super::super::context::collect_export_topology(program, file_path, context)?;
    Ok(LiveModuleFacts {
        names: locals.keys().cloned().collect(),
        explicit: topology.explicit,
        locals,
        forwards: topology
            .forwards
            .into_iter()
            .map(|(exported, (target, imported))| (exported, target, imported))
            .collect(),
        stars: topology.stars,
        ..Default::default()
    })
}

pub(crate) fn resolve_live_module_facts(facts: &mut HashMap<String, LiveModuleFacts>) {
    loop {
        let mut additions = HashMap::<String, BTreeSet<String>>::new();
        for (module_id, module) in facts.iter() {
            for (exported, target, imported) in &module.forwards {
                if facts
                    .get(target)
                    .is_some_and(|target| target.names.contains(imported))
                    && !module.names.contains(exported)
                {
                    additions
                        .entry(module_id.clone())
                        .or_default()
                        .insert(exported.clone());
                }
            }
            for target in &module.stars {
                if let Some(target) = facts.get(target) {
                    for name in &target.names {
                        if name != "default"
                            && !module.explicit.contains(name)
                            && !module.names.contains(name)
                        {
                            additions
                                .entry(module_id.clone())
                                .or_default()
                                .insert(name.clone());
                        }
                    }
                }
            }
        }
        if additions.is_empty() {
            break;
        }
        for (module_id, module) in facts.iter_mut() {
            if let Some(names) = additions.remove(module_id) {
                module.names.extend(names);
            }
        }
    }
}

pub(super) fn live_export_bindings_of_program(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> Result<BTreeMap<String, String>, String> {
    let mut declared = BindingKeyMap::<String>::new();
    let mut exported = BindingKeyMap::<Vec<(String, String)>>::new();
    for statement in &program.body {
        let (declaration, is_exported) = match statement {
            Statement::VariableDeclaration(declaration) => (declaration.as_ref(), false),
            Statement::ExportDeclaration(export) => {
                let Declaration::VariableDeclaration(declaration) = &export.declaration else {
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
            for (binding, name) in binding_names_with_ids(&declarator.id)? {
                declared.insert(binding, name.clone());
                if is_exported {
                    exported
                        .entry(binding)
                        .or_default()
                        .push((name.clone(), name));
                }
            }
        }
    }
    for statement in &program.body {
        let Statement::ExportNamedDeclaration(export) = statement else {
            continue;
        };
        if export.export_kind == ImportOrExportKind::Type {
            continue;
        }
        for specifier in &export.specifiers {
            if specifier.export_kind == ImportOrExportKind::Type {
                continue;
            }
            let ModuleExportName::IdentifierReference(local) = &specifier.local else {
                continue;
            };
            let Some(binding) = identity.key_of_reference(local) else {
                continue;
            };
            let Some(local_name) = declared.get(&binding) else {
                continue;
            };
            exported
                .entry(binding)
                .or_default()
                .push((module_export_name(&specifier.exported), local_name.clone()));
        }
    }
    let reassigned =
        collect_reassigned_binding_ids(program, identity, exported.keys().copied().collect());
    Ok(exported
        .into_iter()
        .filter(|(binding, _)| reassigned.contains(binding))
        .flat_map(|(_, aliases)| aliases)
        .filter(|(name, _)| is_valid_js_identifier(name))
        .collect())
}

pub(super) fn collect_live_imported_binding_ids(
    program: &Program<'_>,
    file_path: &Path,
    context: &TranspileContext,
) -> Result<BindingKeySet, String> {
    let mut ids = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let Some(module_id) = context.resolved_module_ids.get(&resolved_import_key(
            file_path,
            import.source.value.as_str(),
        )) else {
            continue;
        };
        let Some(live) = context.goog_live_modules.get(module_id) else {
            if context.preserved_modules.contains_key(module_id) {
                continue;
            }
            return Err(format!(
                "Missing live export facts for {module_id} imported from {}",
                file_path.display()
            ));
        };
        for specifier in import.specifiers.iter().flatten() {
            let (local, imported) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if named.import_kind != ImportOrExportKind::Type =>
                {
                    (&named.local, module_export_name(&named.imported))
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    (&default.local, "default".to_string())
                }
                _ => continue,
            };
            if live.names.contains(&imported) {
                ids.insert(ModuleIdentity::key_of_binding(local)?);
            }
        }
    }
    Ok(ids)
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
