use super::*;
use crate::transpile::pure_calls::{
    collect_pure_annotated_binding_names, pure_annotation_for_statement,
};

#[derive(Clone, Debug)]
struct RuntimeBindingNames {
    require: String,
    exports: String,
    dynamic_import: String,
    preload_dynamic_import: String,
    live: String,
}

impl RuntimeBindingNames {
    fn allocate(module: &mut Module) -> (Self, FreshNameAllocator) {
        let generated_ids = [
            "__require",
            "__exports",
            "__dynamicImport",
            "__preloadDynamicImport",
            "__live",
        ]
        .into_iter()
        .map(|name| BindingKey::of(&create_ident(name)))
        .collect::<HashSet<_>>();
        let mut fresh_names = FreshNameAllocator::from_module_excluding(module, &generated_ids);
        let names = Self {
            require: fresh_names.fresh("__require"),
            exports: fresh_names.fresh("__exports"),
            dynamic_import: fresh_names.fresh("__dynamicImport"),
            preload_dynamic_import: fresh_names.fresh("__preloadDynamicImport"),
            live: fresh_names.fresh("__live"),
        };
        let replacements = [
            ("__require", names.require.clone()),
            ("__exports", names.exports.clone()),
            ("__dynamicImport", names.dynamic_import.clone()),
            (
                "__preloadDynamicImport",
                names.preload_dynamic_import.clone(),
            ),
            ("__live", names.live.clone()),
        ]
        .into_iter()
        .map(|(original, replacement)| (BindingKey::of(&create_ident(original)), replacement))
        .collect();
        module.visit_mut_with(&mut GeneratedRuntimeBindingRenameVisitor { replacements });
        (names, fresh_names)
    }
}

struct GeneratedRuntimeBindingRenameVisitor {
    replacements: BindingKeyMap<String>,
}

impl VisitMut for GeneratedRuntimeBindingRenameVisitor {
    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if let Some(replacement) = self.replacements.get(&BindingKey::of(&ident)) {
            ident.sym = replacement.clone().into();
        }
    }
}

pub(super) fn emit_bundler_runtime_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    let bound = BoundTypeMetadata::bind(&module, file_metadata, context.type_metadata_enabled);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let runtime_module_id = to_bundler_runtime_module_id(&module_id);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    rewrite_bundler_runtime_namespace_usage(&mut module, file_path, context)?;
    let (runtime_names, mut fresh_names) = RuntimeBindingNames::allocate(&mut module);
    let mut output = Vec::new();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    let import_plans = module
        .body
        .iter()
        .filter_map(|item| match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                Some(convert_bundler_import_decl(
                    file_path,
                    import_decl,
                    context,
                    &mut import_counter,
                    &mut fresh_names,
                    &runtime_names.require,
                ))
            }
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
    let local_export_modes = collect_local_export_modes(&module);
    let mut import_plans = import_plans.into_iter();
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);

    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for enum_decl in enum_declarations {
        let emitted_name = type_metadata.enum_name(&enum_decl).to_string();
        output.push(render_closure_enum(&enum_decl, &emitted_name));
        type_metadata.count_enum();
        if enum_decl.exported {
            let slot = current_slots
                .slot_for(&enum_decl.binding_name)
                .ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        enum_decl.binding_name, module_id
                    )
                })?;
            output.push(render_static_export_slot_with(
                &runtime_names.exports,
                slot,
                &emitted_name,
            ));
        }
    }
    let pure_names = std::fs::read_to_string(file_path)
        .map(|source| collect_pure_annotated_binding_names(&source))
        .unwrap_or_default();

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
                output.push(render_typed_statement(
                    &mut type_metadata,
                    Stmt::Decl(export_decl.decl),
                    &pure_names,
                    context,
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
                    &mut fresh_names,
                    &runtime_names.require,
                    &runtime_names.exports,
                    &runtime_names.live,
                )?;
                output.extend(lines);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name =
                    fresh_names.fresh(&format!("__gcc_default_export_{export_counter}"));
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
                output.push(render_static_export_slot_with(
                    &runtime_names.exports,
                    slot,
                    &local_name,
                ));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let original_ident = function_expr.ident.clone();
                    let local_name = original_ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| {
                            fresh_names.fresh(&format!("__gcc_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_typed_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                                swc_core::ecma::ast::FnDecl {
                                    declare: false,
                                    function: function_expr.function,
                                    ident,
                                },
                            )),
                            &pure_names,
                            context,
                        )?);
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
                    output.push(render_static_export_slot_with(
                        &runtime_names.exports,
                        slot,
                        &local_name,
                    ));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let original_ident = class_expr.ident.clone();
                    let local_name = original_ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| {
                            fresh_names.fresh(&format!("__gcc_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_typed_statement(
                            &mut type_metadata,
                            Stmt::Decl(swc_core::ecma::ast::Decl::Class(
                                swc_core::ecma::ast::ClassDecl {
                                    class: class_expr.class,
                                    declare: false,
                                    ident,
                                },
                            )),
                            &pure_names,
                            context,
                        )?);
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
                    output.push(render_static_export_slot_with(
                        &runtime_names.exports,
                        slot,
                        &local_name,
                    ));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name = fresh_names.fresh(&format!("__gcc_export_all_{export_counter}"));
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
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
                output.extend(render_grouped_live_slot_exports_with(
                    &require_name,
                    packed_slot_pairs,
                    &runtime_names.live,
                    &runtime_names.exports,
                ));
            }
            ModuleItem::Stmt(statement) => output.push(render_typed_statement(
                &mut type_metadata,
                statement,
                &pure_names,
                context,
            )?),
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

    // Dynamic imports expose live named properties in addition to compact slots.
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
    let source_text = format!(
        "__register({module_id:?}, function({}, {}, {}, {}, {}) {{\n{}\n}});",
        runtime_names.require,
        runtime_names.exports,
        runtime_names.dynamic_import,
        runtime_names.preload_dynamic_import,
        runtime_names.live,
        indent_block(&body),
        module_id = runtime_module_id,
    );
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(source_text),
        reflective_property_names: Default::default(),
        shared_helpers: Vec::new(),
        type_metadata: type_metadata.finish(),
    })
}

