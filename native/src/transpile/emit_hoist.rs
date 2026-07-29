//! Hoisted (scope-flattened) bundler-runtime emission.
//!
//! A hoisted module is emitted as plain top-level statements inside the chunk
//! wrapper. Its top-level bindings are renamed with a per-module ordinal
//! suffix, same-chunk imports become direct identifier references, and only
//! facade modules append a small `__register` block exposing export slots.

use super::*;
use crate::transpile::assigners::{assigner_function_name, NOINLINE_TAG};
use crate::transpile::pure_calls::{
    collect_pure_annotated_binding_names, pure_annotation_for_statement,
};
use swc_core::ecma::ast::{KeyValueProp, ObjectPatProp, Prop};

pub(super) fn emit_hoisted_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    plan: &HoistPlan,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    let mut bound = BoundTypeMetadata::bind(&module, file_metadata, context.type_metadata_enabled);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let ordinal = plan
        .ordinal_of(&module_id)
        .ok_or_else(|| format!("Missing hoist ordinal for {module_id}"))?;
    let pure_names = std::fs::read_to_string(file_path)
        .map(|source| collect_pure_annotated_binding_names(&source))
        .unwrap_or_default();
    let local_export_modes = collect_local_export_modes(&module);

    // Bind metadata first, then rename the exact same resolved ids that runtime
    // emission uses. No authored/display name is used as post-transform evidence.
    let TopLevelRenames {
        renames,
        shared_helper_names,
    } = collect_top_level_renames(&module, ordinal)?;
    bound.remap_binding_ids(&renames);
    let module_bindings: HashSet<String> = if context.vendor_module_ids.contains(&module_id) {
        renames.values().cloned().collect()
    } else {
        HashSet::new()
    };
    if !renames.is_empty() {
        module.visit_mut_with(&mut TopLevelRenameVisitor {
            renames: renames.clone(),
        });
    }
    let shared_helpers = emit_helpers::take_shared_helper_declarations(
        &mut module,
        &shared_helper_names,
        print_module_item,
    )?;
    let lexical_binding_names = collect_lexical_binding_names(&module);
    let fresh_names = FreshNameAllocator::from_module(&module);

    let direct_namespace_ids = collect_direct_safe_namespace_ids(&module, file_path, context, plan);
    rewrite_hoisted_namespace_usage(
        &mut module,
        file_path,
        context,
        plan,
        &module_id,
        &direct_namespace_ids,
        &lexical_binding_names,
    )?;

    let used_binding_ids = collect_used_binding_ids(&module);
    let mut import_planner = HoistedImportPlanner::new(
        context,
        plan,
        &module_id,
        ordinal,
        &lexical_binding_names,
        fresh_names,
    );
    let import_plans = module
        .body
        .iter()
        .filter_map(|item| match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                Some(import_planner.plan_import(
                    file_path,
                    import_decl,
                    &direct_namespace_ids,
                    &used_binding_ids,
                ))
            }
            _ => None,
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut fresh_names = import_planner.into_fresh_names();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|import_plan| import_plan.rewrites.iter().cloned())
        .collect::<Vec<_>>();
    let mut runtime_type_names = runtime_type_names_from_module(&module, &bound);
    for rewrite in &all_rewrites {
        if !runtime_type_names.contains_key(&rewrite.binding_id) {
            continue;
        }
        runtime_type_names.insert(
            rewrite.binding_id.clone(),
            if rewrite.slot_alias.is_some() {
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name")
            } else if is_valid_js_identifier(&rewrite.replacement_code) {
                RuntimeTypeName::Name(rewrite.replacement_code.clone())
            } else {
                RuntimeTypeName::Unresolved("runtime-binding-not-found")
            },
        );
    }
    apply_import_binding_rewrites(&mut module, &all_rewrites);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, Some(ordinal));

    let mut output = type_metadata.take_declaration_lines();
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for enum_decl in enum_declarations {
        let emitted_name = type_metadata.enum_name(&enum_decl).to_string();
        output.push(render_closure_enum(&enum_decl, &emitted_name));
        type_metadata.count_enum();
    }

    let mut import_plans = import_plans.into_iter();
    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(_)) => {
                let import_plan = import_plans
                    .next()
                    .ok_or_else(|| "Missing hoisted import plan".to_string())?;
                output.extend(import_plan.lines);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                output.push(render_hoisted_statement(
                    &mut type_metadata,
                    Stmt::Decl(export_decl.decl),
                    &pure_names,
                    &module_bindings,
                    context,
                    ordinal,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                if let Some(src) = &named_export.src {
                    output.extend(render_execution_require(
                        file_path,
                        &src.value.to_string_lossy(),
                        context,
                        plan,
                    )?);
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                output.extend(render_execution_require(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                    plan,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    if let Some(ident) = function_expr.ident.clone() {
                        output.push(render_hoisted_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                                swc_core::ecma::ast::FnDecl {
                                    declare: false,
                                    function: function_expr.function,
                                    ident,
                                },
                            )),
                            &pure_names,
                            &module_bindings,
                            context,
                            ordinal,
                        )?);
                    } else {
                        let local_name = fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    if let Some(ident) = class_expr.ident.clone() {
                        output.push(render_hoisted_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Class(
                                swc_core::ecma::ast::ClassDecl {
                                    class: class_expr.class,
                                    declare: false,
                                    ident,
                                },
                            )),
                            &pure_names,
                            &module_bindings,
                            context,
                            ordinal,
                        )?);
                    } else {
                        let local_name = fresh_names.fresh(&suffixed_name("__gcc_dflt", ordinal));
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Class(class_expr))?
                        ));
                    }
                }
                _ => {}
            },
            ModuleItem::Stmt(statement) => output.push(render_hoisted_statement(
                &mut type_metadata,
                statement,
                &pure_names,
                &module_bindings,
                context,
                ordinal,
            )?),
            _ => {}
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
    statement: Stmt,
    pure_names: &HashSet<String>,
    module_bindings: &HashSet<String>,
    context: &TranspileContext,
    ordinal: usize,
) -> std::result::Result<String, String> {
    let to_original_name = |name: &str| {
        name.strip_suffix(&format!("$${ordinal}"))
            .map(str::to_string)
    };
    let mut tags = Vec::new();
    if !pure_annotation_for_statement(
        &statement,
        pure_names,
        &context.pure_callees,
        to_original_name,
    )
    .is_empty()
    {
        tags.push(PURE_TAG);
    }
    if assigner_function_name(&statement, module_bindings).is_some() {
        tags.push(NOINLINE_TAG);
    }
    type_metadata.render_statement(statement, &tags)
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
            match mode {
                BundlerExportSlotMode::Static => {
                    lines.push(render_static_export_slot(slot, &value));
                }
                BundlerExportSlotMode::Live => {
                    lines.push(render_live_export_slot(slot, &value));
                }
            }
            continue;
        }
        if plan.is_direct_binding(module_id, binding) {
            let value = plan
                .direct_binding_name(binding)
                .ok_or_else(|| format!("Missing hoist ordinal for {}", binding.owner_module_id))?;
            let mode = plan.direct_binding_slot_mode(module_id, binding);
            match mode {
                BundlerExportSlotMode::Static => {
                    lines.push(render_static_export_slot(slot, &value));
                }
                BundlerExportSlotMode::Live => {
                    lines.push(render_live_export_slot(slot, &value));
                }
            }
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

    // Dynamic imports expose a JavaScript module namespace, including through
    // opaque framework loaders, so every lazy target keeps its named facade.
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
            .join("\n"),
    )])
}

