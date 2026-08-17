//! Oxc text-assembly core for `emit_goog.rs`.
//!
//! Type-metadata statement decoration remains owned by the later
//! `type_metadata` slice; this module ports the module/import/export assembly,
//! live-binding rewrite, and every direct statement/expression print to oxc.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, TakeIn, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, SPAN};
use oxc_str::Ident;

use super::emit::EmittedProgram;
use super::emit_runtime_oxc::{binding_names_with_ids, collect_reassigned_binding_ids};
use super::fresh_oxc::FreshNameAllocator;
use super::hoist_oxc::{scan_namespace_usage, NamespaceUsage};
use super::identity_oxc::{BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::lowering_oxc::closure_input_codegen_options;
use super::nocollapse_oxc::NocollapseAssignments;
use super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::{
    apply_js_compat_text_fixes, is_valid_js_identifier, live_export_accessor_name, member_access,
    resolve_module_id_for_specifier, resolve_relative_module, resolved_import_key,
    to_goog_module_id, PreservedImportPlan, TranspileContext,
};
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn emit_goog_module_program<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    quote_external_boundary_accesses(
        allocator,
        file_path,
        program,
        identity,
        context,
        file_metadata,
        ExternalBoundaryEvidence::All,
    );
    let namespace_usage = scan_namespace_usage(program, identity);
    let live_imported_ids = collect_live_imported_binding_ids(program, identity, file_path);
    if !live_imported_ids.is_empty() {
        LiveImportCallRewriter::new(allocator, identity, live_imported_ids.clone())
            .visit_program(program);
    }
    let live_imported_locals = live_imported_ids
        .iter()
        .map(|binding| identity.symbol(*binding).to_string())
        .collect::<HashSet<_>>();
    let live_exports = live_export_bindings(file_path);
    let bound = BoundTypeMetadata::bind(
        program,
        identity,
        file_metadata,
        context.type_metadata_enabled,
    );
    let nocollapse_assignments = NocollapseAssignments::collect(program);
    let runtime_type_names = runtime_type_names_from_program(program, identity, &bound);
    let mut fresh_names = FreshNameAllocator::from_program(program, identity);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(super::render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
        if declaration.exported {
            output.push(format!(
                "exports.{} = {};",
                declaration.binding_name, emitted_name
            ));
        }
    }
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    let mut preserved_extern_lines = Vec::new();
    let mut preserved_imports = Vec::new();
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if let Some(specifier) = context.external_specifiers.get(&resolved_import_key(
                    file_path,
                    import.source.value.as_str(),
                )) {
                    let plan = convert_external_import_decl(
                        &import,
                        specifier,
                        boundary_identity_token(context, &module_id, specifier),
                        None,
                        context.opaque_external_specifiers.contains(specifier),
                        &mut import_counter,
                        &mut fresh_names,
                    )?;
                    output.extend(plan.lines);
                    preserved_extern_lines.extend(plan.extern_lines);
                    preserved_imports.push(plan.preserved_import);
                } else {
                    let target_module_id = resolve_module_id_for_specifier(
                        file_path,
                        import.source.value.as_str(),
                        context,
                    )?;
                    if let Some(preserved) = context.preserved_modules.get(&target_module_id) {
                        validate_preserved_import(&import, preserved)?;
                        let mut plan = convert_external_import_decl(
                            &import,
                            import.source.value.as_str(),
                            boundary_identity_token(
                                context,
                                &module_id,
                                import.source.value.as_str(),
                            ),
                            Some((identity, &namespace_usage)),
                            false,
                            &mut import_counter,
                            &mut fresh_names,
                        )?;
                        plan.preserved_import.external_specifier = None;
                        plan.preserved_import.target_module_id = preserved.moduleId.clone();
                        output.extend(plan.lines);
                        preserved_extern_lines.extend(plan.extern_lines);
                        preserved_imports.push(plan.preserved_import);
                    } else {
                        output.extend(convert_import_decl(
                            file_path,
                            &import,
                            identity,
                            context,
                            &mut import_counter,
                            &mut fresh_names,
                            &live_imported_ids,
                        )?);
                    }
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    let exported_names = exported_decl_names(&declaration, identity);
                    output.push(type_metadata.render_statement_with_nocollapse(
                        identity,
                        declaration.into(),
                        &[],
                        Some(&nocollapse_assignments),
                    )?);
                    for export_name in exported_names {
                        output.push(format!("exports.{export_name} = {export_name};"));
                    }
                } else {
                    output.extend(convert_named_export(
                        file_path,
                        &export,
                        context,
                        &mut export_counter,
                        &mut fresh_names,
                        &live_imported_locals,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                    });
                export_counter += 1;
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function)
                        if function.id.is_some() =>
                    {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::FunctionDeclaration(function),
                            &[],
                            Some(&nocollapse_assignments),
                        )?);
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) if class.id.is_some() => {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::ClassDeclaration(class),
                            &[],
                            Some(&nocollapse_assignments),
                        )?);
                    }
                    declaration => {
                        let printed = print_node(&declaration);
                        output.push(format!(
                            "const {local_name} = {};",
                            printed.trim().trim_end_matches(';')
                        ));
                    }
                }
                output.push(format!("exports.default = {local_name};"));
            }
            Statement::ExportAllDeclaration(export) => output.extend(convert_export_all(
                file_path,
                &export,
                context,
                &mut export_counter,
                &mut fresh_names,
            )?),
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(type_metadata.render_statement_with_nocollapse(
                identity,
                statement,
                &[],
                Some(&nocollapse_assignments),
            )?),
        }
    }
    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }
    output.extend(render_live_export_accessors(&live_exports));
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(
            output
                .into_iter()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        preserved_extern_lines,
        preserved_imports,
        shared_helpers: Vec::new(),
        reflective_property_names: Default::default(),
        reifications: Vec::new(),
        type_metadata: type_metadata.finish(),
    })
}