fn render_typed_statement(
    type_metadata: &mut PreparedTypeMetadata,
    statement: Stmt,
    pure_names: &HashSet<String>,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    let tags =
        if pure_annotation_for_statement(&statement, pure_names, &context.pure_callees, |_| None)
            .is_empty()
        {
            Vec::new()
        } else {
            vec![PURE_TAG]
        };
    type_metadata.render_statement(statement, &tags)
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

#[cfg(test)]
pub(crate) fn rewrite_bundler_exports(source: &str) -> String {
    rewrite_bundler_exports_with(source, "__exports").unwrap_or_else(|_| source.to_string())
}

#[cfg(test)]
fn rewrite_bundler_exports_with(
    source: &str,
    exports_name: &str,
) -> std::result::Result<String, String> {
    let module = parse_module(Path::new("bundler-exports.js"), source)?;
    let edits = GLOBALS.set(&Globals::new(), || {
        let mut program = Program::Module(module);
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        resolver(unresolved_mark, top_level_mark, false).process(&mut program);
        let unresolved_ctxt = swc_core::common::SyntaxContext::empty().apply_mark(unresolved_mark);
        let mut collector = BundlerExportsRewriteCollector {
            edits: Vec::new(),
            exports_name,
            unresolved_ctxt,
        };
        program.visit_with(&mut collector);
        collector.edits
    });
    apply_source_edits(source, edits)
}

#[cfg(test)]
struct BundlerExportsRewriteCollector<'a> {
    edits: Vec<(usize, usize, String)>,
    exports_name: &'a str,
    unresolved_ctxt: swc_core::common::SyntaxContext,
}

