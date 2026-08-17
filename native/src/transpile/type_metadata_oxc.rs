//! Oxc binding and statement-delivery half of `type_metadata.rs`.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_codegen::{Codegen, Gen};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use super::emit_runtime_oxc::binding_names_with_ids;
use super::fresh_oxc::FreshNameAllocator;
use super::identity_oxc::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::lowering_oxc::closure_input_codegen_options;
use super::nocollapse_oxc::NocollapseAssignments;
use super::suffixed_name;
use super::type_metadata::{
    annotation_target_label, apply_source_edits, compose_annotations, empty_metadata,
    insert_before_class_member, insert_before_object_member, is_class_declaration_text,
    merge_jsdoc_blocks, render_class_field_declaration, render_declarations, render_template,
    RuntimeTypeName, TypeMetadataDelivery,
};
use crate::closure_metadata::{
    ClosureAnnotation, ClosureAnnotationTarget, ClosureEnumDeclaration, ClosureFileMetadata,
    ClosureTypeSymbol, TypeMetadataDiagnostic,
};

#[derive(Clone, Debug)]
pub(crate) struct BoundTypeMetadata {
    binding_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    diagnostics: Vec<TypeMetadataDiagnostic>,
    enabled: bool,
    member_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    metadata: ClosureFileMetadata,
    runtime_symbol_bindings: HashMap<String, BindingKey>,
    symbols_by_id: HashMap<String, ClosureTypeSymbol>,
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

    pub(crate) fn prepare(
        self,
        fresh_names: &mut FreshNameAllocator,
        runtime_names: &BindingKeyMap<RuntimeTypeName>,
        hoist_ordinal: Option<usize>,
    ) -> PreparedTypeMetadata {
        PreparedTypeMetadata::new(self, fresh_names, runtime_names, hoist_ordinal)
    }
}

pub(crate) struct PreparedTypeMetadata {
    binding_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    declaration_lines: Vec<String>,
    delivery: TypeMetadataDelivery,
    enum_names: HashMap<String, String>,
    member_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    metadata: ClosureFileMetadata,
    symbol_resolutions: HashMap<String, RuntimeTypeName>,
    symbols_by_id: HashMap<String, ClosureTypeSymbol>,
}

