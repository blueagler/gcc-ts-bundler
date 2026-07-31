//! Oxc hoisted bundler-runtime emitter.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_codegen::{Codegen, Gen};
use oxc_span::SPAN;
use oxc_str::Ident;
use oxc_syntax::number::NumberBase;

use super::assigners::NOINLINE_TAG;
use super::assigners_oxc::assigner_function_name;
use super::emit::EmittedProgram;
use super::emit_helpers::canonical_shared_helper_name;
use super::emit_helpers_oxc::{helper_initializer_source, take_shared_helper_declarations};
use super::emit_runtime_oxc::{binding_names_with_ids, collect_local_export_modes};
use super::fresh_oxc::{collect_lexical_binding_names, FreshNameAllocator};
use super::hoist::{suffixed_name, FacadeSlots, HoistPlan};
use super::hoist_oxc::{collect_used_binding_ids, scan_namespace_usage};
use super::identity_oxc::{BindingKey, BindingKeyMap, BindingKeySet, ModuleIdentity};
use super::imports_exports::{
    render_live_export_slot, render_namespace_export_slots_with, render_static_export_slot,
    BundlerExportSlotMode, ImportBindingSlotAlias,
};
use super::lowering_oxc::closure_input_codegen_options;
use super::pure_calls::collect_pure_annotated_binding_names;
use super::type_metadata::{RuntimeTypeName, PURE_TAG};
use super::type_metadata_oxc::{
    runtime_type_names_from_program, BoundTypeMetadata, PreparedTypeMetadata,
};
use super::{
    apply_js_compat_text_fixes, is_valid_js_identifier, render_closure_enum,
    resolve_module_id_for_specifier, to_bundler_runtime_module_id, to_goog_module_id,
    TranspileContext,
};
use crate::closure_metadata::ClosureFileMetadata;

