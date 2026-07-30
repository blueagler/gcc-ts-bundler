use super::*;
use crate::transpile::pure_calls::{
    collect_pure_annotated_binding_names, pure_annotation_for_statement,
};

pub(super) fn emit_goog_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<EmittedProgram, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    // Live bindings, both directions. A read of an import this module aliases
    // from another module's live accessor becomes a call, before anything else
    // reads binding names off the module.
    let live_imported_ids = collect_live_imported_binding_ids(&module, file_path);
    if !live_imported_ids.is_empty() {
        module.visit_mut_with(&mut LiveImportCallRewriter {
            bindings: live_imported_ids.clone(),
        });
    }
    let live_imported_locals = live_imported_ids
        .iter()
        .map(|(symbol, _)| symbol.to_string())
        .collect::<HashSet<_>>();
    let live_exports = live_export_bindings(file_path);
    let bound = BoundTypeMetadata::bind(&module, file_metadata, context.type_metadata_enabled);
    let runtime_type_names = runtime_type_names_from_module(&module, &bound);
    let mut fresh_names = FreshNameAllocator::from_module(&module);
    let mut type_metadata = bound.prepare(&mut fresh_names, &runtime_type_names, None);
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];
    output.extend(type_metadata.take_declaration_lines());
    let enum_declarations = type_metadata.enum_declarations().to_vec();
    for enum_decl in enum_declarations {
        let emitted_name = type_metadata.enum_name(&enum_decl).to_string();
        output.push(render_closure_enum(&enum_decl, &emitted_name));
        type_metadata.count_enum();
        if enum_decl.exported {
            output.push(format!(
                "exports.{} = {};",
                enum_decl.binding_name, emitted_name
            ));
        }
    }

    let pure_names = std::fs::read_to_string(file_path)
        .map(|source| collect_pure_annotated_binding_names(&source))
        .unwrap_or_default();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;
    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                output.extend(convert_import_decl(
                    file_path,
                    &import_decl,
                    context,
                    &mut import_counter,
                    &mut fresh_names,
                    &live_imported_ids,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(render_statement(
                    &mut type_metadata,
                    Stmt::Decl(export_decl.decl),
                    &pure_names,
                    context,
                )?);
                for export_name in exported_names {
                    output.push(format!("exports.{export_name} = {export_name};"));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                output.extend(convert_named_export(
                    file_path,
                    &named_export,
                    context,
                    &mut export_counter,
                    &mut fresh_names,
                    &live_imported_locals,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name =
                    fresh_names.fresh(&format!("__goog_default_export_{export_counter}"));
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                output.push(format!("exports.default = {local_name};"));
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
                            fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_statement(
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
                    output.push(format!("exports.default = {local_name};"));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let original_ident = class_expr.ident.clone();
                    let local_name = original_ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| {
                            fresh_names.fresh(&format!("__goog_default_export_{export_counter}"))
                        });
                    export_counter += 1;
                    if let Some(ident) = original_ident {
                        output.push(render_statement(
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
                    output.push(format!("exports.default = {local_name};"));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name =
                    fresh_names.fresh(&format!("__goog_export_all_{export_counter}"));
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                output.push(format!(
                    "const {require_name} = goog.require({export_module_id:?});"
                ));
                output.push(format!(
                    "for (const key in {require_name}) {{ if (key !== \"default\") {{ exports[key] = {require_name}[key]; }} }}"
                ));
            }
            ModuleItem::Stmt(statement) => output.push(render_statement(
                &mut type_metadata,
                statement,
                &pure_names,
                context,
            )?),
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }

    // Last: the accessor has to sit after the declarations it closes over, and
    // it is the only thing that makes a reassignment visible to an importer.
    output.extend(render_live_export_accessors(&live_exports));

    let source_text = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EmittedProgram {
        code: apply_js_compat_text_fixes(source_text),
        reflective_property_names: Default::default(),
        shared_helpers: Vec::new(),
        type_metadata: type_metadata.finish(),
    })
}

fn render_statement(
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

// ---------------------------------------------------------------------------
// Live exports
// ---------------------------------------------------------------------------
//
// ES modules export *bindings*, not values: an importer of a binding the
// exporting module later reassigns must observe the new value. The
// `goog.module` emitter wrote `exports.X = X;` once, at declaration time, and
// importers aliased that with `const X = require(...).X;` -- two snapshots in a
// row. `export let n = 1;` plus a `bump()` that increments it therefore read as
// `1` forever in the consumer while the exporting module itself saw the updated
// value: a silent divergence from `tsc`/Node in a plain unchunked build.
//
// The bundler-runtime and hoisted emitters already answer this. They classify
// every export as `Static` or `Live` (`collect_local_export_modes`) and give a
// live one a getter slot; scope-hoisted output is live by construction because
// the importer references the exporter's variable directly. Only the
// `goog.module` shape had no answer, and this is it.
//
// Two constraints shape the fix:
//
//   * `exports.X` cannot be the mutable storage. Closure rejects an assignment
//     to `exports` outside module scope (JSC_EXPORT_NOT_AT_MODULE_SCOPE) and
//     rejects a second assignment to the same name (JSC_EXPORT_REPEATED_ERROR),
//     so the obvious "make the export slot the variable" shape does not build.
//   * `exports.X` must keep holding the *value*. It is what a namespace import,
//     a star re-export and the generated entry facade read, and what Closure's
//     property renaming sees; handing those a function would change the
//     package's public contract.
//
// So the value export stays exactly as it was, and a live *accessor* is added
// beside it: `exports.__gccLive_X = function() { return X; };`. A named importer
// aliases the accessor instead of the value and reads through a call, which
// Closure inlines back to a direct read of the exporter's variable. Nothing else
// about either module changes.
//
// Scoped to provably-reassigned exports: a `const` export -- the common case,
// and every export in the corpus -- emits exactly the bytes it did before.
//
// Deliberately still snapshots (unchanged from today, and out of this fix):
// namespace imports (`import * as m`, then `m.X`), star re-exports, and the
// bundle's own outward facade, all of which read the value property.

/// Provably-reassigned exports of `file_path`, as export name -> local binding.
///
/// Answered from the file's own source, so the exporting module and every
/// importer of it compute the same set from the same bytes; a disagreement would
/// mean an importer calling an accessor nobody emitted. `const` bindings and
/// re-exports (`export { x } from "./m"`, which has no local binding) are never
/// candidates, and a non-identifier export name is skipped.
pub(super) fn live_export_bindings(file_path: &Path) -> BTreeMap<String, String> {
    let Ok(module) = get_or_parse_cached_module(&file_path.to_path_buf()) else {
        return BTreeMap::new();
    };
    live_export_bindings_of_module(&module)
}

fn live_export_bindings_of_module(module: &Module) -> BTreeMap<String, String> {
    let mut declared = HashMap::<Id, String>::new();
    let mut exported = HashMap::<Id, (String, String)>::new();
    for item in &module.body {
        let (var_decl, is_exported) = match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                match &export_decl.decl {
                    swc_core::ecma::ast::Decl::Var(var_decl) => (var_decl, true),
                    _ => continue,
                }
            }
            ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl))) => {
                (var_decl, false)
            }
            _ => continue,
        };
        // `const` cannot be reassigned, and a `declare` binding is ambient: it is
        // erased before emission, so an accessor closing over it would not
        // compile.
        if matches!(var_decl.kind, VarDeclKind::Const) || var_decl.declare {
            continue;
        }
        for declarator in &var_decl.decls {
            for (binding_id, name) in export_binding_names_with_ids(&declarator.name) {
                if is_exported {
                    exported.insert(binding_id, (name.clone(), name));
                } else {
                    declared.insert(binding_id, name);
                }
            }
        }
    }
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) =
            item
        else {
            continue;
        };
        if named_export.src.is_some() {
            continue;
        }
        for specifier in &named_export.specifiers {
            let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                continue;
            };
            let swc_core::ecma::ast::ModuleExportName::Ident(local) = &named.orig else {
                continue;
            };
            let Some(local_name) = declared.get(&local.to_id()) else {
                continue;
            };
            let export_name = named
                .exported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| local_name.clone());
            exported.insert(local.to_id(), (export_name, local_name.clone()));
        }
    }
    if exported.is_empty() {
        return BTreeMap::new();
    }

    let mut collector = ReassignedBindingCollector {
        tracked_ids: exported.keys().cloned().collect(),
        reassigned_ids: HashSet::new(),
    };
    module.visit_with(&mut collector);
    exported
        .into_iter()
        .filter(|(binding_id, (export_name, _))| {
            collector.reassigned_ids.contains(binding_id) && is_valid_js_identifier(export_name)
        })
        .map(|(_, (export_name, local_name))| (export_name, local_name))
        .collect()
}