impl PreparedTypeMetadata {
    fn new(
        bound: BoundTypeMetadata,
        fresh_names: &mut FreshNameAllocator,
        runtime_names: &BindingKeyMap<RuntimeTypeName>,
        hoist_ordinal: Option<usize>,
    ) -> Self {
        let mut symbol_resolutions = HashMap::new();
        for symbol in bound.symbols_by_id.values() {
            if symbol.kind == "builtin" {
                if let Some(name) = &symbol.builtin_name {
                    symbol_resolutions
                        .insert(symbol.id.clone(), RuntimeTypeName::Name(name.clone()));
                }
            }
        }

        for (symbol_id, binding) in &bound.runtime_symbol_bindings {
            symbol_resolutions.insert(
                symbol_id.clone(),
                runtime_names
                    .get(binding)
                    .cloned()
                    .unwrap_or(RuntimeTypeName::Unresolved("runtime-binding-not-found")),
            );
        }
        for symbol in bound.symbols_by_id.values() {
            if symbol_resolutions.contains_key(&symbol.id) {
                continue;
            }
            if symbol.kind == "runtime" {
                symbol_resolutions.insert(
                    symbol.id.clone(),
                    in_graph_type_name(symbol)
                        .map(RuntimeTypeName::Name)
                        .unwrap_or(RuntimeTypeName::Unresolved("runtime-binding-not-found")),
                );
            } else if symbol.kind == "declared" {
                if let Some(name) = in_graph_type_name(symbol) {
                    symbol_resolutions.insert(symbol.id.clone(), RuntimeTypeName::Name(name));
                }
            }
        }

        let mut enum_names = HashMap::new();
        for declaration in &bound.metadata.enums {
            let preferred = hoist_ordinal
                .map(|ordinal| suffixed_name(&declaration.binding_name, ordinal))
                .unwrap_or_else(|| declaration.binding_name.clone());
            let emitted_name = fresh_names.fresh(&preferred);
            enum_names.insert(declaration.symbol_id.clone(), emitted_name.clone());
            symbol_resolutions.insert(
                declaration.symbol_id.clone(),
                RuntimeTypeName::Name(emitted_name),
            );
        }

        let mut declaration_names = HashMap::new();
        if bound.enabled {
            for declaration in &bound.metadata.declarations {
                let authored_name = bound
                    .symbols_by_id
                    .get(&declaration.declared_symbol_id)
                    .map(|symbol| symbol.diagnostic_name.as_str())
                    .unwrap_or("ClosureType");
                let preferred = hoist_ordinal
                    .map(|ordinal| format!("{authored_name}$$type$${ordinal}"))
                    .unwrap_or_else(|| authored_name.to_string());
                declaration_names.insert(
                    declaration.declared_symbol_id.clone(),
                    fresh_names.fresh(&preferred),
                );
            }
            for (symbol_id, name) in &declaration_names {
                symbol_resolutions.insert(symbol_id.clone(), RuntimeTypeName::Name(name.clone()));
            }
        } else {
            for declaration in &bound.metadata.declarations {
                symbol_resolutions.insert(
                    declaration.declared_symbol_id.clone(),
                    RuntimeTypeName::Unresolved("type-declaration-not-delivered-to-job"),
                );
            }
        }

        let mut delivery = TypeMetadataDelivery {
            diagnostics: bound.diagnostics,
            ..Default::default()
        };
        let mut declaration_lines = Vec::new();
        if bound.enabled {
            let first_pass = render_declarations(
                &bound.metadata,
                &bound.metadata.declarations,
                &bound.symbols_by_id,
                &declaration_names,
                &symbol_resolutions,
                rename_declaration_template,
            );
            let failed_ids = first_pass
                .iter()
                .filter(|rendered| rendered.code.is_none())
                .map(|rendered| rendered.symbol_id.clone())
                .collect::<HashSet<_>>();
            for failed_id in &failed_ids {
                symbol_resolutions.insert(
                    failed_id.clone(),
                    RuntimeTypeName::Unresolved("type-declaration-not-delivered-to-job"),
                );
            }
            let rendered = if failed_ids.is_empty() {
                first_pass
            } else {
                render_declarations(
                    &bound.metadata,
                    &bound.metadata.declarations,
                    &bound.symbols_by_id,
                    &declaration_names,
                    &symbol_resolutions,
                    rename_declaration_template,
                )
            };
            for declaration in rendered {
                delivery.counts.add_assign(&declaration.rendered_counts);
                delivery.diagnostics.extend(declaration.diagnostics);
                if let Some(code) = declaration.code {
                    declaration_lines.push(code.trim().to_string());
                }
            }
        }

        Self {
            binding_annotations: bound.binding_annotations,
            declaration_lines,
            delivery,
            enum_names,
            member_annotations: bound.member_annotations,
            metadata: bound.metadata,
            symbol_resolutions,
            symbols_by_id: bound.symbols_by_id,
        }
    }

