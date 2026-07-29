//! Symbol-aware Closure type metadata delivery.
//!
//! TypeScript supplies tokenized templates and canonical symbol ids. Native binds
//! targets to resolved SWC ids before emitter rewrites, then substitutes tokens
//! only after the final runtime/import/hoist names are known.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use swc_core::common::Mark;
use swc_core::ecma::ast::{
    ClassMember, Decl, Id, ImportSpecifier, Module, ModuleItem, Program, PropName, Stmt,
};
use swc_core::ecma::visit::{Visit, VisitWith};
use swc_ecma_transforms_base::resolver;

use super::*;
use crate::closure_metadata::{
    ClosureAnnotation, ClosureAnnotationTarget, ClosureEnumDeclaration, ClosureFileMetadata,
    ClosureTypeDeclaration, ClosureTypeReference, ClosureTypeSymbol, TypeMetadataCounts,
    TypeMetadataDiagnostic,
};

pub(crate) const PURE_TAG: &str = "@pureOrBreakMyCode";

#[derive(Clone, Debug)]
pub(crate) enum RuntimeTypeName {
    Name(String),
    Unresolved(&'static str),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TypeMetadataDelivery {
    pub(crate) counts: TypeMetadataCounts,
    pub(crate) diagnostics: Vec<TypeMetadataDiagnostic>,
}

#[derive(Clone, Debug)]
pub(crate) struct BoundTypeMetadata {
    binding_annotations: HashMap<Id, Vec<ClosureAnnotation>>,
    diagnostics: Vec<TypeMetadataDiagnostic>,
    enabled: bool,
    member_annotations: HashMap<Id, Vec<ClosureAnnotation>>,
    metadata: ClosureFileMetadata,
    runtime_symbol_bindings: HashMap<String, Id>,
    symbols_by_id: HashMap<String, ClosureTypeSymbol>,
}

impl BoundTypeMetadata {
    pub(crate) fn bind(
        module: &Module,
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
        let top_level_bindings = collect_top_level_bindings(module);
        let mut diagnostics = metadata.diagnostics.clone();
        let mut binding_annotations = HashMap::<Id, Vec<ClosureAnnotation>>::new();
        let mut member_annotations = HashMap::<Id, Vec<ClosureAnnotation>>::new();
        let mut runtime_symbol_bindings = HashMap::new();

        for symbol in &metadata.symbols {
            if symbol.kind != "runtime" {
                continue;
            }
            let Some(local_name) = symbol.local_name.as_deref() else {
                continue;
            };
            if let Some(binding_id) = unique_binding_id(&top_level_bindings, local_name) {
                runtime_symbol_bindings.insert(symbol.id.clone(), binding_id);
            }
        }

        if enabled {
            for annotation in &metadata.annotations {
                match &annotation.target {
                    ClosureAnnotationTarget::Binding { binding_name } => {
                        if let Some(binding_id) =
                            unique_binding_id(&top_level_bindings, binding_name)
                        {
                            binding_annotations
                                .entry(binding_id)
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
                        if let Some(owner_id) =
                            unique_binding_id(&top_level_bindings, owner_binding_name)
                        {
                            member_annotations
                                .entry(owner_id)
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

    pub(crate) fn remap_binding_ids(&mut self, renames: &HashMap<Id, String>) {
        self.binding_annotations =
            remap_id_keyed_map(std::mem::take(&mut self.binding_annotations), renames);
        self.member_annotations =
            remap_id_keyed_map(std::mem::take(&mut self.member_annotations), renames);
        for binding_id in self.runtime_symbol_bindings.values_mut() {
            if let Some(name) = renames.get(binding_id) {
                binding_id.0 = name.clone().into();
            }
        }
    }

    pub(crate) fn runtime_binding_ids(&self) -> impl Iterator<Item = &Id> {
        self.runtime_symbol_bindings.values()
    }

    pub(crate) fn prepare(
        self,
        fresh_names: &mut FreshNameAllocator,
        runtime_names: &HashMap<Id, RuntimeTypeName>,
        hoist_ordinal: Option<usize>,
    ) -> PreparedTypeMetadata {
        PreparedTypeMetadata::new(self, fresh_names, runtime_names, hoist_ordinal)
    }
}

fn remap_id_keyed_map<T>(values: HashMap<Id, T>, renames: &HashMap<Id, String>) -> HashMap<Id, T> {
    values
        .into_iter()
        .map(|(mut id, value)| {
            if let Some(name) = renames.get(&id) {
                id.0 = name.clone().into();
            }
            (id, value)
        })
        .collect()
}

pub(crate) struct PreparedTypeMetadata {
    binding_annotations: HashMap<Id, Vec<ClosureAnnotation>>,
    declaration_lines: Vec<String>,
    delivery: TypeMetadataDelivery,
    enum_names: HashMap<String, String>,
    member_annotations: HashMap<Id, Vec<ClosureAnnotation>>,
    metadata: ClosureFileMetadata,
    symbol_resolutions: HashMap<String, RuntimeTypeName>,
    symbols_by_id: HashMap<String, ClosureTypeSymbol>,
}

impl PreparedTypeMetadata {
    fn new(
        bound: BoundTypeMetadata,
        fresh_names: &mut FreshNameAllocator,
        runtime_names: &HashMap<Id, RuntimeTypeName>,
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

        for (symbol_id, binding_id) in &bound.runtime_symbol_bindings {
            symbol_resolutions.insert(
                symbol_id.clone(),
                runtime_names
                    .get(binding_id)
                    .cloned()
                    .unwrap_or(RuntimeTypeName::Unresolved("runtime-binding-not-found")),
            );
        }
        for symbol in bound.symbols_by_id.values() {
            if symbol.kind == "runtime" && !symbol_resolutions.contains_key(&symbol.id) {
                symbol_resolutions.insert(
                    symbol.id.clone(),
                    RuntimeTypeName::Unresolved("runtime-binding-not-found"),
                );
            }
        }

        let mut enum_names = HashMap::new();
        for enum_decl in &bound.metadata.enums {
            let preferred = hoist_ordinal
                .map(|ordinal| suffixed_name(&enum_decl.binding_name, ordinal))
                .unwrap_or_else(|| enum_decl.binding_name.clone());
            let emitted_name = fresh_names.fresh(&preferred);
            enum_names.insert(enum_decl.symbol_id.clone(), emitted_name.clone());
            symbol_resolutions.insert(
                enum_decl.symbol_id.clone(),
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
            );
            let failed_ids = first_pass
                .iter()
                .filter_map(|rendered| rendered.code.is_none().then(|| rendered.symbol_id.clone()))
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

    pub(crate) fn render_statement(
        &mut self,
        mut statement: Stmt,
        tags: &[&str],
    ) -> std::result::Result<String, String> {
        let binding_ids = declared_statement_ids(&statement);
        if binding_ids.len() > 1 {
            let mut had_metadata = false;
            for binding_id in &binding_ids {
                had_metadata |= self.binding_annotations.remove(binding_id).is_some();
                had_metadata |= self.member_annotations.remove(binding_id).is_some();
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
                print_statement(statement)?
            ));
        }
        let annotation_owner = (binding_ids.len() == 1).then(|| binding_ids[0].clone());
        let binding_annotations = annotation_owner
            .as_ref()
            .and_then(|id| self.binding_annotations.remove(id))
            .unwrap_or_default();
        let member_annotations = annotation_owner
            .as_ref()
            .and_then(|id| self.member_annotations.remove(id))
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
        let owner_name = declared_statement_name(&statement);
        let mut code = print_statement(statement)?;
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

#[derive(Clone)]
struct RenderedMemberAnnotation {
    annotation: ClosureAnnotation,
    target: String,
    text: String,
}

struct RenderedTemplate {
    diagnostics: Vec<TypeMetadataDiagnostic>,
    text: String,
    unresolved_count: u32,
}

struct RenderedDeclaration {
    code: Option<String>,
    diagnostics: Vec<TypeMetadataDiagnostic>,
    rendered_counts: TypeMetadataCounts,
    symbol_id: String,
}

fn render_declarations(
    metadata: &ClosureFileMetadata,
    declarations: &[ClosureTypeDeclaration],
    symbols_by_id: &HashMap<String, ClosureTypeSymbol>,
    declaration_names: &HashMap<String, String>,
    symbol_resolutions: &HashMap<String, RuntimeTypeName>,
) -> Vec<RenderedDeclaration> {
    declarations
        .iter()
        .map(|declaration| {
            let target = format!("type declaration {}", declaration.id);
            let rendered = render_template(
                metadata,
                &declaration.template,
                &declaration.references,
                symbols_by_id,
                symbol_resolutions,
                Some(target.clone()),
            );
            let authored_name = symbols_by_id
                .get(&declaration.declared_symbol_id)
                .map(|symbol| symbol.diagnostic_name.as_str())
                .unwrap_or("ClosureType");
            let emitted_name = declaration_names
                .get(&declaration.declared_symbol_id)
                .map(String::as_str)
                .unwrap_or(authored_name);
            let mut diagnostics = rendered.diagnostics;
            let code =
                rename_declaration_template(&rendered.text, authored_name, emitted_name).ok();
            if code.is_none() {
                diagnostics.push(TypeMetadataDiagnostic::delivery(
                    metadata,
                    "declaration-parse-failed",
                    symbols_by_id.get(&declaration.declared_symbol_id),
                    Some(target),
                ));
            }
            RenderedDeclaration {
                rendered_counts: TypeMetadataCounts {
                    typeDeclarationCount: u32::from(code.is_some()),
                    unresolvedTypeReferenceCount: rendered.unresolved_count,
                    ..Default::default()
                },
                code,
                diagnostics,
                symbol_id: declaration.declared_symbol_id.clone(),
            }
        })
        .collect()
}

fn render_template(
    metadata: &ClosureFileMetadata,
    template: &str,
    references: &[ClosureTypeReference],
    symbols_by_id: &HashMap<String, ClosureTypeSymbol>,
    symbol_resolutions: &HashMap<String, RuntimeTypeName>,
    target: Option<String>,
) -> RenderedTemplate {
    let mut text = template.to_string();
    let mut diagnostics = Vec::new();
    let mut unresolved_count = 0u32;
    for reference in references {
        let (replacement, reason) = match symbol_resolutions.get(&reference.symbol_id) {
            Some(RuntimeTypeName::Name(name)) => (name.as_str(), None),
            Some(RuntimeTypeName::Unresolved(reason)) => ("?", Some(*reason)),
            None => ("?", Some("runtime-binding-not-found")),
        };
        if reason.is_some() {
            text = replace_unresolved_reference(&text, &reference.token);
        } else {
            text = text.replace(&reference.token, replacement);
        }
        if let Some(reason) = reason {
            unresolved_count += 1;
            diagnostics.push(TypeMetadataDiagnostic::delivery(
                metadata,
                reason,
                symbols_by_id.get(&reference.symbol_id),
                target.clone(),
            ));
        }
    }
    RenderedTemplate {
        diagnostics,
        text,
        unresolved_count,
    }
}

fn replace_unresolved_reference(template: &str, token: &str) -> String {
    let mut output = template.to_string();
    while let Some(token_start) = output.find(token) {
        let mut start = token_start;
        if start > 0 && matches!(output.as_bytes()[start - 1], b'!' | b'?') {
            start -= 1;
        }
        let mut end = token_start + token.len();
        if output.as_bytes().get(end) == Some(&b'<') {
            let mut depth = 0usize;
            for (offset, byte) in output.as_bytes()[end..].iter().copied().enumerate() {
                if byte == b'<' {
                    depth += 1;
                } else if byte == b'>' {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end += offset + 1;
                        break;
                    }
                }
            }
        }
        output.replace_range(start..end, "?");
    }
    output
}

fn rename_declaration_template(
    template: &str,
    authored_name: &str,
    emitted_name: &str,
) -> std::result::Result<String, String> {
    let module = parse_module(Path::new("closure-type-metadata.js"), template)?;
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    let mut program = Program::Module(module);
    resolver(unresolved_mark, top_level_mark, false).process(&mut program);
    let Program::Module(module) = program else {
        return Err("Expected declaration module".to_string());
    };
    let bindings = collect_top_level_bindings(&module);
    let target_id = unique_binding_id(&bindings, authored_name)
        .ok_or_else(|| format!("Missing declaration binding {authored_name}"))?;
    let mut collector = IdentifierEditCollector {
        edits: Vec::new(),
        emitted_name,
        target_id,
    };
    module.visit_with(&mut collector);
    apply_source_edits(template, collector.edits)
}

struct IdentifierEditCollector<'a> {
    edits: Vec<(usize, usize, String)>,
    emitted_name: &'a str,
    target_id: Id,
}

impl Visit for IdentifierEditCollector<'_> {
    fn visit_ident(&mut self, ident: &Ident) {
        if ident.to_id() == self.target_id {
            self.edits.push((
                ident.span.lo.0.saturating_sub(1) as usize,
                ident.span.hi.0.saturating_sub(1) as usize,
                self.emitted_name.to_string(),
            ));
        }
    }
}

fn apply_source_edits(
    source: &str,
    mut edits: Vec<(usize, usize, String)>,
) -> std::result::Result<String, String> {
    edits.sort_by_key(|(start, _, _)| *start);
    let mut output = source.to_string();
    for (start, end, replacement) in edits.into_iter().rev() {
        if start > end
            || end > output.len()
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            return Err("Invalid type declaration source edit span".to_string());
        }
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

pub(crate) fn runtime_type_names_from_module(
    module: &Module,
    bound: &BoundTypeMetadata,
) -> HashMap<Id, RuntimeTypeName> {
    let current_names = collect_top_level_bindings(module)
        .into_iter()
        .flat_map(|(name, ids)| {
            ids.into_iter()
                .map(move |id| (id, RuntimeTypeName::Name(name.clone())))
        })
        .collect::<HashMap<_, _>>();
    bound
        .runtime_binding_ids()
        .filter_map(|id| {
            current_names
                .get(id)
                .cloned()
                .map(|name| (id.clone(), name))
        })
        .collect()
}

pub(crate) fn declared_statement_ids(statement: &Stmt) -> Vec<Id> {
    match statement {
        Stmt::Decl(Decl::Fn(declaration)) => vec![declaration.ident.to_id()],
        Stmt::Decl(Decl::Class(declaration)) => vec![declaration.ident.to_id()],
        Stmt::Decl(Decl::Var(declaration)) => declaration
            .decls
            .iter()
            .flat_map(|declarator| export_binding_names_with_ids(&declarator.name))
            .map(|(id, _)| id)
            .collect(),
        _ => Vec::new(),
    }
}

fn declared_statement_name(statement: &Stmt) -> Option<String> {
    let ids = declared_statement_ids(statement);
    let [id] = ids.as_slice() else {
        return None;
    };
    Some(id.0.to_string())
}

fn collect_top_level_bindings(module: &Module) -> HashMap<String, Vec<Id>> {
    let mut bindings = HashMap::<String, Vec<Id>>::new();
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                for specifier in &import_decl.specifiers {
                    let local = match specifier {
                        ImportSpecifier::Default(value) => &value.local,
                        ImportSpecifier::Named(value) => &value.local,
                        ImportSpecifier::Namespace(value) => &value.local,
                    };
                    push_binding(&mut bindings, local);
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                add_decl_bindings(&mut bindings, &export_decl.decl);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match &default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(value) => {
                    if let Some(ident) = &value.ident {
                        push_binding(&mut bindings, ident);
                    }
                }
                swc_core::ecma::ast::DefaultDecl::Class(value) => {
                    if let Some(ident) = &value.ident {
                        push_binding(&mut bindings, ident);
                    }
                }
                _ => {}
            },
            ModuleItem::Stmt(Stmt::Decl(decl)) => add_decl_bindings(&mut bindings, decl),
            _ => {}
        }
    }
    bindings
}

fn add_decl_bindings(bindings: &mut HashMap<String, Vec<Id>>, decl: &Decl) {
    match decl {
        Decl::Fn(declaration) => push_binding(bindings, &declaration.ident),
        Decl::Class(declaration) => push_binding(bindings, &declaration.ident),
        Decl::Var(declaration) => {
            for (id, name) in declaration
                .decls
                .iter()
                .flat_map(|declarator| export_binding_names_with_ids(&declarator.name))
            {
                bindings.entry(name).or_default().push(id);
            }
        }
        _ => {}
    }
}

fn push_binding(bindings: &mut HashMap<String, Vec<Id>>, ident: &Ident) {
    bindings
        .entry(ident.sym.to_string())
        .or_default()
        .push(ident.to_id());
}

fn unique_binding_id(bindings: &HashMap<String, Vec<Id>>, name: &str) -> Option<Id> {
    let ids = bindings.get(name)?;
    let [id] = ids.as_slice() else {
        return None;
    };
    Some(id.clone())
}

fn empty_metadata() -> ClosureFileMetadata {
    ClosureFileMetadata {
        ambient_globals: Vec::new(),
        erased_const_enums: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        file_path: String::new(),
        runtime_module_id: None,
        source_file_path: String::new(),
        symbols: Vec::new(),
    }
}

fn annotation_target_label(target: &ClosureAnnotationTarget) -> String {
    match target {
        ClosureAnnotationTarget::Binding { binding_name } => format!("binding {binding_name}"),
        ClosureAnnotationTarget::Member {
            member_kind,
            member_name,
            owner_binding_name,
            is_static,
        } => format!(
            "{} {}.{}{}",
            member_kind,
            owner_binding_name,
            member_name,
            if *is_static { " static" } else { "" }
        ),
    }
}

fn merge_jsdoc_blocks(blocks: &[String]) -> Option<String> {
    let mut tags = Vec::new();
    for block in blocks {
        let Some(body) = block
            .trim()
            .strip_prefix("/**")
            .and_then(|value| value.strip_suffix("*/"))
        else {
            continue;
        };
        tags.extend(
            body.lines()
                .map(|line| line.trim().trim_start_matches('*').trim())
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
    }
    if tags.is_empty() {
        None
    } else {
        Some(format!(
            "/**\n{}\n */\n",
            tags.into_iter()
                .map(|line| format!(" * {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

pub(crate) fn compose_annotations(tags: &[&str], typed: Option<&str>) -> String {
    match (tags.is_empty(), typed.filter(|block| !block.is_empty())) {
        (true, None) => String::new(),
        (true, Some(typed)) => typed.to_string(),
        (false, None) => format!("/** {} */\n", tags.join(" ")),
        (false, Some(typed)) => {
            let Some(rest) = typed.strip_prefix("/**") else {
                return typed.to_string();
            };
            format!("/** {}{rest}", tags.join(" "))
        }
    }
}

fn remove_bound_valueless_class_fields(statement: &mut Stmt, members: &[RenderedMemberAnnotation]) {
    let Stmt::Decl(Decl::Class(class_decl)) = statement else {
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
    class_decl.class.body.retain(|member| {
        let ClassMember::ClassProp(property) = member else {
            return true;
        };
        if property.value.is_some() {
            return true;
        }
        let Some(name) = prop_name_to_string(&property.key) else {
            return true;
        };
        !fields.contains(&(name.as_str(), property.is_static))
    });
}

fn prop_name_to_string(name: &PropName) -> Option<String> {
    match name {
        PropName::Ident(value) => Some(value.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Computed(value) => match &*value.expr {
            Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn is_class_declaration_text(code: &str) -> bool {
    code.trim_start().starts_with("class ")
}

fn render_class_field_declaration(
    owner: &str,
    member: &str,
    is_static: bool,
    jsdoc: &str,
) -> String {
    let base = if is_static {
        owner.to_string()
    } else {
        format!("{owner}.prototype")
    };
    let access = if is_valid_js_identifier(member) {
        format!("{base}.{member}")
    } else {
        format!("{base}[{member:?}]")
    };
    format!("if (false) {{\n{}{access};\n}}", indent_jsdoc(jsdoc, "  "))
}

fn indent_jsdoc(jsdoc: &str, indent: &str) -> String {
    jsdoc
        .trim_end()
        .lines()
        .map(|line| format!("{indent}{line}\n"))
        .collect()
}

fn insert_before_class_member(
    source: &mut String,
    member_kind: &str,
    member_name: &str,
    is_static: bool,
    jsdoc: &str,
) -> bool {
    let Some(class_body_start) = source.find('{') else {
        return false;
    };
    let Some(class_body_end) = find_matching_brace(source, class_body_start) else {
        return false;
    };
    let body_start = class_body_start + 1;
    let body = &source[body_start..class_body_end];
    let Some(member_index) = member_anchors(member_kind, member_name, is_static)
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source.insert_str(body_start + member_index, jsdoc);
    true
}

fn insert_before_object_member(
    source: &mut String,
    member_kind: &str,
    member_name: &str,
    jsdoc: &str,
) -> bool {
    let Some(equals) = source.find('=') else {
        return false;
    };
    let Some(object_body_start) = source[equals + 1..]
        .find('{')
        .map(|index| equals + 1 + index)
    else {
        return false;
    };
    let Some(object_body_end) = find_matching_brace(source, object_body_start) else {
        return false;
    };
    let body_start = object_body_start + 1;
    let body = &source[body_start..object_body_end];
    let Some(member_index) = member_anchors(member_kind, member_name, false)
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source.insert_str(body_start + member_index, jsdoc);
    true
}

fn find_member_anchor(body: &str, anchor: &str) -> Option<usize> {
    let pattern =
        regex::Regex::new(&format!(r"(?m)(^|[\n\r;{{}}])\s*{}", regex::escape(anchor))).ok()?;
    let match_ = pattern.find(body)?;
    let offset = match_.as_str().find(anchor)?;
    Some(match_.start() + offset)
}

fn member_anchors(member_kind: &str, name: &str, is_static: bool) -> Vec<String> {
    let bare = name.to_string();
    let quoted = format!("[{name:?}]");
    let prefixes = if is_static { vec!["static "] } else { vec![""] };
    prefixes
        .into_iter()
        .flat_map(|prefix| match member_kind {
            "constructor" => vec!["constructor(".to_string(), "constructor (".to_string()],
            "getter" => vec![
                format!("{prefix}get {bare}("),
                format!("{prefix}get {bare} ("),
                format!("{prefix}get {quoted}("),
                format!("{prefix}get {quoted} ("),
            ],
            "setter" => vec![
                format!("{prefix}set {bare}("),
                format!("{prefix}set {bare} ("),
                format!("{prefix}set {quoted}("),
                format!("{prefix}set {quoted} ("),
            ],
            "method" => vec![
                format!("{prefix}{bare}("),
                format!("{prefix}{bare} ("),
                format!("{prefix}{quoted}("),
                format!("{prefix}{quoted} ("),
            ],
            _ => vec![
                format!("{prefix}{bare}:"),
                format!("{prefix}{bare} :"),
                format!("{prefix}{quoted}:"),
                format!("{prefix}{quoted} :"),
                format!("{prefix}{bare}="),
                format!("{prefix}{bare} ="),
                format!("{prefix}{quoted}="),
                format!("{prefix}{quoted} ="),
            ],
        })
        .collect()
}

fn find_matching_brace(source_text: &str, open_index: usize) -> Option<usize> {
    let bytes = source_text.as_bytes();
    if bytes.get(open_index).copied()? != b'{' {
        return None;
    }
    let mut index = open_index;
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    while index < bytes.len() {
        let current = bytes[index];
        let next = bytes.get(index + 1).copied();
        if in_line_comment {
            if current == b'\n' {
                in_line_comment = false;
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if current == b'*' && next == Some(b'/') {
                in_block_comment = false;
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if current == b'\\' {
                escaped = true;
            } else if current == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if current == b'/' && next == Some(b'/') {
            in_line_comment = true;
            index += 2;
            continue;
        }
        if current == b'/' && next == Some(b'*') {
            in_block_comment = true;
            index += 2;
            continue;
        }
        if matches!(current, b'\'' | b'"' | b'`') {
            quote = Some(current);
            index += 1;
            continue;
        }
        if current == b'{' {
            depth += 1;
        } else if current == b'}' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unresolved_reference_degrades_only_its_token() {
        let metadata = empty_metadata();
        let symbols = HashMap::from([(
            "missing".to_string(),
            ClosureTypeSymbol {
                builtin_name: None,
                declaration_file_path: None,
                declaration_id: None,
                declaration_start: None,
                diagnostic_name: "Missing".to_string(),
                id: "missing".to_string(),
                kind: "runtime".to_string(),
                local_name: Some("Missing".to_string()),
            },
        )]);
        let rendered = render_template(
            &metadata,
            "/** @param {!__GCC_TYPE_0__<string>} value @return {number} */\n",
            &[ClosureTypeReference {
                symbol_id: "missing".to_string(),
                token: "__GCC_TYPE_0__".to_string(),
            }],
            &symbols,
            &HashMap::from([(
                "missing".to_string(),
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name"),
            )]),
            Some("binding use".to_string()),
        );
        assert_eq!(rendered.text, "/** @param {?} value @return {number} */\n");
        assert_eq!(rendered.unresolved_count, 1);
        assert_eq!(
            rendered.diagnostics[0].reason,
            "registry-slot-is-not-a-type-name"
        );
    }

    #[test]
    fn declaration_rename_preserves_jsdoc() {
        let rendered = GLOBALS.set(&Globals::new(), || {
            rename_declaration_template(
                "/** @record */\nfunction Config() {}\nif (false) {\n  /** @type {string} */\n  Config.prototype.name;\n}\n",
                "Config",
                "Config$$type$$2",
            )
        })
        .unwrap();
        assert!(rendered.contains("/** @record */"));
        assert!(rendered.contains("if (false)"));
        assert!(rendered.contains("function Config$$type$$2()"));
        assert!(rendered.contains("Config$$type$$2.prototype.name"));
    }

    #[test]
    fn annotation_composition_keeps_one_nearest_block() {
        assert_eq!(
            compose_annotations(
                &[PURE_TAG, "@noinline"],
                Some("/**\n * @return {number}\n */\n")
            ),
            "/** @pureOrBreakMyCode @noinline\n * @return {number}\n */\n"
        );
    }
}