struct HoistedImportPlan {
    lines: Vec<String>,
    rewrites: Vec<ImportBindingRewrite>,
}

struct HoistedImportPlanner<'a> {
    consumer_module_id: &'a str,
    consumer_ordinal: usize,
    context: &'a TranspileContext,
    plan: &'a HoistPlan,
    require_bindings: HashMap<String, String>,
    lexical_binding_names: &'a HashSet<String>,
    fresh_names: FreshNameAllocator,
}
impl<'a> HoistedImportPlanner<'a> {
    fn new(
        context: &'a TranspileContext,
        plan: &'a HoistPlan,
        consumer_module_id: &'a str,
        consumer_ordinal: usize,
        lexical_binding_names: &'a HashSet<String>,
        fresh_names: FreshNameAllocator,
    ) -> Self {
        Self {
            consumer_module_id,
            consumer_ordinal,
            context,
            plan,
            require_bindings: HashMap::new(),
            lexical_binding_names,
            fresh_names,
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
        import_decl: &ImportDecl,
        direct_namespace_ids: &HashSet<Id>,
        used_binding_ids: &HashSet<Id>,
    ) -> std::result::Result<HoistedImportPlan, String> {
        let target_module_id = resolve_module_id_for_specifier(
            file_path,
            &import_decl.src.value.to_string_lossy(),
            self.context,
        )?;
        let mut lines = Vec::new();
        let mut rewrites = Vec::new();

        // Registry targets only execute when required; hoisted targets ran
        // when their chunk loaded.
        if !import_decl.type_only && !self.plan.is_hoisted(&target_module_id) {
            let runtime_module_id = to_bundler_runtime_module_id(&target_module_id);
            lines.push(format!("__require({runtime_module_id:?});"));
        }

        if import_decl.specifiers.is_empty() {
            return Ok(HoistedImportPlan { lines, rewrites });
        }

        for specifier in &import_decl.specifiers {
            match specifier {
                ImportSpecifier::Named(named) if import_decl.type_only || named.is_type_only => {}
                _ if import_decl.type_only => {}
                ImportSpecifier::Named(named)
                    if !used_binding_ids.contains(&named.local.to_id()) => {}
                ImportSpecifier::Default(default_specifier)
                    if !used_binding_ids.contains(&default_specifier.local.to_id()) => {}
                ImportSpecifier::Namespace(namespace_specifier)
                    if !used_binding_ids.contains(&namespace_specifier.local.to_id()) => {}
                ImportSpecifier::Named(named) => {
                    let imported_name = named
                        .imported
                        .as_ref()
                        .map(module_export_name_to_string)
                        .unwrap_or_else(|| named.local.sym.to_string());
                    self.plan_named_binding(
                        &target_module_id,
                        &imported_name,
                        &named.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportSpecifier::Default(default_specifier) => {
                    self.plan_named_binding(
                        &target_module_id,
                        "default",
                        &default_specifier.local,
                        &mut lines,
                        &mut rewrites,
                    )?;
                }
                ImportSpecifier::Namespace(namespace_specifier) => {
                    if direct_namespace_ids.contains(&namespace_specifier.local.to_id()) {
                        continue;
                    }
                    let object_name = self.require_binding(&target_module_id, &mut lines);
                    rewrites.push(ImportBindingRewrite {
                        binding_id: namespace_specifier.local.to_id(),
                        local_name: namespace_specifier.local.sym.to_string(),
                        replacement: Box::new(Expr::Ident(create_ident(&object_name))),
                        replacement_code: object_name,
                        slot_alias: None,
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
        local: &Ident,
        lines: &mut Vec<String>,
        rewrites: &mut Vec<ImportBindingRewrite>,
    ) -> std::result::Result<(), String> {
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
                    binding_id: local.to_id(),
                    local_name: local.sym.to_string(),
                    replacement: Box::new(Expr::Ident(create_ident(&direct_name))),
                    replacement_code: direct_name,
                    slot_alias: None,
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
            rewrites.push(slot_rewrite(local, &object_name, owner_slot));
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
        rewrites.push(slot_rewrite(local, &object_name, slot));
        Ok(())
    }
}

fn slot_rewrite(local: &Ident, object_name: &str, slot: usize) -> ImportBindingRewrite {
    let replacement = Expr::Member(MemberExpr {
        span: Default::default(),
        obj: Box::new(Expr::Ident(create_ident(object_name))),
        prop: MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                span: Default::default(),
                value: slot as f64,
                raw: None,
            }))),
        }),
    });
    ImportBindingRewrite {
        binding_id: local.to_id(),
        local_name: local.sym.to_string(),
        replacement: Box::new(replacement),
        replacement_code: format!("{object_name}[{slot}]"),
        slot_alias: Some(ImportBindingSlotAlias {
            source_object_name: object_name.to_string(),
            source_slot: slot,
        }),
    }
}

/// Top-level renaming plan for one hoisted module.
pub(super) struct TopLevelRenames {
    pub(super) renames: HashMap<Id, String>,
    /// Canonical names assigned to poolable lowering helpers in this module.
    pub(super) shared_helper_names: HashSet<String>,
}

fn collect_top_level_renames(
    module: &Module,
    ordinal: usize,
) -> std::result::Result<TopLevelRenames, String> {
    let mut renames = HashMap::new();
    let mut shared_helper_names = HashSet::new();
    // A lowering helper is content-addressed instead of ordinal-suffixed, so
    // byte-identical copies across modules collapse onto one declaration that
    // the driver emits once. Nothing else about the module changes.
    for item in &module.body {
        let ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl))) = item else {
            continue;
        };
        let Some(initializer_source) =
            emit_helpers::helper_initializer_source(var_decl, |expression| {
                print_expression(expression.clone())
            })
        else {
            continue;
        };
        let [declarator] = var_decl.decls.as_slice() else {
            continue;
        };
        let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name else {
            continue;
        };
        let canonical_name = emit_helpers::canonical_shared_helper_name(
            binding.id.sym.as_ref(),
            &initializer_source?,
        );
        renames.insert(binding.id.to_id(), canonical_name.clone());
        shared_helper_names.insert(canonical_name);
    }
    let add_decl = |decl: &swc_core::ecma::ast::Decl, renames: &mut HashMap<Id, String>| match decl
    {
        swc_core::ecma::ast::Decl::Fn(function_decl) => {
            renames.insert(
                function_decl.ident.to_id(),
                suffixed_name(function_decl.ident.sym.as_ref(), ordinal),
            );
        }
        swc_core::ecma::ast::Decl::Class(class_decl) => {
            renames.insert(
                class_decl.ident.to_id(),
                suffixed_name(class_decl.ident.sym.as_ref(), ordinal),
            );
        }
        swc_core::ecma::ast::Decl::Var(var_decl) => {
            for declarator in &var_decl.decls {
                for (binding_id, name) in export_binding_names_with_ids(&declarator.name) {
                    // `or_insert` keeps a canonical helper name already chosen
                    // above; every other binding still gets the ordinal suffix.
                    renames
                        .entry(binding_id)
                        .or_insert_with(|| suffixed_name(&name, ordinal));
                }
            }
        }
        _ => {}
    };
    for item in &module.body {
        match item {
            ModuleItem::Stmt(Stmt::Decl(decl)) => add_decl(decl, &mut renames),
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                add_decl(&export_decl.decl, &mut renames)
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match &default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    if let Some(ident) = &function_expr.ident {
                        renames.insert(ident.to_id(), suffixed_name(ident.sym.as_ref(), ordinal));
                    }
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    if let Some(ident) = &class_expr.ident {
                        renames.insert(ident.to_id(), suffixed_name(ident.sym.as_ref(), ordinal));
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(TopLevelRenames {
        renames,
        shared_helper_names,
    })
}

struct TopLevelRenameVisitor {
    renames: HashMap<Id, String>,
}

impl VisitMut for TopLevelRenameVisitor {
    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if let Some(new_name) = self.renames.get(&ident.to_id()) {
            ident.sym = new_name.clone().into();
        }
    }

    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        if let Prop::Shorthand(ident) = prop {
            if let Some(new_name) = self.renames.get(&ident.to_id()) {
                let mut renamed = ident.clone();
                renamed.sym = new_name.clone().into();
                *prop = Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(ident.clone().into()),
                    value: Box::new(Expr::Ident(renamed)),
                });
                return;
            }
        }
        prop.visit_mut_children_with(self);
    }

    fn visit_mut_object_pat_prop(&mut self, prop: &mut ObjectPatProp) {
        if let ObjectPatProp::Assign(assign) = prop {
            if let Some(new_name) = self.renames.get(&assign.key.to_id()) {
                let mut renamed = assign.key.id.clone();
                renamed.sym = new_name.clone().into();
                let value = match assign.value.take() {
                    Some(default_value) => Pat::Assign(swc_core::ecma::ast::AssignPat {
                        span: Default::default(),
                        left: Box::new(Pat::Ident(BindingIdent {
                            id: renamed,
                            type_ann: None,
                        })),
                        right: {
                            let mut default_value = default_value;
                            default_value.visit_mut_with(self);
                            default_value
                        },
                    }),
                    None => Pat::Ident(BindingIdent {
                        id: renamed,
                        type_ann: None,
                    }),
                };
                *prop = ObjectPatProp::KeyValue(swc_core::ecma::ast::KeyValuePatProp {
                    key: PropName::Ident(assign.key.id.clone().into()),
                    value: Box::new(value),
                });
                return;
            }
        }
        prop.visit_mut_children_with(self);
    }
}

