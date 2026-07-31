//! Oxc bundler-runtime emitter and identity-based export readers.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_span::SPAN;
use oxc_str::Ident;
use oxc_syntax::number::NumberBase;

use super::fresh_oxc::FreshNameAllocator;
use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::imports_exports::{
    render_grouped_live_slot_exports_with, BundlerExportSlotMode, ImportBindingSlotAlias,
};
use super::lowering_oxc::closure_input_codegen_options;
use super::type_metadata::{RuntimeTypeName, TypeMetadataDelivery};
use super::type_metadata_oxc::{runtime_type_names_from_program, BoundTypeMetadata};
use super::{
    apply_js_compat_text_fixes, is_valid_js_identifier, render_closure_enum,
    render_live_export_slot_with, render_namespace_export_slots_with,
    render_static_export_slot_with, resolve_module_id_for_specifier, stable_slot_access,
    to_bundler_runtime_module_id, to_goog_module_id, BundlerModuleSlots, TranspileContext,
};
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn collect_local_export_modes(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> HashMap<String, BundlerExportSlotMode> {
    let mut candidates = BindingKeyMap::<(String, BundlerExportSlotMode)>::new();
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(declaration) => {
                for specifier in declaration.specifiers.iter().flatten() {
                    let local = match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => &specifier.local,
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            &specifier.local
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                            &specifier.local
                        }
                    };
                    candidates.insert(
                        identity.key_of_binding(local),
                        (local.name.to_string(), BundlerExportSlotMode::Live),
                    );
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    collect_declaration_candidates(declaration, identity, &mut candidates);
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        candidates.insert(
                            identity.key_of_binding(binding),
                            (binding.name.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        candidates.insert(
                            identity.key_of_binding(binding),
                            (binding.name.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                _ => {}
            },
            Statement::VariableDeclaration(declaration) => {
                collect_variable_candidates(declaration, identity, &mut candidates)
            }
            Statement::FunctionDeclaration(function) => {
                if let Some(binding) = &function.id {
                    candidates.insert(
                        identity.key_of_binding(binding),
                        (binding.name.to_string(), BundlerExportSlotMode::Static),
                    );
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(binding) = &class.id {
                    candidates.insert(
                        identity.key_of_binding(binding),
                        (binding.name.to_string(), BundlerExportSlotMode::Static),
                    );
                }
            }
            _ => {}
        }
    }

    let tracked = candidates.keys().copied().collect();
    let reassigned = collect_reassigned_binding_ids(program, identity, tracked);
    candidates
        .into_iter()
        .map(|(binding, (name, mode))| {
            let mode = if reassigned.contains(&binding) {
                BundlerExportSlotMode::Live
            } else {
                mode
            };
            (name, mode)
        })
        .collect()
}

fn collect_declaration_candidates(
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
    candidates: &mut BindingKeyMap<(String, BundlerExportSlotMode)>,
) {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            collect_variable_candidates(declaration, identity, candidates);
        }
        Declaration::FunctionDeclaration(function) => {
            if let Some(binding) = &function.id {
                candidates.insert(
                    identity.key_of_binding(binding),
                    (binding.name.to_string(), BundlerExportSlotMode::Static),
                );
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(binding) = &class.id {
                candidates.insert(
                    identity.key_of_binding(binding),
                    (binding.name.to_string(), BundlerExportSlotMode::Static),
                );
            }
        }
        _ => {}
    }
}

fn collect_variable_candidates(
    declaration: &VariableDeclaration<'_>,
    identity: &ModuleIdentity,
    candidates: &mut BindingKeyMap<(String, BundlerExportSlotMode)>,
) {
    let mode = if declaration.kind == VariableDeclarationKind::Const {
        BundlerExportSlotMode::Static
    } else {
        BundlerExportSlotMode::Live
    };
    for declarator in &declaration.declarations {
        for (binding, name) in binding_names_with_ids(&declarator.id, identity) {
            candidates.insert(binding, (name, mode));
        }
    }
}

pub(crate) fn binding_names_with_ids(
    pattern: &BindingPattern<'_>,
    identity: &ModuleIdentity,
) -> Vec<(BindingKey, String)> {
    match pattern {
        BindingPattern::BindingIdentifier(binding) => {
            vec![(identity.key_of_binding(binding), binding.name.to_string())]
        }
        BindingPattern::ArrayPattern(array) => {
            let mut bindings = array
                .elements
                .iter()
                .flatten()
                .flat_map(|element| binding_names_with_ids(element, identity))
                .collect::<Vec<_>>();
            if let Some(rest) = &array.rest {
                bindings.extend(binding_names_with_ids(&rest.argument, identity));
            }
            bindings
        }
        BindingPattern::ObjectPattern(object) => {
            let mut bindings = object
                .properties
                .iter()
                .flat_map(|property| binding_names_with_ids(&property.value, identity))
                .collect::<Vec<_>>();
            if let Some(rest) = &object.rest {
                bindings.extend(binding_names_with_ids(&rest.argument, identity));
            }
            bindings
        }
        BindingPattern::AssignmentPattern(assignment) => {
            binding_names_with_ids(&assignment.left, identity)
        }
    }
}

pub(crate) fn collect_reassigned_binding_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    tracked: BindingKeySet,
) -> BindingKeySet {
    let mut collector = ReassignedBindingCollector {
        identity,
        reassigned: HashSet::new(),
        tracked,
    };
    collector.visit_program(program);
    collector.reassigned
}

struct ReassignedBindingCollector<'a> {
    identity: &'a ModuleIdentity,
    reassigned: BindingKeySet,
    tracked: BindingKeySet,
}