    pub(crate) fn take_declaration_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.declaration_lines)
    }

    pub(crate) fn enum_name(&self, declaration: &ClosureEnumDeclaration) -> String {
        self.enum_names
            .get(&declaration.symbol_id)
            .cloned()
            .unwrap_or_else(|| declaration.binding_name.clone())
    }

    pub(crate) fn enum_declarations(&self) -> &[ClosureEnumDeclaration] {
        &self.metadata.enums
    }

    pub(crate) fn count_enum(&mut self) {
        self.delivery.counts.enumDeclarationCount += 1;
    }

    pub(crate) fn render_statement_with_nocollapse(
        &mut self,
        identity: &ModuleIdentity,
        mut statement: Statement<'_>,
        tags: &[&str],
        nocollapse_assignments: Option<&NocollapseAssignments>,
    ) -> std::result::Result<String, String> {
        let binding_ids = declared_statement_ids(&statement, identity);
        if binding_ids.len() > 1 {
            let mut had_metadata = false;
            for binding in &binding_ids {
                had_metadata |= self.binding_annotations.remove(binding).is_some();
                had_metadata |= self.member_annotations.remove(binding).is_some();
            }
            if had_metadata {
                self.delivery
                    .diagnostics
                    .push(TypeMetadataDiagnostic::delivery(
                        &self.metadata,
                        "annotation-target-not-found",
                        None,
                        Some("multi-declarator statement".to_string()),
                    ));
            }
            return Ok(format!(
                "{}{}",
                compose_annotations(tags, None),
                print_statement(&statement)
            ));
        }

        let annotation_owner = binding_ids.first().copied();
        let binding_annotations = annotation_owner
            .as_ref()
            .and_then(|binding| self.binding_annotations.remove(binding))
            .unwrap_or_default();
        let member_annotations = annotation_owner
            .as_ref()
            .and_then(|binding| self.member_annotations.remove(binding))
            .unwrap_or_default();

        let mut binding_blocks = Vec::new();
        for annotation in binding_annotations {
            let target = annotation_target_label(&annotation.target);
            let rendered = render_template(
                &self.metadata,
                &annotation.template,
                &annotation.references,
                &self.symbols_by_id,
                &self.symbol_resolutions,
                Some(target),
            );
            self.delivery.counts.unresolvedTypeReferenceCount += rendered.unresolved_count;
            self.delivery.diagnostics.extend(rendered.diagnostics);
            if annotation.type_bearing {
                self.delivery.counts.annotationCount += 1;
            }
            binding_blocks.push(rendered.text);
        }

        let rendered_members = member_annotations
            .into_iter()
            .map(|annotation| {
                let target = annotation_target_label(&annotation.target);
                let rendered = render_template(
                    &self.metadata,
                    &annotation.template,
                    &annotation.references,
                    &self.symbols_by_id,
                    &self.symbol_resolutions,
                    Some(target.clone()),
                );
                self.delivery.counts.unresolvedTypeReferenceCount += rendered.unresolved_count;
                self.delivery.diagnostics.extend(rendered.diagnostics);
                RenderedMemberAnnotation {
                    annotation,
                    target,
                    text: rendered.text,
                }
            })
            .collect::<Vec<_>>();

        remove_bound_valueless_class_fields(&mut statement, &rendered_members);
        let owner_name = annotation_owner.map(|binding| identity.symbol(binding).to_string());
        let mut code = print_statement(&statement);
        if let Some(nocollapse_assignments) = nocollapse_assignments {
            code = nocollapse_assignments.annotate_rendered_statement(&statement, code)?;
        }
        let mut after = Vec::new();
        for rendered in rendered_members {
            let ClosureAnnotationTarget::Member {
                member_kind,
                member_name,
                is_static,
                ..
            } = &rendered.annotation.target
            else {
                continue;
            };
            let delivered = if member_kind == "field" && is_class_declaration_text(&code) {
                if let Some(owner_name) = owner_name.as_deref() {
                    after.push(render_class_field_declaration(
                        owner_name,
                        member_name,
                        *is_static,
                        &rendered.text,
                    ));
                    true
                } else {
                    false
                }
            } else if is_class_declaration_text(&code) {
                insert_before_class_member(
                    &mut code,
                    member_kind,
                    member_name,
                    *is_static,
                    &rendered.text,
                )
            } else {
                insert_before_object_member(&mut code, member_kind, member_name, &rendered.text)
            };
            if delivered {
                if rendered.annotation.type_bearing {
                    self.delivery.counts.memberAnnotationCount += 1;
                }
            } else {
                self.delivery
                    .diagnostics
                    .push(TypeMetadataDiagnostic::delivery(
                        &self.metadata,
                        "member-target-not-found",
                        None,
                        Some(rendered.target),
                    ));
            }
        }

        let typed = merge_jsdoc_blocks(&binding_blocks);
        let prefix = compose_annotations(tags, typed.as_deref());
        if after.is_empty() {
            Ok(format!("{prefix}{code}"))
        } else {
            Ok(format!("{prefix}{code}\n{}", after.join("\n")))
        }
    }

    pub(crate) fn finish(mut self) -> TypeMetadataDelivery {
        self.delivery
            .diagnostics
            .sort_by(|left, right| left.stable_key().cmp(&right.stable_key()));
        self.delivery
            .diagnostics
            .dedup_by(|left, right| left.stable_key() == right.stable_key());
        self.delivery
    }
}