#[cfg(test)]
impl Visit for BundlerExportsRewriteCollector<'_> {
    fn visit_assign_expr(&mut self, assignment: &swc_core::ecma::ast::AssignExpr) {
        // Named here rather than re-exported through `transpile.rs`: this is the
        // only consumer left now the graph scanner reads templates via oxc, and
        // it is `cfg(test)`-only, so a crate-level re-export would be an unused
        // import in every non-test build.
        use super::namespace::dynamic_imports::no_substitution_template_value;

        assignment.visit_children_with(self);
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &assignment.left
        else {
            return;
        };
        let Expr::Ident(object) = &*member.obj else {
            return;
        };
        if object.sym != *"exports" || object.ctxt != self.unresolved_ctxt {
            return;
        }
        let property_name = match &member.prop {
            MemberProp::Ident(property) => property.sym.to_string(),
            MemberProp::Computed(property) => match &*property.expr {
                Expr::Lit(Lit::Str(value)) => value.value.to_string_lossy().to_string(),
                Expr::Tpl(template) => match no_substitution_template_value(template) {
                    Some(value) => value,
                    None => return,
                },
                _ => return,
            },
            MemberProp::PrivateName(_) => return,
        };
        let span = member.span;
        self.edits.push((
            span.lo.0.saturating_sub(1) as usize,
            span.hi.0.saturating_sub(1) as usize,
            format!("{}[{property_name:?}]", self.exports_name),
        ));
    }
}

#[cfg(test)]
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
            return Err("Invalid JavaScript source edit span".to_string());
        }
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

fn render_slot_export(
    runtime_names: &RuntimeBindingNames,
    mode: BundlerExportSlotMode,
    slot: usize,
    value_expression: &str,
) -> String {
    match mode {
        BundlerExportSlotMode::Static => {
            render_static_export_slot_with(&runtime_names.exports, slot, value_expression)
        }
        BundlerExportSlotMode::Live => render_live_export_slot_with(
            &runtime_names.live,
            &runtime_names.exports,
            slot,
            value_expression,
        ),
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
    let mut binding_candidates = BindingKeyMap::<(String, BundlerExportSlotMode)>::new();
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
                        BindingKey::of(&local),
                        (local.sym.to_string(), BundlerExportSlotMode::Live),
                    );
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                collect_decl_export_candidates(&export_decl.decl, &mut binding_candidates);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match &default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function) => {
                    if let Some(ident) = &function.ident {
                        binding_candidates.insert(
                            BindingKey::of(&ident),
                            (ident.sym.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                swc_core::ecma::ast::DefaultDecl::Class(class) => {
                    if let Some(ident) = &class.ident {
                        binding_candidates.insert(
                            BindingKey::of(&ident),
                            (ident.sym.to_string(), BundlerExportSlotMode::Static),
                        );
                    }
                }
                _ => {}
            },
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
    binding_candidates: &mut BindingKeyMap<(String, BundlerExportSlotMode)>,
) {
    match decl {
        swc_core::ecma::ast::Decl::Fn(function_decl) => {
            binding_candidates.insert(
                BindingKey::of(&function_decl.ident),
                (
                    function_decl.ident.sym.to_string(),
                    BundlerExportSlotMode::Static,
                ),
            );
        }
        swc_core::ecma::ast::Decl::Class(class_decl) => {
            binding_candidates.insert(
                BindingKey::of(&class_decl.ident),
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

pub(super) fn export_binding_names_with_ids(pattern: &Pat) -> Vec<(BindingKey, String)> {
    match pattern {
        Pat::Ident(ident) => vec![(BindingKey::of(&ident), ident.id.sym.to_string())],
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
                    vec![(BindingKey::of(&assign.key), assign.key.sym.to_string())]
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

/// Provably-reassigned bindings: the one place that answers "is this binding
/// ever written after its declaration?". Shared with `emit_goog`, which needs
/// the same answer to decide whether an export can be a snapshot.
pub(super) struct ReassignedBindingCollector {
    pub(super) tracked_ids: BindingKeySet,
    pub(super) reassigned_ids: BindingKeySet,
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
            let binding_id = BindingKey::of(&ident);
            if self.tracked_ids.contains(&binding_id) {
                self.reassigned_ids.insert(binding_id);
            }
        }
    }
}

fn collect_assign_target_ids(
    target: &swc_core::ecma::ast::AssignTarget,
    tracked_ids: &BindingKeySet,
    reassigned_ids: &mut BindingKeySet,
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
    tracked_ids: &BindingKeySet,
    reassigned_ids: &mut BindingKeySet,
) {
    if let swc_core::ecma::ast::SimpleAssignTarget::Ident(binding) = target {
        let binding_id = BindingKey::of_binding(&binding);
        if tracked_ids.contains(&binding_id) {
            reassigned_ids.insert(binding_id);
        }
    }
}