impl ReassignedBindingCollector<'_> {
    fn note_reference(&mut self, identifier: &IdentifierReference<'_>) {
        let Some(binding) = self.identity.key_of_reference(identifier) else {
            return;
        };
        if self.tracked.contains(&binding) {
            self.reassigned.insert(binding);
        }
    }

    fn note_expression_target(&mut self, expression: &Expression<'_>) {
        if let Expression::Identifier(identifier) = expression.without_parentheses() {
            self.note_reference(identifier);
        }
    }

    fn note_simple_target(&mut self, target: &SimpleAssignmentTarget<'_>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
                self.note_reference(identifier);
            }
            SimpleAssignmentTarget::TSAsExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSNonNullExpression(expression) => {
                self.note_expression_target(&expression.expression);
            }
            SimpleAssignmentTarget::TSTypeAssertion(expression) => {
                self.note_expression_target(&expression.expression);
            }
            _ => {}
        }
    }

    fn note_target(&mut self, target: &AssignmentTarget<'_>) {
        if let Some(simple) = target.as_simple_assignment_target() {
            self.note_simple_target(simple);
            return;
        }
        match target {
            AssignmentTarget::ArrayAssignmentTarget(array) => {
                for element in array.elements.iter().flatten() {
                    self.note_maybe_default_target(element);
                }
                if let Some(rest) = &array.rest {
                    self.note_target(&rest.target);
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(object) => {
                for property in &object.properties {
                    match property {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                            self.note_reference(&property.binding);
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                            self.note_maybe_default_target(&property.binding);
                        }
                    }
                }
                if let Some(rest) = &object.rest {
                    self.note_target(&rest.target);
                }
            }
            _ => {}
        }
    }

    fn note_maybe_default_target(&mut self, target: &AssignmentTargetMaybeDefault<'_>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
                self.note_target(&default.binding);
            }
            _ => self.note_target(target.to_assignment_target()),
        }
    }
}

impl<'a> Visit<'a> for ReassignedBindingCollector<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, assignment);
        self.note_target(&assignment.left);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, update);
        self.note_simple_target(&update.argument);
    }
}

#[derive(Clone, Debug)]
struct RuntimeBindingNames {
    require: String,
    exports: String,
    dynamic_import: String,
    preload_dynamic_import: String,
    live: String,
}