/// `exports.__gccLive_X = function() { return X; };`
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

/// Local bindings that alias another module's live accessor, so a read of them
/// has to become a call.
fn collect_live_imported_binding_ids(module: &Module, file_path: &Path) -> HashSet<Id> {
    let mut ids = HashSet::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item
        else {
            continue;
        };
        if import_decl.type_only {
            continue;
        }
        let specifier_text = import_decl.src.value.to_string_lossy().to_string();
        // Relative only: a package import may not even be part of this
        // compilation, and its source is not ours to read.
        if !specifier_text.starts_with('.') {
            continue;
        }
        let Some(target_path) = resolve_relative_module(file_path, &specifier_text) else {
            continue;
        };
        let live = live_export_bindings(&target_path);
        if live.is_empty() {
            continue;
        }
        for specifier in &import_decl.specifiers {
            let ImportSpecifier::Named(named) = specifier else {
                continue;
            };
            if named.is_type_only {
                continue;
            }
            let imported_name = named
                .imported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| named.local.sym.to_string());
            if live.contains_key(&imported_name) {
                ids.insert(named.local.to_id());
            }
        }
    }
    ids
}

/// Turns a read of a live-imported binding into a call of its accessor alias.
///
/// Identity-based (`Id` carries the resolver's `SyntaxContext`), so a shadowing
/// local of the same name is untouched. An object-literal shorthand is the one
/// reference position that is not an `Expr::Ident`; assignment targets need no
/// handling because assigning to an imported binding is not legal ES.
struct LiveImportCallRewriter {
    bindings: HashSet<Id>,
}

fn call_of(ident: Ident) -> Expr {
    Expr::Call(CallExpr {
        args: Vec::new(),
        callee: Callee::Expr(Box::new(Expr::Ident(ident))),
        ctxt: Default::default(),
        span: Default::default(),
        type_args: None,
    })
}

impl VisitMut for LiveImportCallRewriter {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);
        let Expr::Ident(ident) = expr else {
            return;
        };
        if !self.bindings.contains(&ident.to_id()) {
            return;
        }
        *expr = call_of(ident.clone());
    }

    fn visit_mut_prop(&mut self, prop: &mut swc_core::ecma::ast::Prop) {
        prop.visit_mut_children_with(self);
        let swc_core::ecma::ast::Prop::Shorthand(ident) = prop else {
            return;
        };
        if !self.bindings.contains(&ident.to_id()) {
            return;
        }
        // `{ x }` cannot carry a call; spell it out.
        *prop = swc_core::ecma::ast::Prop::KeyValue(swc_core::ecma::ast::KeyValueProp {
            key: PropName::Ident(swc_core::ecma::ast::IdentName::new(
                ident.sym.clone(),
                Default::default(),
            )),
            value: Box::new(call_of(ident.clone())),
        });
    }
}