#[cfg(test)]
pub(crate) fn emit_goog_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    emit_goog_module_program(
        allocator,
        file_path,
        program,
        identity,
        context,
        None,
        commonjs_export_name,
    )
    .map(|emitted| emitted.code)
}

fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

fn default_declaration_name<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'_>,
) -> Option<&'a str> {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            function.id.as_ref().map(|id| id.name.as_str())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            class.id.as_ref().map(|id| id.name.as_str())
        }
        _ => None,
    }
}

fn exported_decl_names(declaration: &Declaration<'_>, identity: &ModuleIdentity) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
            .map(|(_, name)| name)
            .collect(),
        Declaration::FunctionDeclaration(function) => {
            function.id.iter().map(|id| id.name.to_string()).collect()
        }
        Declaration::ClassDeclaration(class) => {
            class.id.iter().map(|id| id.name.to_string()).collect()
        }
        _ => Vec::new(),
    }
}

fn validate_preserved_import(
    import: &ImportDeclaration<'_>,
    preserved: &super::PreservedModuleInput,
) -> std::result::Result<(), String> {
    for specifier in import.specifiers.iter().flatten() {
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(_)
                if !preserved.hasDefaultExport =>
            {
                return Err(format!(
                    "Preserved module {} has no default export",
                    preserved.filePath
                ));
            }
            ImportDeclarationSpecifier::ImportSpecifier(named)
                if named.import_kind != ImportOrExportKind::Type =>
            {
                let imported_name = module_export_name(&named.imported);
                if !preserved.exportNames.contains(&imported_name) {
                    return Err(format!(
                        "Preserved module {} does not export {imported_name:?}",
                        preserved.filePath
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

struct ExternalImportPlan {
    extern_lines: Vec<String>,
    lines: Vec<String>,
    preserved_import: PreservedImportPlan,
}

pub(super) fn boundary_identity(module_id: &str, external_specifier: &str) -> String {
    format!("{module_id}\0{external_specifier}")
}

pub(super) fn allocate_boundary_identity_tokens(
    identities: impl IntoIterator<Item = String>,
) -> HashMap<String, String> {
    allocate_boundary_identity_tokens_with(identities, crate::utils::hash48_base36)
}

fn allocate_boundary_identity_tokens_with(
    identities: impl IntoIterator<Item = String>,
    token_for: impl Fn(&str) -> String,
) -> HashMap<String, String> {
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    for identity in identities.into_iter().collect::<BTreeSet<_>>() {
        groups
            .entry(token_for(&identity))
            .or_default()
            .push(identity);
    }
    let mut tokens = HashMap::new();
    for (base, identities) in groups {
        if identities.len() == 1 {
            tokens.insert(identities[0].clone(), base);
            continue;
        }
        for (ordinal, identity) in identities.into_iter().enumerate() {
            tokens.insert(
                identity,
                format!("{base}z{}", crate::utils::base36(ordinal as u64)),
            );
        }
    }
    tokens
}

fn boundary_identity_token(
    context: &TranspileContext,
    module_id: &str,
    external_specifier: &str,
) -> String {
    let identity = boundary_identity(module_id, external_specifier);
    context
        .boundary_identity_tokens
        .get(&identity)
        .cloned()
        .unwrap_or_else(|| crate::utils::hash48_base36(&identity))
}

fn fresh_boundary_name(
    fresh_names: &mut FreshNameAllocator,
    boundary_token: &str,
    import_index: usize,
    specifier_index: usize,
) -> String {
    let import_index = crate::utils::base36(import_index as u64);
    let specifier_index = crate::utils::base36(specifier_index as u64);
    let mut collision_ordinal = None;
    loop {
        let token = collision_ordinal.map_or_else(
            || boundary_token.to_string(),
            |ordinal| format!("{boundary_token}z{}", crate::utils::base36(ordinal)),
        );
        let candidate = format!("e{token}_{import_index}_{specifier_index}");
        if fresh_names.try_reserve(&candidate) {
            return candidate;
        }
        collision_ordinal = Some(collision_ordinal.map_or(0, |ordinal| ordinal + 1));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ExternalBoundaryEvidence {
    All,
    GlobalOnly,
}

pub(super) fn quote_external_boundary_accesses<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    evidence: ExternalBoundaryEvidence,
) {
    let external_root_starts = file_metadata
        .map(|metadata| {
            metadata
                .external_global_member_accesses
                .iter()
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let external_member_starts = file_metadata
        .map(|metadata| {
            metadata
                .external_global_member_accesses
                .iter()
                .chain(
                    (evidence == ExternalBoundaryEvidence::All)
                        .then_some(metadata.external_owned_member_accesses.as_slice())
                        .into_iter()
                        .flatten(),
                )
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let mut candidates = BindingKeySet::default();
    if evidence == ExternalBoundaryEvidence::All {
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if !context
                .external_specifiers
                .contains_key(&resolved_import_key(
                    file_path,
                    import.source.value.as_str(),
                ))
            {
                continue;
            }
            if import.import_kind == ImportOrExportKind::Type {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                match specifier {
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                        candidates.insert(identity.key_of_binding(&default.local));
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                        candidates.insert(identity.key_of_binding(&namespace.local));
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(named)
                        if named.import_kind != ImportOrExportKind::Type =>
                    {
                        candidates.insert(identity.key_of_binding(&named.local));
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(_) => {}
                }
            }
        }
    }
    if candidates.is_empty() && external_member_starts.is_empty() {
        return;
    }
    loop {
        let mut collector = ExternalDerivedBindingCollector {
            candidates: &mut candidates,
            changed: false,
            external_root_starts: &external_root_starts,
            identity,
        };
        collector.visit_program(program);
        if !collector.changed {
            break;
        }
    }
    ExternalBoundaryAccessQuoter {
        allocator,
        builder: AstBuilder::new(allocator),
        candidates,
        external_member_starts,
        external_root_starts,
        identity,
    }
    .visit_program(program);
}

struct ExternalBoundaryAccessQuoter<'a, 'b> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    candidates: BindingKeySet,
    external_member_starts: HashSet<u32>,
    external_root_starts: HashSet<u32>,
    identity: &'b ModuleIdentity,
}

impl ExternalBoundaryAccessQuoter<'_, '_> {
    fn is_external_boundary_value(&self, expression: &Expression<'_>) -> bool {
        is_external_boundary_value(
            expression,
            &self.candidates,
            &self.external_root_starts,
            self.identity,
        )
    }
}

struct ExternalDerivedBindingCollector<'b> {
    candidates: &'b mut BindingKeySet,
    changed: bool,
    external_root_starts: &'b HashSet<u32>,
    identity: &'b ModuleIdentity,
}

impl<'a> Visit<'a> for ExternalDerivedBindingCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if declarator.init.as_ref().is_some_and(|initializer| {
            is_external_boundary_value(
                initializer,
                self.candidates,
                self.external_root_starts,
                self.identity,
            )
        }) {
            if let Some(binding) = declarator.id.get_binding_identifier() {
                self.changed |= self
                    .candidates
                    .insert(self.identity.key_of_binding(binding));
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn is_external_boundary_value(
    expression: &Expression<'_>,
    candidates: &BindingKeySet,
    external_member_starts: &HashSet<u32>,
    identity: &ModuleIdentity,
) -> bool {
    let recurse = |expression| {
        is_external_boundary_value(expression, candidates, external_member_starts, identity)
    };
    match expression {
        Expression::Identifier(identifier) => identity
            .key_of_reference(identifier)
            .is_some_and(|binding| candidates.contains(&binding)),
        Expression::StaticMemberExpression(member) => {
            // Object.assign returns its first argument. Treating the method as
            // an opaque boundary quotes result reads but not the copied writes.
            !(member.property.name == "assign"
                && matches!(&member.object, Expression::Identifier(object)
                    if object.name == "Object" && identity.key_of_reference(object).is_none()))
                && (external_member_starts.contains(&member.property.span.start)
                    || recurse(&member.object))
        }
        Expression::ComputedMemberExpression(member) => {
            external_member_starts.contains(&member.expression.span().start)
                || recurse(&member.object)
        }
        Expression::AssignmentExpression(assignment) => recurse(&assignment.right),
        Expression::AwaitExpression(awaited) => recurse(&awaited.argument),
        Expression::CallExpression(call) => recurse(&call.callee),
        Expression::ConditionalExpression(conditional) => {
            recurse(&conditional.consequent) || recurse(&conditional.alternate)
        }
        Expression::LogicalExpression(logical) => recurse(&logical.left) || recurse(&logical.right),
        Expression::NewExpression(constructor) => recurse(&constructor.callee),
        Expression::ParenthesizedExpression(parenthesized) => recurse(&parenthesized.expression),
        Expression::SequenceExpression(sequence) => {
            sequence.expressions.last().is_some_and(recurse)
        }
        Expression::TaggedTemplateExpression(tagged) => recurse(&tagged.tag),
        Expression::TSAsExpression(expression) => recurse(&expression.expression),
        Expression::TSSatisfiesExpression(expression) => recurse(&expression.expression),
        Expression::TSTypeAssertion(expression) => recurse(&expression.expression),
        Expression::TSNonNullExpression(expression) => recurse(&expression.expression),
        Expression::TSInstantiationExpression(expression) => recurse(&expression.expression),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                external_member_starts.contains(&member.property.span.start)
                    || recurse(&member.object)
            }
            ChainElement::ComputedMemberExpression(member) => {
                external_member_starts.contains(&member.expression.span().start)
                    || recurse(&member.object)
            }
            ChainElement::CallExpression(call) => recurse(&call.callee),
            ChainElement::TSNonNullExpression(expression) => recurse(&expression.expression),
            _ => false,
        },
        _ => false,
    }
}

impl<'a> VisitMut<'a> for ExternalBoundaryAccessQuoter<'a, '_> {
    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        walk_mut::walk_simple_assignment_target(self, target);
        let SimpleAssignmentTarget::StaticMemberExpression(member) = target else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *target = SimpleAssignmentTarget::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_chain_element(&mut self, element: &mut ChainElement<'a>) {
        walk_mut::walk_chain_element(self, element);
        let ChainElement::StaticMemberExpression(member) = element else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *element = ChainElement::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let Expression::StaticMemberExpression(member) = expression else {
            return;
        };
        if !self.is_external_boundary_value(&member.object)
            && !self
                .external_member_starts
                .contains(&member.property.span.start)
        {
            return;
        }
        let property: Ident<'a> = Ident::from_in(member.property.name.as_str(), self.allocator);
        *expression = Expression::new_computed_member_expression(
            member.span,
            member.object.take_in(&self.builder),
            Expression::new_string_literal(member.property.span, property, None, &self.builder),
            member.optional,
            &self.builder,
        );
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        walk_mut::walk_binding_property(self, property);
        if let Some((span, name)) =
            quoted_property_key(&property.key, &self.external_member_starts, self.allocator)
        {
            property.key = PropertyKey::new_string_literal(span, name, None, &self.builder);
            property.shorthand = false;
            property.computed = false;
        }
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        walk_mut::walk_object_property(self, property);
        if let Some((span, name)) =
            quoted_property_key(&property.key, &self.external_member_starts, self.allocator)
        {
            property.key = PropertyKey::new_string_literal(span, name, None, &self.builder);
            property.shorthand = false;
            property.computed = false;
        }
    }
}

fn quoted_property_key<'a>(
    key: &PropertyKey<'a>,
    external_member_starts: &HashSet<u32>,
    allocator: &'a Allocator,
) -> Option<(oxc_span::Span, Ident<'a>)> {
    let PropertyKey::StaticIdentifier(identifier) = key else {
        return None;
    };
    external_member_starts
        .contains(&identifier.span.start)
        .then(|| {
            (
                identifier.span,
                Ident::from_in(identifier.name.as_str(), allocator),
            )
        })
}

fn convert_external_import_decl(
    import: &ImportDeclaration<'_>,
    external_specifier: &str,
    boundary_token: String,
    namespace_externs: Option<(&ModuleIdentity, &NamespaceUsage)>,
    opaque_external: bool,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
) -> std::result::Result<ExternalImportPlan, String> {
    if import.import_kind == ImportOrExportKind::Type {
        return Ok(ExternalImportPlan {
            extern_lines: Vec::new(),
            lines: Vec::new(),
            preserved_import: PreservedImportPlan {
                boundary_exports: Vec::new(),
                boundary_names: Vec::new(),
                external_specifier: Some(external_specifier.to_string()),
                import_clause: String::new(),
                target_module_id: String::new(),
            },
        });
    }
    let import_index = *import_counter;
    *import_counter += 1;
    let mut boundary_exports = Vec::new();
    let mut boundary_names = Vec::new();
    let mut extern_lines = Vec::new();
    let mut lines = Vec::new();
    let mut default_binding = None;
    let mut namespace_binding = None;
    let mut named_bindings = Vec::new();
    for (specifier_index, specifier) in import.specifiers.iter().flatten().enumerate() {
        if matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named) if named.import_kind == ImportOrExportKind::Type)
        {
            continue;
        }
        let boundary =
            fresh_boundary_name(fresh_names, &boundary_token, import_index, specifier_index);
        boundary_names.push(boundary.clone());
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                extern_lines.push(format!("/** @type {{?}} */ var {boundary};"));
                boundary_exports.push("default".to_string());
                default_binding = Some(boundary.clone());
                lines.push(format!("const {} = {boundary};", default.local.name));
            }
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                extern_lines.push(format!("/** @type {{?}} */ var {boundary};"));
                let imported_name = module_export_name(&named.imported);
                let rendered_name = if is_valid_js_identifier(&imported_name) {
                    imported_name.clone()
                } else {
                    format!("{imported_name:?}")
                };
                boundary_exports.push(imported_name);
                named_bindings.push(format!("{rendered_name} as {boundary}"));
                lines.push(format!("const {} = {boundary};", named.local.name));
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                boundary_exports.push("*".to_string());
                if namespace_externs.is_none() && !opaque_external {
                    extern_lines.push(format!("/** @const */ var {boundary} = {{}};"));
                } else {
                    extern_lines.push(format!("/** @type {{?}} */ var {boundary};"));
                }
                if let Some((identity, namespace_usage)) = namespace_externs {
                    if let Some(member_names) =
                        namespace_usage.member_only_usage(identity.key_of_binding(&namespace.local))
                    {
                        extern_lines.extend(
                            member_names
                                .into_iter()
                                .filter(|name| is_valid_js_identifier(name))
                                .map(|name| format!("{boundary}.{name};")),
                        );
                    }
                }
                namespace_binding = Some(boundary.clone());
                lines.push(format!("const {} = {boundary};", namespace.local.name));
            }
        }
    }
    let import_clause = match (
        default_binding,
        namespace_binding,
        named_bindings.is_empty(),
    ) {
        (None, None, true) => String::new(),
        (Some(default), None, true) => default,
        (None, Some(namespace), true) => format!("* as {namespace}"),
        (Some(default), Some(namespace), true) => format!("{default}, * as {namespace}"),
        (None, None, false) => format!("{{ {} }}", named_bindings.join(", ")),
        (Some(default), None, false) => {
            format!("{default}, {{ {} }}", named_bindings.join(", "))
        }
        (_, Some(_), false) => {
            return Err(format!(
                "External import from {external_specifier:?} has an unsupported namespace/named combination"
            ));
        }
    };
    Ok(ExternalImportPlan {
        extern_lines,
        lines,
        preserved_import: PreservedImportPlan {
            boundary_exports,
            boundary_names,
            external_specifier: Some(external_specifier.to_string()),
            import_clause,
            target_module_id: String::new(),
        },
    })
}

fn convert_import_decl(
    file_path: &Path,
    import: &ImportDeclaration<'_>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    live_imported_ids: &BindingKeySet,
) -> std::result::Result<Vec<String>, String> {
    let module_id =
        resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)?;
    let Some(specifiers) = &import.specifiers else {
        return Ok(vec![format!("goog.require({module_id:?});")]);
    };
    if specifiers.is_empty() {
        return Ok(vec![format!("goog.require({module_id:?});")]);
    }

    let mut value = Vec::new();
    let mut types = Vec::new();
    for specifier in specifiers {
        let is_type = import.import_kind == ImportOrExportKind::Type
            || matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named)
                if named.import_kind == ImportOrExportKind::Type);
        if is_type {
            types.push(specifier);
        } else {
            value.push(specifier);
        }
    }

    let mut lines = Vec::new();
    if !value.is_empty() {
        let local_name = fresh_names.fresh(&format!("__goog_import_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!("const {local_name} = goog.require({module_id:?});"));
        lines.extend(bind_import_specifiers(
            &local_name,
            &value,
            identity,
            live_imported_ids,
        ));
    }
    if !types.is_empty() {
        let local_name = fresh_names.fresh(&format!("__goog_type_{}", *import_counter));
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = goog.requireType({module_id:?});"
        ));
        lines.extend(bind_import_specifiers(
            &local_name,
            &types,
            identity,
            &HashSet::new(),
        ));
    }
    Ok(lines)
}