pub(crate) fn emit_hoisted_module_text<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    identity: &mut ModuleIdentity,
    context: &TranspileContext,
    plan: &HoistPlan,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let bound = BoundTypeMetadata::bind(
        program,
        identity,
        file_metadata,
        context.type_metadata_enabled,
    );
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let ordinal = plan
        .ordinal_of(&module_id)
        .ok_or_else(|| format!("Missing hoist ordinal for {module_id}"))?;
    let pure_names = std::fs::read_to_string(file_path)
        .map(|source| collect_pure_annotated_binding_names(&source))
        .unwrap_or_default();
    let local_export_modes = collect_local_export_modes(program, identity);

    let TopLevelRenames {
        renames,
        shared_helper_names,
    } = collect_top_level_renames(program, identity, ordinal);
    let module_bindings = if context.vendor_module_ids.contains(&module_id) {
        renames.values().cloned().collect()
    } else {
        HashSet::new()
    };
    apply_top_level_renames(allocator, program, identity, &renames);
    let shared_helpers = take_shared_helper_declarations(allocator, program, &shared_helper_names);
    let lexical_binding_names = collect_lexical_binding_names(program);
    let fresh_names = FreshNameAllocator::from_program(program, identity);

    let direct_namespace_ids =
        collect_direct_safe_namespace_ids(program, identity, file_path, context, plan);
    super::namespace::flow_oxc::rewrite_hoisted_namespace_usage(
        allocator,
        program,
        identity,
        file_path,
        context,
        plan,
        &module_id,
        &direct_namespace_ids,
        &lexical_binding_names,
    )?;

    let used_binding_ids = collect_used_binding_ids(program, identity);
    let mut import_planner = HoistedImportPlanner::new(
        context,
        plan,
        identity,
        &module_id,
        ordinal,
        &lexical_binding_names,
        fresh_names,
    );
    let import_plans = program
        .body
        .iter()
        .filter_map(|statement| {
            let Statement::ImportDeclaration(import) = statement else {
                return None;
            };
            Some(import_planner.plan_import(
                file_path,
                import,
                &direct_namespace_ids,
                &used_binding_ids,
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut fresh_names = import_planner.into_fresh_names();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|plan| plan.rewrites.iter().cloned())
        .collect::<Vec<_>>();
    let mut runtime_type_names = runtime_type_names_from_program(program, identity, &bound);
    for rewrite in &all_rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id,
            if rewrite.slot_alias().is_some() {
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
            } else if is_valid_js_identifier(&rewrite.replacement_code) {
                RuntimeTypeName::Name(rewrite.replacement_code.clone())
            } else {
                RuntimeTypeName::Unresolved("runtime-binding-not-found")
            },
        );
    }
    apply_import_binding_rewrites(allocator, program, identity, &all_rewrites);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, Some(ordinal));

    let mut output = type_metadata.take_declaration_lines();
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for declaration in enum_declarations {
        let emitted_name = type_metadata.enum_name(&declaration);
        output.push(render_closure_enum(&declaration, &emitted_name));
        type_metadata.count_enum();
    }

    let mut import_plans = import_plans.into_iter();
    let body = std::mem::replace(&mut program.body, ArenaVec::new_in(&allocator));
    for statement in body {
        match statement {
            Statement::ImportDeclaration(_) => {
                let plan = import_plans
                    .next()
                    .ok_or_else(|| "Missing hoisted import plan".to_string())?;
                output.extend(plan.lines);
            }
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    output.push(render_hoisted_statement(
                        &mut type_metadata,
                        identity,
                        declaration.into(),
                        &pure_names,
                        &module_bindings,
                        context,
                        ordinal,
                    )?);
                } else if let Some(source) = export.source {
                    output.extend(render_execution_require(
                        file_path,
                        source.value.as_str(),
                        context,
                        plan,
                    )?);
                }
            }
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind != ImportOrExportKind::Type {
                    output.extend(render_execution_require(
                        file_path,
                        export.source.value.as_str(),
                        context,
                        plan,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        if function.id.is_some() {
                            output.push(render_hoisted_statement(
                                &mut type_metadata,
                                identity,
                                Statement::FunctionDeclaration(function),
                                &pure_names,
                                &module_bindings,
                                context,
                                ordinal,
                            )?);
                        } else {
                            let local_name =
                                fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
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
                            output.push(render_hoisted_statement(
                                &mut type_metadata,
                                identity,
                                Statement::ClassDeclaration(class),
                                &pure_names,
                                &module_bindings,
                                context,
                                ordinal,
                            )?);
                        } else {
                            let local_name =
                                fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                            output.push(format!(
                                "const {local_name} = {};",
                                print_node(&ExportDefaultDeclarationKind::ClassDeclaration(class))
                                    .trim()
                                    .trim_end_matches(';')
                            ));
                        }
                    }
                    declaration if declaration.is_typescript_syntax() => {}
                    expression => {
                        let local_name = fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                        output.push(format!(
                            "const {local_name} = {};",
                            print_node(&expression).trim().trim_end_matches(';')
                        ));
                    }
                }
            }
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(render_hoisted_statement(
                &mut type_metadata,
                identity,
                statement,
                &pure_names,
                &module_bindings,
                context,
                ordinal,
            )?),
        }
    }

    if let Some(facade_slots) = plan.facade_slots_for(&module_id) {
        output.extend(render_facade(
            &module_id,
            ordinal,
            context,
            plan,
            facade_slots,
            &local_export_modes,
            commonjs_export_name,
        )?);
    }

    let body = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(body),
        reflective_property_names: Default::default(),
        shared_helpers,
        type_metadata: type_metadata.finish(),
    })
}

fn render_hoisted_statement(
    type_metadata: &mut PreparedTypeMetadata,
    identity: &ModuleIdentity,
    statement: Statement<'_>,
    pure_names: &HashSet<String>,
    module_bindings: &HashSet<String>,
    context: &TranspileContext,
    ordinal: usize,
) -> std::result::Result<String, String> {
    let mut tags = Vec::new();
    if is_pure_statement(&statement, pure_names, &context.pure_callees, |name| {
        name.strip_suffix(&format!("$${ordinal}"))
            .map(str::to_string)
    }) {
        tags.push(PURE_TAG);
    }
    if assigner_function_name(&statement, module_bindings).is_some() {
        tags.push(NOINLINE_TAG);
    }
    type_metadata.render_statement(identity, statement, &tags)
}

