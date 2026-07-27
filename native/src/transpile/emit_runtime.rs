use super::*;

pub(super) fn emit_bundler_runtime_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    rewrite_bundler_runtime_namespace_usage(&mut module, file_path, context)?;
    let mut output = Vec::new();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    let import_plans = module
        .body
        .iter()
        .filter_map(|item| match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => Some(
                convert_bundler_import_decl(file_path, import_decl, context, &mut import_counter),
            ),
            _ => None,
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
                    .map(|slot_alias| (rewrite.local_name.clone(), slot_alias))
            })
        })
        .collect::<HashMap<_, _>>();
    let all_rewrites = import_plans
        .iter()
        .flat_map(|plan| plan.binding_rewrites.iter().cloned())
        .collect::<Vec<_>>();
    apply_import_binding_rewrites(&mut module, &all_rewrites);
    let local_export_modes = collect_local_export_modes(&module);
    let mut import_plans = import_plans.into_iter();

    if let Some(metadata) = file_metadata {
        for type_decl in &metadata.type_declarations {
            output.push(type_decl.snippet.trim().to_string());
        }
        for enum_decl in &metadata.enum_declarations {
            output.push(render_closure_enum(enum_decl));
            if enum_decl.exported {
                let slot = current_slots.slot_for(&enum_decl.name).ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        enum_decl.name, module_id
                    )
                })?;
                output.push(render_static_export_slot(slot, &enum_decl.name));
            }
        }
    }

    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(_)) => {
                let plan = import_plans
                    .next()
                    .ok_or_else(|| "Missing bundler-runtime import plan".to_string())?;
                output.extend(plan.lines);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                let slot_mode = slot_mode_for_export_decl(&export_decl.decl, &local_export_modes);
                output.push(print_statement(Stmt::Decl(export_decl.decl))?);
                for export_name in exported_names {
                    let slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, module_id
                        )
                    })?;
                    output.push(render_slot_export(slot_mode, slot, &export_name));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                let lines = convert_bundler_named_export(
                    file_path,
                    &named_export,
                    context,
                    current_slots,
                    &import_binding_rewrites,
                    &import_binding_slot_aliases,
                    &local_export_modes,
                    &mut export_counter,
                )?;
                output.extend(lines);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = format!("__gcc_default_export_{export_counter}");
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                let slot = current_slots.slot_for("default").ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for default in {}",
                        module_id
                    )
                })?;
                output.push(render_static_export_slot(slot, &local_name));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let local_name = function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
                    export_counter += 1;
                    if function_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                            swc_core::ecma::ast::FnDecl {
                                declare: false,
                                function: function_expr.function,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            },
                        )))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for default in {}",
                            module_id
                        )
                    })?;
                    output.push(render_static_export_slot(slot, &local_name));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let local_name = class_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
                    export_counter += 1;
                    if class_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(
                            swc_core::ecma::ast::Decl::Class(swc_core::ecma::ast::ClassDecl {
                                class: class_expr.class,
                                declare: false,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            }),
                        ))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Class(class_expr))?
                        ));
                    }
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for default in {}",
                            module_id
                        )
                    })?;
                    output.push(render_static_export_slot(slot, &local_name));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name = format!("__gcc_export_all_{export_counter}");
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                let runtime_export_module_id = to_bundler_runtime_module_id(&export_module_id);
                output.push(format!(
                    "const {require_name} = __require({runtime_export_module_id:?});"
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
                let mut packed_slot_pairs = Vec::new();
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
                    packed_slot_pairs.push((target_slot, source_slot));
                }
                output.extend(render_grouped_live_slot_exports(
                    &require_name,
                    packed_slot_pairs,
                ));
            }
            ModuleItem::Stmt(statement) => output.push(print_statement(statement)?),
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        let export_slot = current_slots.slot_for(export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                export_name, module_id
            )
        })?;
        output.push(render_live_export_slot(export_slot, export_name));
        let default_slot = current_slots.slot_for("default").ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for default in {}",
                module_id
            )
        })?;
        output.push(render_live_export_slot(default_slot, export_name));
    }

    // Host libraries unwrap dynamic-import namespaces via
    // `.default`/`.__esModule`; see the hoisted facade emission for details.
    if context.lazy_target_module_ids.contains(&module_id)
        && current_slots.slot_for("default") == Some(0)
    {
        output.push("__exports.__esModule = true;".to_string());
        output.push("__exports.default = __exports[0];".to_string());
    }

    let body = rewrite_bundler_exports(
        &output
            .into_iter()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let source_text = format!(
        "__register({module_id:?}, function(__require, __exports, __dynamicImport, __preloadDynamicImport, __live) {{\n{}\n}});",
        indent_block(&body),
        module_id = runtime_module_id,
    );
    Ok(apply_js_compat_text_fixes(source_text))
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

fn rewrite_bundler_exports(source: &str) -> String {
    let dot_rewritten = regex::Regex::new(r"\bexports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
        .map(|regex| {
            regex
                .replace_all(source, "__exports[\"$1\"] =")
                .into_owned()
        })
        .unwrap_or_else(|_| source.to_string());
    regex::Regex::new(r#"\bexports\[(["'])(.+?)\1\]\s*="#)
        .map(|regex| {
            regex
                .replace_all(&dot_rewritten, "__exports[\"$2\"] =")
                .into_owned()
        })
        .unwrap_or(dot_rewritten)
}

fn render_slot_export(mode: BundlerExportSlotMode, slot: usize, value_expression: &str) -> String {
    match mode {
        BundlerExportSlotMode::Static => render_static_export_slot(slot, value_expression),
        BundlerExportSlotMode::Live => render_live_export_slot(slot, value_expression),
    }
}

fn slot_mode_for_export_decl(
    decl: &swc_core::ecma::ast::Decl,
    local_export_modes: &HashMap<String, BundlerExportSlotMode>,
) -> BundlerExportSlotMode {
    match decl {
        swc_core::ecma::ast::Decl::Fn(_) | swc_core::ecma::ast::Decl::Class(_) => {
            BundlerExportSlotMode::Static
        }
        swc_core::ecma::ast::Decl::Var(var_decl) => {
            if matches!(var_decl.kind, VarDeclKind::Const) {
                let all_static = var_decl
                    .decls
                    .iter()
                    .flat_map(|decl| export_binding_names_with_ids(&decl.name))
                    .all(|(_, name)| {
                        matches!(
                            local_export_modes.get(&name),
                            Some(BundlerExportSlotMode::Static)
                        )
                    });
                if all_static {
                    BundlerExportSlotMode::Static
                } else {
                    BundlerExportSlotMode::Live
                }
            } else {
                BundlerExportSlotMode::Live
            }
        }
        _ => BundlerExportSlotMode::Live,
    }
}

pub(super) fn collect_local_export_modes(
    module: &Module,
) -> HashMap<String, BundlerExportSlotMode> {
    let mut binding_candidates = HashMap::<Id, (String, BundlerExportSlotMode)>::new();
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                for specifier in &import_decl.specifiers {
                    let local = match specifier {
                        ImportSpecifier::Default(default_specifier) => &default_specifier.local,
                        ImportSpecifier::Namespace(namespace_specifier) => {
                            &namespace_specifier.local
                        }
                        ImportSpecifier::Named(named_specifier) => &named_specifier.local,
                    };
                    binding_candidates.insert(
                        local.to_id(),
                        (local.sym.to_string(), BundlerExportSlotMode::Live),
                    );
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                collect_decl_export_candidates(&export_decl.decl, &mut binding_candidates);
            }
            ModuleItem::Stmt(Stmt::Decl(decl)) => {
                collect_decl_export_candidates(decl, &mut binding_candidates);
            }
            _ => {}
        }
    }

    let tracked_ids = binding_candidates.keys().cloned().collect::<HashSet<_>>();
    let mut reassigned_collector = ReassignedBindingCollector {
        tracked_ids,
        reassigned_ids: HashSet::new(),
    };
    module.visit_with(&mut reassigned_collector);

    binding_candidates
        .into_iter()
        .map(|(binding_id, (name, mode))| {
            let mode = if reassigned_collector.reassigned_ids.contains(&binding_id) {
                BundlerExportSlotMode::Live
            } else {
                mode
            };
            (name, mode)
        })
        .collect()
}

fn collect_decl_export_candidates(
    decl: &swc_core::ecma::ast::Decl,
    binding_candidates: &mut HashMap<Id, (String, BundlerExportSlotMode)>,
) {
    match decl {
        swc_core::ecma::ast::Decl::Fn(function_decl) => {
            binding_candidates.insert(
                function_decl.ident.to_id(),
                (
                    function_decl.ident.sym.to_string(),
                    BundlerExportSlotMode::Static,
                ),
            );
        }
        swc_core::ecma::ast::Decl::Class(class_decl) => {
            binding_candidates.insert(
                class_decl.ident.to_id(),
                (
                    class_decl.ident.sym.to_string(),
                    BundlerExportSlotMode::Static,
                ),
            );
        }
        swc_core::ecma::ast::Decl::Var(var_decl) => {
            let mode = if matches!(var_decl.kind, VarDeclKind::Const) {
                BundlerExportSlotMode::Static
            } else {
                BundlerExportSlotMode::Live
            };
            for (binding_id, name) in var_decl
                .decls
                .iter()
                .flat_map(|decl| export_binding_names_with_ids(&decl.name))
            {
                binding_candidates.insert(binding_id, (name, mode));
            }
        }
        _ => {}
    }
}

pub(super) fn export_binding_names_with_ids(pattern: &Pat) -> Vec<(Id, String)> {
    match pattern {
        Pat::Ident(ident) => vec![(ident.to_id(), ident.id.sym.to_string())],
        Pat::Array(array) => array
            .elems
            .iter()
            .flatten()
            .flat_map(export_binding_names_with_ids)
            .collect(),
        Pat::Object(object) => object
            .props
            .iter()
            .flat_map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    export_binding_names_with_ids(&key_value.value)
                }
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    vec![(assign.key.to_id(), assign.key.sym.to_string())]
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(rest) => {
                    export_binding_names_with_ids(&rest.arg)
                }
            })
            .collect(),
        Pat::Assign(assign) => export_binding_names_with_ids(&assign.left),
        Pat::Rest(rest) => export_binding_names_with_ids(&rest.arg),
        _ => Vec::new(),
    }
}