fn bind_import_specifiers(
    require_name: &str,
    specifiers: &[&ImportDeclarationSpecifier<'_>],
    identity: &ModuleIdentity,
    live_imported_ids: &BindingKeySet,
) -> Vec<String> {
    specifiers
        .iter()
        .map(|specifier| match specifier {
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                let local = named.local.name.as_str();
                let imported = module_export_name(&named.imported);
                let property = if live_imported_ids.contains(&identity.key_of_binding(&named.local))
                {
                    live_export_accessor_name(&imported)
                } else {
                    imported
                };
                format!(
                    "const {local} = {};",
                    member_access(require_name, &property)
                )
            }
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => format!(
                "const {} = {};",
                default.local.name,
                member_access(require_name, "default")
            ),
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                format!("const {} = {require_name};", namespace.local.name)
            }
        })
        .collect()
}

fn convert_named_export(
    file_path: &Path,
    export: &ExportNamedDeclaration<'_>,
    context: &TranspileContext,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    live_imported_locals: &HashSet<String>,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let mut lines = Vec::new();
    if let Some(source) = &export.source {
        let require_name = fresh_names.fresh(&format!("__goog_export_{}", *export_counter));
        *export_counter += 1;
        let module_id = resolve_module_id_for_specifier(file_path, source.value.as_str(), context)?;
        lines.push(format!(
            "const {require_name} = goog.require({module_id:?});"
        ));
        for specifier in &export.specifiers {
            if specifier.export_kind == ImportOrExportKind::Type {
                continue;
            }
            lines.push(format!(
                "exports.{} = {};",
                module_export_name(&specifier.exported),
                member_access(&require_name, &module_export_name(&specifier.local))
            ));
        }
        return Ok(lines);
    }

    for specifier in &export.specifiers {
        if specifier.export_kind == ImportOrExportKind::Type {
            continue;
        }
        let local = module_export_name(&specifier.local);
        let value = if live_imported_locals.contains(&local) {
            format!("{local}()")
        } else {
            local
        };
        lines.push(format!(
            "exports.{} = {value};",
            module_export_name(&specifier.exported)
        ));
    }
    Ok(lines)
}