fn render_execution_require(
    file_path: &Path,
    specifier: &str,
    context: &TranspileContext,
    plan: &HoistPlan,
) -> std::result::Result<Vec<String>, String> {
    let target_module_id = resolve_module_id_for_specifier(file_path, specifier, context)?;
    if plan.is_hoisted(&target_module_id) {
        return Ok(Vec::new());
    }
    let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
    Ok(vec![format!("__require({runtime_module_id:?});")])
}

#[allow(clippy::too_many_arguments)]
fn render_facade(
    module_id: &str,
    ordinal: usize,
    context: &TranspileContext,
    plan: &HoistPlan,
    facade_slots: &FacadeSlots,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<Vec<String>, String> {
    let slots = context
        .bundler_module_slots
        .get(module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    let mut lines = Vec::new();
    for export_name in slots.export_names() {
        if let FacadeSlots::Named(needed) = facade_slots {
            if !needed.contains(export_name) {
                continue;
            }
        }
        let slot = slots.slot_for(export_name).ok_or_else(|| {
            format!("Missing bundler-runtime export slot for {export_name} in {module_id}")
        })?;
        let binding = plan.resolve_export(module_id, export_name).ok_or_else(|| {
            format!("Missing hoisted export binding for {export_name} in {module_id}")
        })?;
        if binding.owner_module_id == module_id {
            let value = suffixed_name(&binding.owner_local_name, ordinal);
            let mode = local_export_modes
                .get(&binding.owner_local_name)
                .copied()
                .unwrap_or(BundlerExportSlotMode::Live);
            lines.push(match mode {
                BundlerExportSlotMode::Static => render_static_export_slot(slot, &value),
                BundlerExportSlotMode::Live => render_live_export_slot(slot, &value),
            });
            continue;
        }
        if plan.is_direct_binding(module_id, binding) {
            let value = plan
                .direct_binding_name(binding)
                .ok_or_else(|| format!("Missing hoist ordinal for {}", binding.owner_module_id))?;
            lines.push(match plan.direct_binding_slot_mode(module_id, binding) {
                BundlerExportSlotMode::Static => render_static_export_slot(slot, &value),
                BundlerExportSlotMode::Live => render_live_export_slot(slot, &value),
            });
            continue;
        }
        let owner_slots = context
            .bundler_module_slots
            .get(&binding.owner_module_id)
            .ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slots for {}",
                    binding.owner_module_id
                )
            })?;
        let owner_slot = owner_slots
            .slot_for(&binding.owner_export_name)
            .ok_or_else(|| {
                format!(
                    "Missing bundler-runtime export slot for {} in {}",
                    binding.owner_export_name, binding.owner_module_id
                )
            })?;
        let owner_runtime_id = to_bundler_runtime_module_id(&binding.owner_module_id);
        lines.push(render_live_export_slot(
            slot,
            &format!("__require({owner_runtime_id:?})[{owner_slot}]"),
        ));
    }
    let is_exposed = |export_name: &str| match facade_slots {
        FacadeSlots::All => true,
        FacadeSlots::Named(needed) => needed.contains(export_name),
    };
    if let Some(export_name) = commonjs_export_name {
        if is_exposed(export_name) {
            let slot = slots.slot_for(export_name).ok_or_else(|| {
                format!("Missing bundler-runtime export slot for {export_name} in {module_id}")
            })?;
            lines.push(format!(
                "__live(__exports,{export_name:?},function(){{return __exports[{slot}];}});"
            ));
        }
    }

    if context.lazy_target_module_ids.contains(module_id) {
        let namespace_slots = slots
            .export_names()
            .filter(|export_name| export_name.as_str() != "__cjsExports" && is_exposed(export_name))
            .filter_map(|export_name| {
                slots
                    .slot_for(export_name)
                    .map(|slot| (export_name.clone(), slot))
            })
            .collect::<Vec<_>>();
        if !namespace_slots.is_empty() {
            lines.push(render_namespace_export_slots_with(
                "__exports",
                &namespace_slots,
            ));
        }
        if slots.slot_for("default") == Some(0) {
            lines.push("__exports.__esModule = true;".to_string());
        }
    }
    let runtime_module_id = to_bundler_runtime_module_id(module_id);
    Ok(vec![format!(
        "__register({runtime_module_id:?}, function(__require, __exports, __dynamicImport, __preloadDynamicImport, __live) {{\n{}\n}});",
        lines
            .into_iter()
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    )])
}