impl RuntimeBindingNames {
    fn allocate<'a>(
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

#[derive(Clone, Debug)]
struct ImportBindingRewrite {
    binding_id: BindingKey,
    local_name: String,
    replacement_code: String,
    slot_alias: Option<ImportBindingSlotAlias>,
}

struct BundlerImportPlan {
    lines: Vec<String>,
    binding_rewrites: Vec<ImportBindingRewrite>,
}

#[derive(Debug)]
pub(crate) struct RuntimeEmit {
    pub(crate) code: String,
    pub(crate) type_metadata: TypeMetadataDelivery,
}

pub(crate) fn emit_bundler_runtime_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<RuntimeEmit, String> {
    let bound = BoundTypeMetadata::bind(
        program,
        identity,
        file_metadata,
        context.type_metadata_enabled,
    );
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;

    super::namespace::flow_oxc::rewrite_bundler_runtime_namespace_usage(
        allocator, program, identity, file_path, context,
    )?;
    let (runtime_names, mut fresh_names) =
        RuntimeBindingNames::allocate(allocator, program, identity);
    let mut output = Vec::new();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    let import_plans = program
        .body
        .iter()
        .filter_map(|statement| {
            let Statement::ImportDeclaration(import) = statement else {
                return None;
            };
            Some(convert_bundler_import_decl(
                file_path,
                import,
                identity,
                context,
                &mut import_counter,
                &mut fresh_names,
                &runtime_names.require,
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let import_binding_rewrites = import_plans
        .iter()
        .flat_map(|plan| {
            plan.binding_rewrites
                .iter()
                .map(|rewrite| (rewrite.local_name.clone(), rewrite.replacement_code.clone()))
        })
        .collect::<HashMap<_, _>>();
    let import_binding_slot_aliases = import_plans
        .iter()
        .flat_map(|plan| {
            plan.binding_rewrites.iter().filter_map(|rewrite| {
                rewrite
                    .slot_alias
                    .clone()
                    .map(|alias| (rewrite.local_name.clone(), alias))
            })
        })
        .collect::<HashMap<_, _>>();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|plan| plan.binding_rewrites.iter().cloned())
        .collect::<Vec<_>>();
    let mut runtime_type_names = runtime_type_names_from_program(program, identity, &bound);
    for rewrite in &all_rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id,
            if rewrite.slot_alias.is_some() {
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
            } else if is_valid_js_identifier(&rewrite.replacement_code) {
                RuntimeTypeName::Name(rewrite.replacement_code.clone())
            } else {
                RuntimeTypeName::Unresolved("runtime-binding-not-found")
            },
        );
    }
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    let local_export_modes = collect_local_export_modes(program, identity);
    let mut import_plans = import_plans.into_iter();
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);

    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
        if declaration.exported {
            let slot = current_slots
                .slot_for(&declaration.binding_name)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        declaration.binding_name, module_id
                    )
                })?;
            output.push(render_static_export_slot_with(
                &runtime_names.exports,
                slot,
                &emitted_name,
            ));
        }
    }

    let body = std::mem::replace(&mut program.body, oxc_allocator::Vec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {
                let plan = import_plans
                    .next()
                    .ok_or_else(|| "Missing bundler-runtime import plan".to_string())?;
                output.extend(plan.lines);
            }
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    let exported_names = exported_decl_names(&declaration, identity);
                    let slot_mode =
                        slot_mode_for_export_decl(&declaration, identity, &local_export_modes);
                    output.push(type_metadata.render_statement(
                        identity,
                        declaration.into(),
                        &[],
                    )?);
                    for export_name in exported_names {
                        let slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                            format!(
                                "Missing bundler-runtime export slot for {} in {}",
                                export_name, module_id
                            )
                        })?;
                        output.push(render_slot_export(
                            &runtime_names,
                            slot_mode,
                            slot,
                            &export_name,
                        ));
                    }
                } else {
                    output.extend(convert_bundler_named_export(
                        file_path,
                        &export,
                        context,
                        current_slots,
                        &import_binding_rewrites,
                        &import_binding_slot_aliases,
                        &local_export_modes,
                        &mut export_counter,
                        &mut fresh_names,
                        &runtime_names.require,
                        &runtime_names.exports,
                        &runtime_names.live,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        fresh_names.fresh(&format!("__gcc_default_export_{export_counter}"))
                    });
                export_counter += 1;
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        if function.id.is_some() {
                            output.push(type_metadata.render_statement(
                                identity,
                                Statement::FunctionDeclaration(function),
                                &[],
                            )?);
                        } else {
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::FunctionDeclaration(
                                    function
                                ))
                                .trim()
                                .trim_end_matches(';')
                            ));
                        }
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        if class.id.is_some() {
                            output.push(type_metadata.render_statement(
                                identity,
                                Statement::ClassDeclaration(class),
                                &[],
                            )?);
                        } else {
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::ClassDeclaration(class))
                                    .trim()
                                    .trim_end_matches(';')
                            ));
                        }
                    }
                    expression => output.push(format!(
                        "const {local_name} = {};",
                        print_node(&expression).trim().trim_end_matches(';')
                    )),
                }
                let slot = current_slots.slot_for("default").ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for default in {}",
                        module_id
                    )
                })?;
                output.push(render_static_export_slot_with(
                    &runtime_names.exports,
                    slot,
                    &local_name,
                ));
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if export.exported.is_some() {
                    return Err(format!(
                        "bundler-runtime does not support namespace re-exports in {}",
                        file_path.display()
                    ));
                }
                let require_name = fresh_names.fresh(&format!("__gcc_export_all_{export_counter}"));
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    export.source.value.as_str(),
                    context,
                )?;
                let runtime_export_module_id = to_bundler_runtime_module_id(&export_module_id);
                output.push(format!(
                    "const {require_name} = {}({runtime_export_module_id:?});",
                    runtime_names.require
                ));
                let target_slots = context
                    .bundler_module_slots
                    .get(&export_module_id)
                    .ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slots for re-exported module {}",
                            export_module_id
                        )
                    })?;
                let mut slot_pairs = Vec::new();
                for export_name in target_slots.export_names() {
                    if export_name == "default" {
                        continue;
                    }
                    let source_slot = target_slots.slot_for(export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, export_module_id
                        )
                    })?;
                    let target_slot = current_slots.slot_for(export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, module_id
                        )
                    })?;
                    slot_pairs.push((target_slot, source_slot));
                }
                output.extend(render_grouped_live_slot_exports_with(
                    &require_name,
                    slot_pairs,
                    &runtime_names.live,
                    &runtime_names.exports,
                ));
            }
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(type_metadata.render_statement(identity, statement, &[])?),
        }
    }

    if let Some(export_name) = commonjs_export_name {
        let export_slot = current_slots.slot_for(export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                export_name, module_id
            )
        })?;
        output.push(render_live_export_slot_with(
            &runtime_names.live,
            &runtime_names.exports,
            export_slot,
            export_name,
        ));
        output.push(format!(
            "{}({}, {:?}, function(){{return {};}});",
            runtime_names.live, runtime_names.exports, export_name, export_name
        ));
        let default_slot = current_slots.slot_for("default").ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for default in {}",
                module_id
            )
        })?;
        output.push(render_live_export_slot_with(
            &runtime_names.live,
            &runtime_names.exports,
            default_slot,
            export_name,
        ));
    }

    if context.lazy_target_module_ids.contains(&module_id) {
        let namespace_slots = current_slots
            .export_names()
            .filter(|export_name| export_name.as_str() != "__cjsExports")
            .filter_map(|export_name| {
                current_slots
                    .slot_for(export_name)
                    .map(|slot| (export_name.clone(), slot))
            })
            .collect::<Vec<_>>();
        if !namespace_slots.is_empty() {
            output.push(render_namespace_export_slots_with(
                &runtime_names.exports,
                &namespace_slots,
            ));
        }
        if current_slots.slot_for("default") == Some(0) {
            output.push(format!("{}.__esModule = true;", runtime_names.exports));
        }
    }

    let body = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let source = format!(
        "__register({runtime_module_id:?}, function({}, {}, {}, {}, {}) {{\n{}\n}});",
        runtime_names.require,
        runtime_names.exports,
        runtime_names.dynamic_import,
        runtime_names.preload_dynamic_import,
        runtime_names.live,
        indent_block(&body),
    );
    Ok(RuntimeEmit {
        code: apply_js_compat_text_fixes(source),
        type_metadata: type_metadata.finish(),
    })
}