fn convert_export_all(
    file_path: &Path,
    export: &ExportAllDeclaration<'_>,
    context: &TranspileContext,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let prefix = if export.exported.is_some() {
        "__goog_export_"
    } else {
        "__goog_export_all_"
    };
    let require_name = fresh_names.fresh(&format!("{prefix}{}", *export_counter));
    *export_counter += 1;
    let module_id =
        resolve_module_id_for_specifier(file_path, export.source.value.as_str(), context)?;
    let mut lines = vec![format!(
        "const {require_name} = goog.require({module_id:?});"
    )];
    if let Some(exported) = &export.exported {
        lines.push(format!(
            "exports.{} = {require_name};",
            module_export_name(exported)
        ));
    } else {
        lines.push(format!(
            "for (const key in {require_name}) {{ if (key !== \"default\") {{ exports[key] = {require_name}[key]; }} }}"
        ));
    }
    Ok(lines)
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(string) => string.value.to_string(),
    }
}

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

fn live_export_bindings_of_program(
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

fn collect_live_imported_binding_ids(
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

fn render_live_export_accessors(bindings: &BTreeMap<String, String>) -> Vec<String> {
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

struct LiveImportCallRewriter<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    bindings: BindingKeySet,
}

impl<'a, 'i> LiveImportCallRewriter<'a, 'i> {
    fn new(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use super::super::ChunkMode;

    fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
        parse_with_source_type(allocator, source, SourceType::mjs())
    }

    fn parse_with_source_type<'a>(
        allocator: &'a Allocator,
        source: &'a str,
        source_type: SourceType,
    ) -> (Program<'a>, ModuleIdentity) {
        let parsed = Parser::new(allocator, source, source_type).parse();
        assert!(
            !parsed.panicked && parsed.diagnostics.is_empty(),
            "{:?}",
            parsed.diagnostics
        );
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(&parsed.program);
        let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
        (parsed.program, identity)
    }

    fn context(workspace_dir: &Path) -> TranspileContext {
        TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            boundary_identity_tokens: HashMap::new(),
            external_specifiers: HashMap::new(),
            opaque_external_specifiers: HashSet::new(),
            file_metadata: HashMap::new(),
            hoist_plan: None,
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: Vec::new(),
            preserved_modules: HashMap::new(),
            resolved_module_ids: HashMap::new(),
            preserved_property_names: HashSet::new(),
            static_property_names: HashSet::new(),
            type_metadata_enabled: false,
            assigner_pin_module_ids: HashSet::new(),
            workspace_dir: workspace_dir.to_path_buf(),
        }
    }

    #[test]
    fn goog_text_preserves_live_binding_contract() {
        let root = std::env::temp_dir().join(format!("gcc-emit-goog-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let dep = root.join("dep.js");
        let entry = root.join("entry.js");
        std::fs::write(
            &dep,
            "export let changing = 1; changing++; export const fixed = 2; export default 3;",
        )
        .unwrap();
        let source = r#"
            import value, { changing as live, fixed } from "./dep.js";
            import * as ns from "./dep.js";
            const object = { live };
            function shadow(live) { return live; }
            export function helper() { return shadow(live); }
            export class Box {}
            export const total = live + fixed + value + ns.fixed;
            export { live as snapshot };
            export { fixed as remote } from "./dep.js";
            export * as everything from "./dep.js";
            export * from "./dep.js";
            export default function named() { return object.live; }
        "#;
        std::fs::write(&entry, source).unwrap();

        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let oxc = emit_goog_module_text(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            None,
        )
        .unwrap();
        assert!(oxc.contains("const live = __goog_import_0.__gccLive_changing;"));
        assert!(oxc.contains("const object = { live: live() };"));
        assert!(oxc.contains("exports.snapshot = live();"));
        assert!(oxc.contains("function shadow(live)"));
        assert!(oxc.contains("return live;"));
        assert!(oxc.contains("exports.helper = helper;"));
        assert!(oxc.contains("exports.Box = Box;"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn object_assign_result_keeps_copied_properties_renameable() {
        let root = std::env::temp_dir().join(format!(
            "gcc-emit-goog-external-object-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        let source = "const assign = Object.assign; const record = {}; const matcher = assign({}, { record }); matcher.record;";
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let metadata = ClosureFileMetadata {
            ambient_globals: Vec::new(),
            annotations: Vec::new(),
            declarations: Vec::new(),
            decorated_output_text: None,
            diagnostics: Vec::new(),
            enums: Vec::new(),
            external_global_member_accesses: vec![source
                .find("Object.assign")
                .map(|start| start + "Object.".len())
                .unwrap()
                .try_into()
                .unwrap()],
            external_owned_member_accesses: Vec::new(),
            file_path: entry.to_string_lossy().into_owned(),
            source_file_path: entry.to_string_lossy().into_owned(),
            symbols: Vec::new(),
        };
        let oxc = emit_goog_module_program(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            Some(&metadata),
            None,
        )
        .unwrap()
        .code;
        assert!(oxc.contains("{ record }"), "{oxc}");
        assert!(oxc.contains("matcher.record"), "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_owned_optional_chain_member_is_quoted() {
        let root = std::env::temp_dir().join(format!(
            "gcc-emit-goog-optional-external-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        let source = "const value = input?.resolvedFileName;";
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let metadata = ClosureFileMetadata {
            ambient_globals: Vec::new(),
            annotations: Vec::new(),
            declarations: Vec::new(),
            decorated_output_text: None,
            diagnostics: Vec::new(),
            enums: Vec::new(),
            external_global_member_accesses: Vec::new(),
            external_owned_member_accesses: vec![source
                .find("resolvedFileName")
                .unwrap()
                .try_into()
                .unwrap()],
            file_path: entry.to_string_lossy().into_owned(),
            source_file_path: entry.to_string_lossy().into_owned(),
            symbols: Vec::new(),
        };
        let oxc = emit_goog_module_program(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            Some(&metadata),
            None,
        )
        .unwrap()
        .code;
        assert!(oxc.contains("input?.[\"resolvedFileName\"]"), "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn boundary_identity_tokens_are_order_independent_and_extend_collisions() {
        let first = allocate_boundary_identity_tokens_with(
            ["zeta".to_string(), "alpha".to_string()],
            |_| "0000000000".to_string(),
        );
        let second = allocate_boundary_identity_tokens_with(
            ["alpha".to_string(), "zeta".to_string()],
            |_| "0000000000".to_string(),
        );
        assert_eq!(first, second);
        assert_eq!(first["alpha"], "0000000000z0");
        assert_eq!(first["zeta"], "0000000000z1");
    }

    #[test]
    fn external_boundary_names_are_workspace_relative() {
        let base = std::env::temp_dir().join(format!(
            "gcc-emit-goog-path-independent-{}",
            std::process::id()
        ));
        let source = r#"import external from "external-package"; export default external;"#;
        let mut outputs = Vec::new();
        for stage in ["stage-1", "stage-2"] {
            let workspace = base.join(stage);
            let entry = workspace.join("src/entry.ts");
            std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
            std::fs::write(&entry, source).unwrap();
            let allocator = Allocator::default();
            let source_type = SourceType::from_path(Path::new("entry.ts"))
                .unwrap()
                .with_module(true);
            let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
            let mut transpile_context = context(&workspace);
            transpile_context.external_specifiers.insert(
                resolved_import_key(&entry, "external-package"),
                "external-package".to_string(),
            );
            outputs.push(
                emit_goog_module_program(
                    &allocator,
                    &entry,
                    &mut program,
                    &identity,
                    &transpile_context,
                    None,
                    None,
                )
                .unwrap()
                .code,
            );
        }
        assert_eq!(outputs[0], outputs[1]);
        assert!(outputs[0].contains("e"));
        assert!(!outputs[0].contains("__gcc_external_"));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn external_owned_spread_clone_assignment_is_quoted() {
        let root = std::env::temp_dir().join(format!(
            "gcc-emit-goog-spread-clone-assignment-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.ts");
        let source = r#"
            import external from "external-package";
            const clone = { ...external };
            clone.value = 1;
        "#;
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let source_type = SourceType::from_path(Path::new("entry.ts"))
            .unwrap()
            .with_module(true);
        let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
        let metadata = ClosureFileMetadata {
            ambient_globals: Vec::new(),
            annotations: Vec::new(),
            declarations: Vec::new(),
            decorated_output_text: None,
            diagnostics: Vec::new(),
            enums: Vec::new(),
            external_global_member_accesses: Vec::new(),
            external_owned_member_accesses: vec![source
                .rfind("value")
                .unwrap()
                .try_into()
                .unwrap()],
            file_path: entry.to_string_lossy().into_owned(),
            source_file_path: entry.to_string_lossy().into_owned(),
            symbols: Vec::new(),
        };
        let mut transpile_context = context(&root);
        transpile_context.external_specifiers.insert(
            resolved_import_key(&entry, "external-package"),
            "external-package".to_string(),
        );
        let oxc = emit_goog_module_program(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &transpile_context,
            Some(&metadata),
            None,
        )
        .unwrap()
        .code;
        assert!(oxc.contains("clone[\"value\"] = 1"), "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_boundary_value_forms_quote_following_members() {
        let root = std::env::temp_dir().join(format!(
            "gcc-emit-goog-external-forms-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.ts");
        let source = r#"
            import * as external from "external-package";
            let assigned;
            const direct = external.value;
            external.value = 1;
            external.value++;
            const element = external["value"];
            const called = external.make().value;
            const chainedCall = external.make?.().value;
            const parenthesized = (external).value;
            const sequenced = (0, external).value;
            const conditional = (true ? external : external).value;
            const logical = (false || external).value;
            const tagged = external.tag`x`.value;
            const assignment = (assigned = external).value;
            const awaited = (await external.make()).value;
            const constructed = (new external.Factory()).value;
            const asExpression = (external as unknown).value;
            const satisfiesExpression = (external satisfies unknown).value;
            const asserted = (<unknown>external).value;
            const nonNull = external!.value;
            const instantiated = external.make<string>().value;
        "#;
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let source_type = SourceType::from_path(Path::new("entry.ts"))
            .unwrap()
            .with_module(true);
        let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
        let mut transpile_context = context(&root);
        transpile_context.external_specifiers.insert(
            resolved_import_key(&entry, "external-package"),
            "external-package".to_string(),
        );
        let oxc = emit_goog_module_program(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &transpile_context,
            None,
            None,
        )
        .unwrap()
        .code;
        assert!(!oxc.contains(".value"), "{oxc}");
        assert!(oxc.matches("[\"value\"]").count() >= 19, "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn anonymous_default_forms_are_exported() {
        let root =
            std::env::temp_dir().join(format!("gcc-emit-goog-default-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        for source in [
            "export default () => 1;",
            "export default function() { return 2; }",
            "export default class { method() { return 3; } }",
        ] {
            std::fs::write(&entry, source).unwrap();
            let allocator = Allocator::default();
            let (mut program, identity) = parse(&allocator, source);
            let oxc = emit_goog_module_text(
                &allocator,
                &entry,
                &mut program,
                &identity,
                &context(&root),
                None,
            )
            .unwrap();
            assert!(oxc.contains("exports.default ="), "source: {source}\n{oxc}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn statement_printing_keeps_only_the_allowed_pure_annotation() {
        let root =
            std::env::temp_dir().join(format!("gcc-emit-goog-comments-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("entry.js");
        let source = r#"
            /** @const HOSTILE */ const value = 1;
            /*#__PURE__*/ make();
            function make() { return value; }
        "#;
        std::fs::write(&entry, source).unwrap();
        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let oxc = emit_goog_module_text(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            None,
        )
        .unwrap();
        assert!(!oxc.contains("HOSTILE"), "{oxc}");
        assert!(oxc.contains("@__PURE__"), "{oxc}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn live_export_facts_cover_aliases_and_invalidations() {
        let source = r#"
            let direct = 0, local = 1, stable = 2;
            export { local as renamed, stable };
            export let exported = 3;
            direct += 1;
            local++;
            exported = 4;
            export { direct as "not-valid-name" };
        "#;
        let allocator = Allocator::default();
        let (program, identity) = parse(&allocator, source);
        let oxc = live_export_bindings_of_program(&program, &identity);
        assert_eq!(
            oxc,
            BTreeMap::from([
                ("exported".to_string(), "exported".to_string()),
                ("renamed".to_string(), "local".to_string()),
            ])
        );
    }
}
