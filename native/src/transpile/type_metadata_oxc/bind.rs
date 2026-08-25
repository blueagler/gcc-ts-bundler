//! Oxc binding of type metadata onto program identities.

use std::collections::HashMap;

use oxc_ast::ast::*;

use super::super::emit_runtime::binding_names_with_ids;
use super::super::identity::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::super::type_metadata::{empty_metadata, RuntimeTypeName};
use crate::closure_metadata::{
    ClosureAnnotation, ClosureAnnotationTarget, ClosureFileMetadata, ClosureTypeSymbol,
    TypeMetadataDiagnostic,
};

#[derive(Clone, Debug)]
pub(crate) struct BoundTypeMetadata {
    pub(super) binding_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    pub(super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(super) enabled: bool,
    pub(super) member_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    pub(super) metadata: ClosureFileMetadata,
    pub(super) runtime_symbol_bindings: HashMap<String, BindingKey>,
    pub(super) symbols_by_id: HashMap<String, ClosureTypeSymbol>,
}

impl BoundTypeMetadata {
    pub(crate) fn bind(
        program: &Program<'_>,
        identity: &ModuleIdentity,
        metadata: Option<&ClosureFileMetadata>,
        enabled: bool,
    ) -> Self {
        let metadata = metadata.cloned().unwrap_or_else(empty_metadata);
        let symbols_by_id = metadata
            .symbols
            .iter()
            .cloned()
            .map(|symbol| (symbol.id.clone(), symbol))
            .collect::<HashMap<_, _>>();
        let top_level_bindings = collect_top_level_bindings(program, identity);
        let mut diagnostics = metadata.diagnostics.clone();
        let mut binding_annotations = BindingKeyMap::<Vec<ClosureAnnotation>>::new();
        let mut member_annotations = BindingKeyMap::<Vec<ClosureAnnotation>>::new();
        let mut runtime_symbol_bindings = HashMap::new();

        for symbol in &metadata.symbols {
            if symbol.kind != "runtime" {
                continue;
            }
            let Some(local_name) = symbol.local_name.as_deref() else {
                continue;
            };
            if let Some(binding) = unique_binding(&top_level_bindings, local_name) {
                runtime_symbol_bindings.insert(symbol.id.clone(), binding);
            }
        }

        if enabled {
            for annotation in &metadata.annotations {
                match &annotation.target {
                    ClosureAnnotationTarget::Binding { binding_name } => {
                        if let Some(binding) = unique_binding(&top_level_bindings, binding_name) {
                            binding_annotations
                                .entry(binding)
                                .or_default()
                                .push(annotation.clone());
                        } else {
                            diagnostics.push(TypeMetadataDiagnostic::delivery(
                                &metadata,
                                "annotation-target-not-found",
                                None,
                                Some(format!("binding {binding_name}")),
                            ));
                        }
                    }
                    ClosureAnnotationTarget::Member {
                        member_kind,
                        member_name,
                        owner_binding_name,
                        is_static,
                    } => {
                        if let Some(binding) =
                            unique_binding(&top_level_bindings, owner_binding_name)
                        {
                            member_annotations
                                .entry(binding)
                                .or_default()
                                .push(annotation.clone());
                        } else {
                            diagnostics.push(TypeMetadataDiagnostic::delivery(
                                &metadata,
                                "member-target-not-found",
                                None,
                                Some(format!(
                                    "{} {}.{}{}",
                                    member_kind,
                                    owner_binding_name,
                                    member_name,
                                    if *is_static { " static" } else { "" }
                                )),
                            ));
                        }
                    }
                }
            }
        }

        Self {
            binding_annotations,
            diagnostics,
            enabled,
            member_annotations,
            metadata,
            runtime_symbol_bindings,
            symbols_by_id,
        }
    }

    pub(crate) fn runtime_binding_ids(&self) -> impl Iterator<Item = &BindingKey> {
        self.runtime_symbol_bindings.values()
    }
}

pub(crate) fn runtime_type_names_from_program(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    bound: &BoundTypeMetadata,
) -> BindingKeyMap<RuntimeTypeName> {
    let current_names = collect_top_level_bindings(program, identity)
        .into_iter()
        .flat_map(|(name, bindings)| {
            bindings
                .into_iter()
                .map(move |binding| (binding, RuntimeTypeName::Name(name.clone())))
        })
        .collect::<BindingKeyMap<_>>();
    bound
        .runtime_binding_ids()
        .filter_map(|binding| {
            current_names
                .get(binding)
                .cloned()
                .map(|name| (*binding, name))
        })
        .collect()
}

pub(crate) fn declared_statement_ids(
    statement: &Statement<'_>,
    identity: &ModuleIdentity,
) -> Vec<BindingKey> {
    match statement {
        Statement::FunctionDeclaration(function) => function
            .id
            .iter()
            .map(|binding| identity.key_of_binding(binding))
            .collect(),
        Statement::ClassDeclaration(class) => class
            .id
            .iter()
            .map(|binding| identity.key_of_binding(binding))
            .collect(),
        Statement::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
            .map(|(binding, _)| binding)
            .collect(),
        _ => Vec::new(),
    }
}

pub(super) fn collect_top_level_bindings(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> HashMap<String, Vec<BindingKey>> {
    let mut bindings = HashMap::<String, Vec<BindingKey>>::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = specifier.local();
                    push_binding(&mut bindings, local, identity);
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    add_declaration_bindings(&mut bindings, declaration, identity);
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        push_binding(&mut bindings, binding, identity);
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        push_binding(&mut bindings, binding, identity);
                    }
                }
                _ => {}
            },
            _ => {
                if let Some(declaration) = statement.as_declaration() {
                    add_declaration_bindings(&mut bindings, declaration, identity);
                }
            }
        }
    }
    bindings
}

fn add_declaration_bindings(
    bindings: &mut HashMap<String, Vec<BindingKey>>,
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
) {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for (binding, name) in declaration
                .declarations
                .iter()
                .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
            {
                bindings.entry(name).or_default().push(binding);
            }
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(binding) = &function.id {
                push_binding(bindings, binding, identity);
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(binding) = &class.id {
                push_binding(bindings, binding, identity);
            }
        }
        _ => {}
    }
}

fn push_binding(
    bindings: &mut HashMap<String, Vec<BindingKey>>,
    binding: &BindingIdentifier<'_>,
    identity: &ModuleIdentity,
) {
    bindings
        .entry(binding.name.to_string())
        .or_default()
        .push(identity.key_of_binding(binding));
}

pub(super) fn unique_binding(
    bindings: &HashMap<String, Vec<BindingKey>>,
    name: &str,
) -> Option<BindingKey> {
    let [binding] = bindings.get(name)?.as_slice() else {
        return None;
    };
    Some(*binding)
}