struct RenderedMemberAnnotation {
    annotation: ClosureAnnotation,
    target: String,
    text: String,
}

fn in_graph_type_name(symbol: &crate::closure_metadata::ClosureTypeSymbol) -> Option<String> {
    if symbol.kind == "declared" {
        if let Some(name) = symbol.local_name.as_deref() {
            if super::is_valid_js_identifier(name) {
                return Some(name.to_string());
            }
        }
        return super::is_valid_js_identifier(&symbol.diagnostic_name)
            .then(|| symbol.diagnostic_name.clone());
    }
    let path = symbol.declaration_file_path.as_deref()?;
    if is_declaration_file_path(path) {
        return None;
    }
    if let Some(name) = symbol.local_name.as_deref() {
        if super::is_valid_js_identifier(name) {
            return Some(name.to_string());
        }
    }
    super::is_valid_js_identifier(&symbol.diagnostic_name).then(|| symbol.diagnostic_name.clone())
}

fn is_declaration_file_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".d.ts")
        || lower.ends_with(".d.mts")
        || lower.ends_with(".d.cts")
        || lower.ends_with(".d.tsx")
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

fn collect_top_level_bindings(
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

fn unique_binding(bindings: &HashMap<String, Vec<BindingKey>>, name: &str) -> Option<BindingKey> {
    let [binding] = bindings.get(name)?.as_slice() else {
        return None;
    };
    Some(*binding)
}

fn rename_declaration_template(
    template: &str,
    authored_name: &str,
    emitted_name: &str,
) -> std::result::Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, template, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    let bindings = collect_top_level_bindings(&parsed.program, &identity);
    let target = unique_binding(&bindings, authored_name)
        .ok_or_else(|| format!("Missing declaration binding {authored_name}"))?;
    let mut collector = IdentifierEditCollector {
        edits: Vec::new(),
        emitted_name,
        identity: &identity,
        target,
    };
    collector.visit_program(&parsed.program);
    collector
        .edits
        .sort_by_key(|(start, end, _)| (*start, *end));
    collector
        .edits
        .dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    apply_source_edits(template, collector.edits)
}

struct IdentifierEditCollector<'a> {
    edits: Vec<(usize, usize, String)>,
    emitted_name: &'a str,
    identity: &'a ModuleIdentity,
    target: BindingKey,
}

impl IdentifierEditCollector<'_> {
    fn push(&mut self, span: oxc_span::Span) {
        self.edits.push((
            span.start as usize,
            span.end as usize,
            self.emitted_name.to_string(),
        ));
    }
}

impl<'a> Visit<'a> for IdentifierEditCollector<'_> {
    fn visit_binding_identifier(&mut self, binding: &BindingIdentifier<'a>) {
        if self.identity.key_of_binding(binding) == self.target {
            self.push(binding.span);
        }
    }

    fn visit_identifier_reference(&mut self, reference: &IdentifierReference<'a>) {
        if self.identity.key_of_reference(reference) == Some(self.target) {
            self.push(reference.span);
        }
        walk::walk_identifier_reference(self, reference);
    }
}

fn remove_bound_valueless_class_fields(
    statement: &mut Statement<'_>,
    members: &[RenderedMemberAnnotation],
) {
    let Statement::ClassDeclaration(class) = statement else {
        return;
    };
    let fields = members
        .iter()
        .filter_map(|rendered| match &rendered.annotation.target {
            ClosureAnnotationTarget::Member {
                member_kind,
                member_name,
                is_static,
                ..
            } if member_kind == "field" => Some((member_name.as_str(), *is_static)),
            _ => None,
        })
        .collect::<HashSet<_>>();
    if fields.is_empty() {
        return;
    }
    class.body.body.retain(|element| {
        let ClassElement::PropertyDefinition(property) = element else {
            return true;
        };
        if property.value.is_some() {
            return true;
        }
        let Some(name) = property_key_to_string(&property.key) else {
            return true;
        };
        !fields.contains(&(name.as_str(), property.r#static))
    });
}

fn property_key_to_string(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn print_statement(statement: &Statement<'_>) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    statement.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}