#[derive(Clone, Debug)]
enum ImportReplacement {
    Name(String),
    Slot(ImportBindingSlotAlias),
}

#[derive(Clone, Debug)]
struct ImportBindingRewrite {
    binding_id: BindingKey,
    replacement: ImportReplacement,
    replacement_code: String,
}

impl ImportBindingRewrite {
    fn slot_alias(&self) -> Option<&ImportBindingSlotAlias> {
        match &self.replacement {
            ImportReplacement::Name(_) => None,
            ImportReplacement::Slot(alias) => Some(alias),
        }
    }
}

struct HoistedImportPlan {
    lines: Vec<String>,
    rewrites: Vec<ImportBindingRewrite>,
}

struct HoistedImportPlanner<'a> {
    consumer_module_id: &'a str,
    consumer_ordinal: usize,
    context: &'a TranspileContext,
    fresh_names: FreshNameAllocator,
    identity: &'a ModuleIdentity,
    lexical_binding_names: &'a HashSet<String>,
    plan: &'a HoistPlan,
    require_bindings: HashMap<String, String>,
}

impl<'a> HoistedImportPlanner<'a> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        context: &'a TranspileContext,
        plan: &'a HoistPlan,
        identity: &'a ModuleIdentity,
        consumer_module_id: &'a str,
        consumer_ordinal: usize,
        lexical_binding_names: &'a HashSet<String>,
        fresh_names: FreshNameAllocator,
    ) -> Self {
        Self {
            consumer_module_id,
            consumer_ordinal,
            context,
            fresh_names,
            identity,
            lexical_binding_names,
            plan,
            require_bindings: HashMap::new(),
        }
    }

    fn into_fresh_names(self) -> FreshNameAllocator {
        self.fresh_names
    }

    fn require_binding(&mut self, target_module_id: &str, lines: &mut Vec<String>) -> String {
        if let Some(existing) = self.require_bindings.get(target_module_id) {
            return existing.clone();
        }
        let preferred = format!(
            "__gcc_req_{}_{}",
            self.consumer_ordinal,
            self.require_bindings.len()
        );
        let name = self.fresh_names.fresh(&preferred);
        let runtime_module_id = to_bundler_runtime_module_id(target_module_id);
        lines.push(format!("const {name} = __require({runtime_module_id:?});"));
        self.require_bindings
            .insert(target_module_id.to_string(), name.clone());
        name
    }

    fn plan_import(
        &mut self,
        file_path: &Path,
        import: &ImportDeclaration<'_>,
        direct_namespace_ids: &BindingKeySet,
        used_binding_ids: &BindingKeySet,
    ) -> std::result::Result<HoistedImportPlan, String> {
        let target_module_id =
            resolve_module_id_for_specifier(file_path, import.source.value.as_str(), self.context)?;
        let mut lines = Vec::new();
        let mut rewrites = Vec::new();

        if import.import_kind != ImportOrExportKind::Type
            && !self.plan.is_hoisted(&target_module_id)
        {
            let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
            lines.push(format!("__require({runtime_module_id:?});"));
        }
        let Some(specifiers) = &import.specifiers else {
            return Ok(HoistedImportPlan { lines, rewrites });
        };
        for specifier in specifiers {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if import.import_kind == ImportOrExportKind::Type
                        || named.import_kind == ImportOrExportKind::Type => {}
                ImportDeclarationSpecifier::ImportSpecifier(named)
                    if !used_binding_ids.contains(&self.identity.key_of_binding(&named.local)) => {}
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default)
                    if import.import_kind == ImportOrExportKind::Type
                        || !used_binding_ids
                            .contains(&self.identity.key_of_binding(&default.local)) => {}
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace)
                    if import.import_kind == ImportOrExportKind::Type
                        || !used_binding_ids
                            .contains(&self.identity.key_of_binding(&namespace.local)) => {}
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    let imported_name = module_export_name(&named.imported);
                    self.plan_named_binding(
                        &target_module_id,
                        &imported_name,
                        &named.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    self.plan_named_binding(
                        &target_module_id,
                        "default",
                        &default.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    if direct_namespace_ids
                        .contains(&self.identity.key_of_binding(&namespace.local))
                    {
                        continue;
                    }
                    let object_name = self.require_binding(&target_module_id, &mut lines);
                    rewrites.push(ImportBindingRewrite {
                        binding_id: self.identity.key_of_binding(&namespace.local),
                        replacement: ImportReplacement::Name(object_name.clone()),
                        replacement_code: object_name,
                    });
                }
            }
        }
        Ok(HoistedImportPlan { lines, rewrites })
    }

    fn plan_named_binding(
        &mut self,
        target_module_id: &str,
        imported_name: &str,
        local: &BindingIdentifier<'_>,
        lines: &mut Vec<String>,
        rewrites: &mut Vec<ImportBindingRewrite>,
    ) -> std::result::Result<(), String> {
        let binding_id = self.identity.key_of_binding(local);
        if let Some(binding) = self.plan.resolve_export(target_module_id, imported_name) {
            let direct_name = self.plan.direct_binding_name(binding);
            if self
                .plan
                .is_direct_binding(self.consumer_module_id, binding)
                && direct_name
                    .as_ref()
                    .is_some_and(|name| !self.lexical_binding_names.contains(name))
            {
                let direct_name = direct_name.ok_or_else(|| {
                    format!("Missing hoist ordinal for {}", binding.owner_module_id)
                })?;
                rewrites.push(ImportBindingRewrite {
                    binding_id,
                    replacement: ImportReplacement::Name(direct_name.clone()),
                    replacement_code: direct_name,
                });
                return Ok(());
            }
            let binding = binding.clone();
            let owner_slots = self
                .context
                .bundler_module_slots
                .get(&binding.owner_module_id)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slots for {}",
                        binding.owner_module_id
                    )
                })?;
            let owner_slot = owner_slots
                .slot_for(&binding.owner_export_name)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        binding.owner_export_name, binding.owner_module_id
                    )
                })?;
            let object_name = self.require_binding(&binding.owner_module_id, lines);
            rewrites.push(slot_rewrite(binding_id, &object_name, owner_slot));
            return Ok(());
        }

        let target_slots = self
            .context
            .bundler_module_slots
            .get(target_module_id)
            .ok_or_else(|| {
                format!("Missing bundler-runtime export slots for {target_module_id}")
            })?;
        let slot = target_slots.slot_for(imported_name).ok_or_else(|| {
            format!("Missing bundler-runtime export slot for imported name {imported_name}")
        })?;
        let object_name = self.require_binding(target_module_id, lines);
        rewrites.push(slot_rewrite(binding_id, &object_name, slot));
        Ok(())
    }
}