fn convert_bundler_import_decl(
    file_path: &Path,
    import: &ImportDeclaration<'_>,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    import_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    require_name: &str,
) -> std::result::Result<BundlerImportPlan, String> {
    let module_id =
        resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)?;
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let Some(specifiers) = &import.specifiers else {
        return Ok(BundlerImportPlan {
            lines: vec![format!("{require_name}({runtime_module_id:?});")],
            binding_rewrites: Vec::new(),
        });
    };
    if specifiers.is_empty() {
        return Ok(BundlerImportPlan {
            lines: vec![format!("{require_name}({runtime_module_id:?});")],
            binding_rewrites: Vec::new(),
        });
    }
    let value_specifiers = specifiers
        .iter()
        .filter(|specifier| {
            import.import_kind != ImportOrExportKind::Type
                && !matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named)
                    if named.import_kind == ImportOrExportKind::Type)
        })
        .collect::<Vec<_>>();
    if value_specifiers.is_empty() {
        return Ok(BundlerImportPlan {
            lines: Vec::new(),
            binding_rewrites: Vec::new(),
        });
    }

    let local_name = fresh_names.fresh(&format!("__gcc_import_{}", *import_counter));
    *import_counter += 1;
    let mut lines = vec![format!(
        "const {local_name} = {require_name}({runtime_module_id:?});"
    )];
    let target_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    let mut binding_rewrites = Vec::new();
    for specifier in value_specifiers {
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                binding_rewrites.push(import_rewrite(
                    &local_name,
                    "default",
                    &default.local,
                    identity,
                    target_slots,
                )?);
            }
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                binding_rewrites.push(import_rewrite(
                    &local_name,
                    &module_export_name(&named.imported),
                    &named.local,
                    identity,
                    target_slots,
                )?);
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                lines.push(format!("const {} = {local_name};", namespace.local.name));
            }
        }
    }
    Ok(BundlerImportPlan {
        lines,
        binding_rewrites,
    })
}