struct ReassignedBindingCollector {
    tracked_ids: HashSet<Id>,
    reassigned_ids: HashSet<Id>,
}

impl Visit for ReassignedBindingCollector {
    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        collect_assign_target_ids(
            &assign_expr.left,
            &self.tracked_ids,
            &mut self.reassigned_ids,
        );
    }

    fn visit_update_expr(&mut self, update_expr: &swc_core::ecma::ast::UpdateExpr) {
        update_expr.visit_children_with(self);
        if let Expr::Ident(ident) = &*update_expr.arg {
            let binding_id = ident.to_id();
            if self.tracked_ids.contains(&binding_id) {
                self.reassigned_ids.insert(binding_id);
            }
        }
    }
}

fn collect_assign_target_ids(
    target: &swc_core::ecma::ast::AssignTarget,
    tracked_ids: &HashSet<Id>,
    reassigned_ids: &mut HashSet<Id>,
) {
    match target {
        swc_core::ecma::ast::AssignTarget::Simple(simple) => {
            collect_simple_assign_target_ids(simple, tracked_ids, reassigned_ids)
        }
        swc_core::ecma::ast::AssignTarget::Pat(pattern) => {
            let pattern: Pat = pattern.clone().into();
            for (binding_id, _) in export_binding_names_with_ids(&pattern) {
                if tracked_ids.contains(&binding_id) {
                    reassigned_ids.insert(binding_id);
                }
            }
        }
    }
}

fn collect_simple_assign_target_ids(
    target: &swc_core::ecma::ast::SimpleAssignTarget,
    tracked_ids: &HashSet<Id>,
    reassigned_ids: &mut HashSet<Id>,
) {
    match target {
        swc_core::ecma::ast::SimpleAssignTarget::Ident(binding) => {
            let binding_id = binding.id.to_id();
            if tracked_ids.contains(&binding_id) {
                reassigned_ids.insert(binding_id);
            }
        }
        _ => {}
    }
}