fn slot_rewrite(binding_id: BindingKey, object_name: &str, slot: usize) -> ImportBindingRewrite {
    let alias = ImportBindingSlotAlias {
        source_object_name: object_name.to_string(),
        source_slot: slot,
    };
    ImportBindingRewrite {
        binding_id,
        replacement: ImportReplacement::Slot(alias),
        replacement_code: format!("{object_name}[{slot}]"),
    }
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
            .map(|rewrite| (rewrite.binding_id, rewrite.replacement.clone()))
            .collect(),
    }
    .visit_program(program);
}

struct ImportBindingRewriteVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    rewrites: BindingKeyMap<ImportReplacement>,
}

impl<'a> ImportBindingRewriteVisitor<'a, '_> {
    fn replacement(&self, replacement: &ImportReplacement) -> Expression<'a> {
        match replacement {
            ImportReplacement::Name(name) => Expression::new_identifier(
                SPAN,
                Ident::from_in(name, self.allocator),
                &self.builder,
            ),
            ImportReplacement::Slot(alias) => {
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
    }
}

impl<'a> VisitMut<'a> for ImportBindingRewriteVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::Identifier(identifier) = expression {
            if let Some(binding) = self.identity.key_of_reference(identifier) {
                if let Some(replacement) = self.rewrites.get(&binding) {
                    *expression = self.replacement(replacement);
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
                    if let Some(replacement) = self.rewrites.get(&binding) {
                        property.shorthand = false;
                        property.value = self.replacement(replacement);
                        return;
                    }
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }
}

struct TopLevelRenames {
    renames: BindingKeyMap<String>,
    shared_helper_names: HashSet<String>,
}

fn collect_top_level_renames(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    ordinal: usize,
) -> TopLevelRenames {
    let mut renames = HashMap::new();
    let mut shared_helper_names = HashSet::new();
    for statement in &program.body {
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        let Some(initializer_source) = helper_initializer_source(declaration) else {
            continue;
        };
        let [declarator] = declaration.declarations.as_slice() else {
            continue;
        };
        let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
            continue;
        };
        let canonical_name =
            canonical_shared_helper_name(binding.name.as_str(), &initializer_source);
        renames.insert(identity.key_of_binding(binding), canonical_name.clone());
        shared_helper_names.insert(canonical_name);
    }