fn import_rewrite(
    source_object_name: &str,
    imported_name: &str,
    local: &BindingIdentifier<'_>,
    identity: &ModuleIdentity,
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<ImportBindingRewrite, String> {
    let slot = target_slots.slot_for(imported_name).ok_or_else(|| {
        format!("Missing bundler-runtime export slot for imported name {imported_name}")
    })?;
    Ok(ImportBindingRewrite {
        binding_id: identity.key_of_binding(local),
        local_name: local.name.to_string(),
        replacement_code: stable_slot_access(source_object_name, slot),
        slot_alias: Some(ImportBindingSlotAlias {
            source_object_name: source_object_name.to_string(),
            source_slot: slot,
        }),
    })
}

fn apply_import_binding_rewrites<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &ModuleIdentity,
    rewrites: &[ImportBindingRewrite],
) {
    if rewrites.is_empty() {
        return;
    }
    ImportBindingRewriteVisitor {
        allocator,
        builder: AstBuilder::new(allocator),
        identity,
        rewrites: rewrites
            .iter()
            .map(|rewrite| (rewrite.binding_id, rewrite.slot_alias.clone().unwrap()))
            .collect(),
    }
    .visit_program(program);
}

struct ImportBindingRewriteVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    rewrites: BindingKeyMap<ImportBindingSlotAlias>,
}

impl<'a> ImportBindingRewriteVisitor<'a, '_> {
    fn replacement(&self, alias: &ImportBindingSlotAlias) -> Expression<'a> {
        let object = Expression::new_identifier(
            SPAN,
            Ident::from_in(&alias.source_object_name, self.allocator),
            &self.builder,
        );
        let slot = Expression::new_numeric_literal(
            SPAN,
            alias.source_slot as f64,
            None,
            NumberBase::Decimal,
            &self.builder,
        );
        Expression::new_computed_member_expression(SPAN, object, slot, false, &self.builder)
    }
}