/// Namespace bindings that are only ever used as `ns.member` can skip the
/// require object entirely and resolve members to direct bindings.
fn collect_direct_safe_namespace_ids(
    module: &Module,
    file_path: &Path,
    context: &TranspileContext,
    plan: &HoistPlan,
) -> HashSet<Id> {
    let consumer_module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let consumer_chunk = plan.chunk_of(&consumer_module_id);
    let mut candidates = HashSet::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item
        else {
            continue;
        };
        if import_decl.type_only {
            continue;
        }
        let Ok(target_module_id) = resolve_module_id_for_specifier(
            file_path,
            &import_decl.src.value.to_string_lossy(),
            context,
        ) else {
            continue;
        };
        if !plan.is_hoisted(&target_module_id)
            || plan.chunk_of(&target_module_id).is_none()
            || consumer_chunk.is_none()
        {
            continue;
        }
        for specifier in &import_decl.specifiers {
            if let ImportSpecifier::Namespace(namespace_specifier) = specifier {
                candidates.insert(namespace_specifier.local.to_id());
            }
        }
    }
    if candidates.is_empty() {
        return candidates;
    }

    let mut scanner = NamespaceUsageScanner {
        candidates,
        disqualified: HashSet::new(),
    };
    // Import specifiers and re-export specifiers are not expression contexts,
    // so visiting every item (including default exports) is safe.
    module.visit_with(&mut scanner);
    scanner
        .candidates
        .difference(&scanner.disqualified)
        .cloned()
        .collect()
}

struct NamespaceUsageScanner {
    candidates: HashSet<Id>,
    disqualified: HashSet<Id>,
}

impl Visit for NamespaceUsageScanner {
    fn visit_expr(&mut self, expr: &Expr) {
        if let Expr::Member(member) = expr {
            if let Expr::Ident(object_ident) = &*member.obj {
                if self.candidates.contains(&object_ident.to_id())
                    && member_prop_name(&member.prop).is_some()
                {
                    member.prop.visit_with(self);
                    return;
                }
            }
        }
        if let Expr::Ident(ident) = expr {
            if self.candidates.contains(&ident.to_id()) {
                self.disqualified.insert(ident.to_id());
            }
        }
        expr.visit_children_with(self);
    }
}
