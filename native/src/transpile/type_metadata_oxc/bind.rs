//! Oxc binding of type metadata onto program identities.

use std::borrow::Cow;
use std::collections::HashMap;

use oxc_ast::ast::{
    BindingIdentifier, Declaration, ExportDefaultDeclarationKind, Program, Statement,
};

use super::super::emit_runtime::binding_names_with_ids;
use super::super::identity::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::super::type_metadata::{empty_metadata, RuntimeTypeName};
use crate::closure_metadata::{
    ClosureAnnotation, ClosureAnnotationTarget, ClosureFileMetadata, ClosureTypeSymbol,
    TypeMetadataDiagnostic,
};

#[derive(Clone, Debug)]
pub(crate) struct BoundTypeMetadata<'m> {
    pub(super) binding_annotations: BindingKeyMap<Vec<&'m ClosureAnnotation>>,
    pub(super) declared_value_bindings: HashMap<String, BindingKey>,
    pub(super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(super) enabled: bool,
    pub(super) member_annotations: BindingKeyMap<Vec<&'m ClosureAnnotation>>,
    pub(super) metadata: Cow<'m, ClosureFileMetadata>,
    pub(super) runtime_symbol_bindings: HashMap<String, BindingKey>,
    pub(super) symbols_by_id: HashMap<&'m str, &'m ClosureTypeSymbol>,
}

impl<'m> BoundTypeMetadata<'m> {
    pub(crate) fn bind(
        program: &Program<'_>,
        metadata: Option<&'m ClosureFileMetadata>,
        enabled: bool,
    ) -> Result<Self, String> {
        let annotations = metadata.map_or(&[][..], |metadata| metadata.annotations.as_slice());
        let symbols_by_id = metadata
            .into_iter()
            .flat_map(|metadata| &metadata.symbols)
            .map(|symbol| (symbol.id.as_str(), symbol))
            .collect::<HashMap<_, _>>();
        let metadata = metadata.map_or_else(|| Cow::Owned(empty_metadata()), Cow::Borrowed);
        let top_level_bindings = collect_top_level_bindings(program)?;
        let mut diagnostics = metadata.diagnostics.clone();
        let mut binding_annotations = BindingKeyMap::<Vec<&ClosureAnnotation>>::new();
        let mut member_annotations = BindingKeyMap::<Vec<&ClosureAnnotation>>::new();
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
        // A `.d.ts`-declared type whose name is also an import binding of this
        // module *is* that binding: TypeScript resolved the type and the value
        // meaning through the same specifier. Annotating with a synthesized
        // record instead mints a second, nominally incompatible type for a
        // class that the job already compiles.
        let import_bindings = collect_import_bindings(program)?;
        let mut declared_value_bindings = HashMap::new();
        for symbol in &metadata.symbols {
            if symbol.kind != "declared" {
                continue;
            }
            let name = symbol
                .local_name
                .as_deref()
                .unwrap_or(symbol.diagnostic_name.as_str());
            if let Some(binding) = unique_binding(&import_bindings, name) {
                declared_value_bindings.insert(symbol.id.clone(), binding);
            }
        }

        if enabled {
            for annotation in annotations {
                match &annotation.target {
                    ClosureAnnotationTarget::Binding { binding_name } => {
                        if let Some(binding) = unique_binding(&top_level_bindings, binding_name) {
                            binding_annotations
                                .entry(binding)
                                .or_default()
                                .push(annotation);
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
                                .push(annotation);
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

        Ok(Self {
            binding_annotations,
            declared_value_bindings,
            diagnostics,
            enabled,
            member_annotations,
            metadata,
            runtime_symbol_bindings,
            symbols_by_id,
        })
    }

    pub(crate) fn runtime_binding_ids(&self) -> impl Iterator<Item = &BindingKey> {
        self.runtime_symbol_bindings
            .values()
            .chain(self.declared_value_bindings.values())
    }
}

pub(crate) fn runtime_type_names_from_program(
    program: &Program<'_>,
    bound: &BoundTypeMetadata<'_>,
) -> Result<BindingKeyMap<RuntimeTypeName>, String> {
    let current_names = collect_top_level_bindings(program)?
        .into_iter()
        .flat_map(|(name, bindings)| {
            bindings
                .into_iter()
                .map(move |binding| (binding, RuntimeTypeName::Name(name.clone())))
        })
        .collect::<BindingKeyMap<_>>();
    Ok(bound
        .runtime_binding_ids()
        .filter_map(|binding| {
            current_names
                .get(binding)
                .cloned()
                .map(|name| (*binding, name))
        })
        .collect())
}

pub(crate) fn declared_statement_ids(statement: &Statement<'_>) -> Result<Vec<BindingKey>, String> {
    match statement {
        Statement::FunctionDeclaration(function) => function
            .id
            .iter()
            .map(ModuleIdentity::key_of_binding)
            .collect(),
        Statement::ClassDeclaration(class) => class
            .id
            .iter()
            .map(ModuleIdentity::key_of_binding)
            .collect(),
        Statement::VariableDeclaration(declaration) => {
            let mut bindings = Vec::new();
            for declarator in &declaration.declarations {
                bindings.extend(
                    binding_names_with_ids(&declarator.id)?
                        .into_iter()
                        .map(|(binding, _)| binding),
                );
            }
            Ok(bindings)
        }
        _ => Ok(Vec::new()),
    }
}

pub(super) fn collect_top_level_bindings(
    program: &Program<'_>,
) -> Result<HashMap<String, Vec<BindingKey>>, String> {
    let mut bindings = HashMap::<String, Vec<BindingKey>>::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                for specifier in import.specifiers.iter().flatten() {
                    let local = specifier.local();
                    push_binding(&mut bindings, local)?;
                }
            }
            Statement::ExportDeclaration(export) => {
                add_declaration_bindings(&mut bindings, &export.declaration)?;
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        push_binding(&mut bindings, binding)?;
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        push_binding(&mut bindings, binding)?;
                    }
                }
                _ => {}
            },
            _ => {
                if let Some(declaration) = statement.as_declaration() {
                    add_declaration_bindings(&mut bindings, declaration)?;
                }
            }
        }
    }
    Ok(bindings)
}

fn collect_import_bindings(
    program: &Program<'_>,
) -> Result<HashMap<String, Vec<BindingKey>>, String> {
    let mut bindings = HashMap::<String, Vec<BindingKey>>::new();
    for statement in &program.body {
        if let Statement::ImportDeclaration(import) = statement {
            for specifier in import.specifiers.iter().flatten() {
                push_binding(&mut bindings, specifier.local())?;
            }
        }
    }
    Ok(bindings)
}

fn add_declaration_bindings(
    bindings: &mut HashMap<String, Vec<BindingKey>>,
    declaration: &Declaration<'_>,
) -> Result<(), String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            for declarator in &declaration.declarations {
                for (binding, name) in binding_names_with_ids(&declarator.id)? {
                    bindings.entry(name).or_default().push(binding);
                }
            }
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(binding) = &function.id {
                push_binding(bindings, binding)?;
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(binding) = &class.id {
                push_binding(bindings, binding)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn push_binding(
    bindings: &mut HashMap<String, Vec<BindingKey>>,
    binding: &BindingIdentifier<'_>,
) -> Result<(), String> {
    let key = ModuleIdentity::key_of_binding(binding)?;
    bindings
        .entry(binding.name.to_string())
        .or_default()
        .push(key);
    Ok(())
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