impl<'a> VisitMut<'a> for ImportBindingRewriteVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::Identifier(identifier) = expression {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                if let Some(alias) = self.rewrites.get(&binding) {
                    *expression = self.replacement(alias);
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(identifier) = &property.value {
                if let Some(binding) = self.identity.key_of_reference(identifier) {
                    if let Some(alias) = self.rewrites.get(&binding) {
                        property.shorthand = false;
                        property.value = self.replacement(alias);
                        return;
                    }
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }
}

#[allow(clippy::too_many_arguments)]
fn convert_bundler_named_export(
    file_path: &Path,
    export: &ExportNamedDeclaration<'_>,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    import_binding_rewrites: &HashMap<String, String>,
    import_binding_slot_aliases: &HashMap<String, ImportBindingSlotAlias>,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
    require_name: &str,
    exports_name: &str,
    live_name: &str,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(source) = &export.source {
        let local_name = fresh_names.fresh(&format!("__gcc_export_{}", *export_counter));
        *export_counter += 1;
        let module_id = resolve_module_id_for_specifier(file_path, source.value.as_str(), context)?;
        let runtime_module_id = to_bundler_runtime_module_id(&module_id);
        lines.push(format!(
            "const {local_name} = {require_name}({runtime_module_id:?});"
        ));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        let mut slot_pairs = Vec::new();
        for specifier in &export.specifiers {
            if specifier.export_kind == ImportOrExportKind::Type {
                continue;
            }
            let source_name = module_export_name(&specifier.local);
            let export_name = module_export_name(&specifier.exported);
            let source_slot = target_slots.slot_for(&source_name).ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {} in {}",
                    source_name, module_id
                )
            })?;
            let target_slot = current_slots
                .slot_for(&export_name)
                .ok_or_else(|| format!("Missing bundler-runtime export slot for {export_name}"))?;
            slot_pairs.push((target_slot, source_slot));
        }
        lines.extend(render_grouped_live_slot_exports_with(
            &local_name,
            slot_pairs,
            live_name,
            exports_name,
        ));
        return Ok(lines);
    }

    let mut grouped_alias_exports = BTreeMap::<String, Vec<(usize, usize)>>::new();
    for specifier in &export.specifiers {
        if specifier.export_kind == ImportOrExportKind::Type {
            continue;
        }
        let local_name = module_export_name(&specifier.local);
        let export_name = module_export_name(&specifier.exported);
        let target_slot = current_slots
            .slot_for(&export_name)
            .ok_or_else(|| format!("Missing bundler-runtime export slot for {export_name}"))?;
        let slot_mode = local_export_modes
            .get(&local_name)
            .copied()
            .unwrap_or(BundlerExportSlotMode::Live);
        if slot_mode == BundlerExportSlotMode::Live {
            if let Some(alias) = import_binding_slot_aliases.get(&local_name) {
                grouped_alias_exports
                    .entry(alias.source_object_name.clone())
                    .or_default()
                    .push((target_slot, alias.source_slot));
                continue;
            }
        }
        let value = import_binding_rewrites
            .get(&local_name)
            .map(String::as_str)
            .unwrap_or(local_name.as_str());
        lines.push(match slot_mode {
            BundlerExportSlotMode::Static => {
                render_static_export_slot_with(exports_name, target_slot, value)
            }
            BundlerExportSlotMode::Live => {
                render_live_export_slot_with(live_name, exports_name, target_slot, value)
            }
        });
    }
    for (source_object_name, slot_pairs) in grouped_alias_exports {
        lines.extend(render_grouped_live_slot_exports_with(
            &source_object_name,
            slot_pairs,
            live_name,
            exports_name,
        ));
    }
    Ok(lines)
}

fn render_slot_export(
    names: &RuntimeBindingNames,
    mode: BundlerExportSlotMode,
    slot: usize,
    value: &str,
) -> String {
    match mode {
        BundlerExportSlotMode::Static => {
            render_static_export_slot_with(&names.exports, slot, value)
        }
        BundlerExportSlotMode::Live => {
            render_live_export_slot_with(&names.live, &names.exports, slot, value)
        }
    }
}

fn slot_mode_for_export_decl(
    declaration: &Declaration<'_>,
    identity: &ModuleIdentity,
    modes: &HashMap<String, BundlerExportSlotMode>,
) -> BundlerExportSlotMode {
    match declaration {
        Declaration::FunctionDeclaration(_) | Declaration::ClassDeclaration(_) => {
            BundlerExportSlotMode::Static
        }
        Declaration::VariableDeclaration(declaration)
            if declaration.kind == VariableDeclarationKind::Const =>
        {
            if declaration
                .declarations
                .iter()
                .flat_map(|declarator| binding_names_with_ids(&declarator.id, identity))
                .all(|(_, name)| modes.get(&name) == Some(&BundlerExportSlotMode::Static))
            {
                BundlerExportSlotMode::Static
            } else {
                BundlerExportSlotMode::Live
            }
        }
        _ => BundlerExportSlotMode::Live,
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
        Declaration::FunctionDeclaration(function) => function
            .id
            .iter()
            .map(|binding| binding.name.to_string())
            .collect(),
        Declaration::ClassDeclaration(class) => class
            .id
            .iter()
            .map(|binding| binding.name.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn default_declaration_name<'a>(
    declaration: &'a ExportDefaultDeclarationKind<'_>,
) -> Option<&'a str> {
    match declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            function.id.as_ref().map(|binding| binding.name.as_str())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            class.id.as_ref().map(|binding| binding.name.as_str())
        }
        _ => None,
    }
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn print_node(node: &impl Gen) -> String {
    let mut codegen = Codegen::new().with_options(closure_input_codegen_options());
    node.print(&mut codegen, oxc_codegen::Context::default());
    codegen.into_source_text()
}

fn indent_block(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}
