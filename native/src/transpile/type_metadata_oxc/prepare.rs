//! Prepare bound type metadata for declaration and enum delivery.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use super::super::emit_helpers::SharedHelperDeclaration;
use super::super::fresh::FreshNameAllocator;
use super::super::identity::{BindingKey, BindingKeyMap, ModuleIdentity};
use super::super::is_valid_js_identifier;
use super::super::suffixed_name;
use super::super::type_metadata::{
    apply_source_edits, render_declarations, RuntimeTypeName, TypeMetadataDelivery,
};
use super::bind::{collect_top_level_bindings, unique_binding, BoundTypeMetadata};
use crate::closure_metadata::{
    ClosureAnnotation, ClosureEnumDeclaration, ClosureFileMetadata, ClosureTypeSymbol,
};

pub(crate) struct PreparedTypeMetadata {
    pub(super) binding_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    declaration_lines: Vec<String>,
    pub(super) delivery: TypeMetadataDelivery,
    enum_names: HashMap<String, String>,
    pub(super) member_annotations: BindingKeyMap<Vec<ClosureAnnotation>>,
    pub(super) metadata: ClosureFileMetadata,
    shared_type_declarations: Vec<SharedHelperDeclaration>,
    pub(super) symbol_resolutions: HashMap<String, RuntimeTypeName>,
    pub(super) symbols_by_id: HashMap<String, ClosureTypeSymbol>,
}

impl BoundTypeMetadata {
    pub(crate) fn prepare(
        self,
        fresh_names: &mut FreshNameAllocator,
        runtime_names: &BindingKeyMap<RuntimeTypeName>,
        hoist_ordinal: Option<usize>,
    ) -> PreparedTypeMetadata {
        PreparedTypeMetadata::new(self, fresh_names, runtime_names, hoist_ordinal)
    }
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
        for (symbol_id, binding) in &bound.declared_value_bindings {
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
                // Type-only imports have no JS binding in this module. Using
                // the class's local name as a global Closure type produces
                // `Unknown type Model` under checkTypes.
                symbol_resolutions.insert(
                    symbol.id.clone(),
                    RuntimeTypeName::Unresolved("runtime-binding-not-found"),
                );
            } else if symbol.kind == "declared" {
                // A hoisted job concatenates modules: the bare authored name is
                // not the emitted binding, and a per-module synthetic name is
                // a distinct nominal type. Leave unresolved here; the
                // declaration_names pass assigns one job-wide name.
                if hoist_ordinal.is_some() {
                    continue;
                }
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
                if bound
                    .runtime_symbol_bindings
                    .contains_key(&declaration.declared_symbol_id)
                    || bound
                        .declared_value_bindings
                        .contains_key(&declaration.declared_symbol_id)
                {
                    continue;
                }
                let authored_name = bound
                    .symbols_by_id
                    .get(&declaration.declared_symbol_id)
                    .map(|symbol| symbol.diagnostic_name.as_str())
                    .unwrap_or("ClosureType");
                let preferred = hoist_ordinal
                    .map(|_| {
                        shared_type_declaration_name(authored_name, &declaration.declared_symbol_id)
                    })
                    .unwrap_or_else(|| authored_name.to_string());
                declaration_names.insert(
                    declaration.declared_symbol_id.clone(),
                    if hoist_ordinal.is_some() {
                        preferred
                    } else {
                        fresh_names.fresh(&preferred)
                    },
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
        let mut shared_type_declarations = Vec::new();
        if bound.enabled {
            let synthesized = bound
                .metadata
                .declarations
                .iter()
                .filter(|declaration| {
                    declaration_names.contains_key(&declaration.declared_symbol_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            let first_pass = render_declarations(
                &bound.metadata,
                &synthesized,
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
                    &synthesized,
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
                    let emitted = code.trim().to_string();
                    let template = declaration.template.trim();
                    if !template.is_empty() {
                        delivery.declarations.push(template.to_string());
                    }
                    if hoist_ordinal.is_some() {
                        if let Some(canonical_name) = declaration_names.get(&declaration.symbol_id)
                        {
                            shared_type_declarations.push(SharedHelperDeclaration {
                                canonical_name: canonical_name.clone(),
                                text: emitted,
                            });
                        }
                    } else {
                        declaration_lines.push(emitted);
                    }
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
            shared_type_declarations,
            symbol_resolutions,
            symbols_by_id: bound.symbols_by_id,
        }
    }

    pub(crate) fn take_declaration_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.declaration_lines)
    }
    pub(crate) fn take_shared_type_declarations(&mut self) -> Vec<SharedHelperDeclaration> {
        std::mem::take(&mut self.shared_type_declarations)
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

fn shared_type_declaration_name(authored_name: &str, symbol_id: &str) -> String {
    let base = if is_valid_js_identifier(authored_name) {
        authored_name
    } else {
        "ClosureType"
    };
    format!("{base}$$type$${symbol_id}")
}

fn in_graph_type_name(symbol: &crate::closure_metadata::ClosureTypeSymbol) -> Option<String> {
    if symbol.kind == "declared" {
        if let Some(name) = symbol.local_name.as_deref() {
            if is_valid_js_identifier(name) {
                return Some(name.to_string());
            }
        }
        return is_valid_js_identifier(&symbol.diagnostic_name)
            .then(|| symbol.diagnostic_name.clone());
    }
    let path = symbol.declaration_file_path.as_deref()?;
    if is_declaration_file_path(path) {
        return None;
    }
    if let Some(name) = symbol.local_name.as_deref() {
        if is_valid_js_identifier(name) {
            return Some(name.to_string());
        }
    }
    is_valid_js_identifier(&symbol.diagnostic_name).then(|| symbol.diagnostic_name.clone())
}

fn is_declaration_file_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".d.ts")
        || lower.ends_with(".d.mts")
        || lower.ends_with(".d.cts")
        || lower.ends_with(".d.tsx")
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