    let add_declaration =
        |declaration: &Declaration<'_>, renames: &mut BindingKeyMap<String>| match declaration {
            Declaration::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    for (binding, name) in binding_names_with_ids(&declarator.id, identity) {
                        renames
                            .entry(binding)
                            .or_insert_with(|| suffixed_name(&name, ordinal));
                    }
                }
            }
            Declaration::FunctionDeclaration(function) => {
                if let Some(binding) = &function.id {
                    renames.insert(
                        identity.key_of_binding(binding),
                        suffixed_name(binding.name.as_str(), ordinal),
                    );
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(binding) = &class.id {
                    renames.insert(
                        identity.key_of_binding(binding),
                        suffixed_name(binding.name.as_str(), ordinal),
                    );
                }
            }
            _ => {}
        };
    for statement in &program.body {
        match statement {
            statement if statement.as_declaration().is_some() => {
                add_declaration(statement.as_declaration().unwrap(), &mut renames);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    add_declaration(declaration, &mut renames);
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(binding) = &function.id {
                        renames.insert(
                            identity.key_of_binding(binding),
                            suffixed_name(binding.name.as_str(), ordinal),
                        );
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(binding) = &class.id {
                        renames.insert(
                            identity.key_of_binding(binding),
                            suffixed_name(binding.name.as_str(), ordinal),
                        );
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    TopLevelRenames {
        renames,
        shared_helper_names,
    }
}

fn apply_top_level_renames<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identity: &mut ModuleIdentity,
    renames: &BindingKeyMap<String>,
) {
    if renames.is_empty() {
        return;
    }
    for (binding, name) in renames {
        identity.rename(*binding, Ident::from_in(name, allocator));
    }
    TopLevelRenameVisitor {
        allocator,
        identity,
        renames,
    }
    .visit_program(program);
}

struct TopLevelRenameVisitor<'a, 'i> {
    allocator: &'a Allocator,
    identity: &'i ModuleIdentity,
    renames: &'i BindingKeyMap<String>,
}

impl TopLevelRenameVisitor<'_, '_> {
    fn binding_name(&self, binding: &BindingIdentifier<'_>) -> Option<&str> {
        self.renames
            .get(&self.identity.key_of_binding(binding))
            .map(String::as_str)
    }

    fn reference_name(&self, reference: &IdentifierReference<'_>) -> Option<&str> {
        self.identity
            .key_of_reference(reference)
            .and_then(|binding| self.renames.get(&binding))
            .map(String::as_str)
    }
}

impl<'a> VisitMut<'a> for TopLevelRenameVisitor<'a, '_> {
    fn visit_binding_identifier(&mut self, binding: &mut BindingIdentifier<'a>) {
        if let Some(name) = self.binding_name(binding) {
            binding.name = Ident::from_in(name, self.allocator);
        }
    }

    fn visit_identifier_reference(&mut self, reference: &mut IdentifierReference<'a>) {
        if let Some(name) = self.reference_name(reference) {
            reference.name = Ident::from_in(name, self.allocator);
        }
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        if property.shorthand {
            if let Expression::Identifier(reference) = &property.value {
                if self.reference_name(reference).is_some() {
                    property.shorthand = false;
                }
            }
        }
        walk_mut::walk_object_property(self, property);
    }

    fn visit_binding_property(&mut self, property: &mut BindingProperty<'a>) {
        if property.shorthand
            && immediate_binding(&property.value).is_some_and(|binding| {
                self.renames
                    .contains_key(&self.identity.key_of_binding(binding))
            })
        {
            property.shorthand = false;
        }
        walk_mut::walk_binding_property(self, property);
    }
}

fn immediate_binding<'b, 'a>(pattern: &'b BindingPattern<'a>) -> Option<&'b BindingIdentifier<'a>> {
    match pattern {
        BindingPattern::BindingIdentifier(binding) => Some(binding),
        BindingPattern::AssignmentPattern(assignment) => immediate_binding(&assignment.left),
        _ => None,
    }
}

fn collect_direct_safe_namespace_ids(
    program: &Program<'_>,
    identity: &ModuleIdentity,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
) -> BindingKeySet {
    let consumer_module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let consumer_chunk = plan.chunk_of(&consumer_module_id);
    let usage = scan_namespace_usage(program, identity);
    let mut direct = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let Ok(target_module_id) =
            resolve_module_id_for_specifier(file_path, import.source.value.as_str(), context)
        else {
            continue;
        };
        if !plan.is_hoisted(&target_module_id)
            || plan.chunk_of(&target_module_id).is_none()
            || consumer_chunk.is_none()
        {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) = specifier {
                let binding = identity.key_of_binding(&namespace.local);
                if usage.member_only_usage(binding).is_some() {
                    direct.insert(binding);
                }
            }
        }
    }
    direct
}

fn is_pure_statement(
    statement: &Statement<'_>,
    pure_names: &HashSet<String>,
    pure_callees: &HashSet<String>,
    original_name_of: impl Fn(&str) -> Option<String>,
) -> bool {
    if pure_names.is_empty() && pure_callees.is_empty() {
        return false;
    }
    let Statement::VariableDeclaration(declaration) = statement else {
        return false;
    };
    let [declarator] = declaration.declarations.as_slice() else {
        return false;
    };
    let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
        return false;
    };
    let original =
        original_name_of(binding.name.as_str()).unwrap_or_else(|| binding.name.to_string());
    if pure_names.contains(&original) {
        return true;
    }
    let Some(Expression::CallExpression(call)) = &declarator.init else {
        return false;
    };
    let Expression::Identifier(callee) = &call.callee else {
        return false;
    };
    pure_callees.contains(strip_module_ordinal(callee.name.as_str()))
}

fn strip_module_ordinal(name: &str) -> &str {
    let Some((base, ordinal)) = name.rsplit_once("$$") else {
        return name;
    };
    if !ordinal.is_empty() && ordinal.bytes().all(|byte| byte.is_ascii_digit()) {
        base
    } else {
        name
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
