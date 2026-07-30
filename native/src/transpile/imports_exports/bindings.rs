use super::*;
use swc_core::ecma::ast::{ComputedPropName, KeyValueProp, Prop};

pub(super) struct NamedExportBinding {
    pub(super) export_name: String,
    pub(super) local_name: String,
}

/// `export * as ns from "./m"` — the whole module namespace under one name.
///
/// This used to be dropped on the floor by `collect_named_export_bindings`'s
/// `filter_map`, which produced a `goog.require` with no `exports.ns =` to go
/// with it: the re-export silently vanished and every consumer read
/// `undefined`. It is a distinct shape from a named re-export (there is no
/// member to read off the required module — the module object *is* the value),
/// so it gets its own type rather than being forced into `NamedExportBinding`.
pub(super) struct NamespaceExportBinding {
    pub(super) export_name: String,
}

pub(super) fn collect_namespace_export_bindings(
    named_export: &swc_core::ecma::ast::NamedExport,
) -> Vec<NamespaceExportBinding> {
    named_export
        .specifiers
        .iter()
        .filter_map(|specifier| {
            let swc_core::ecma::ast::ExportSpecifier::Namespace(namespace) = specifier else {
                return None;
            };
            Some(NamespaceExportBinding {
                export_name: module_export_name_to_string(&namespace.name),
            })
        })
        .collect()
}

#[derive(Clone)]
pub(crate) struct ImportBindingRewrite {
    pub(crate) binding_id: Id,
    pub(crate) local_name: String,
    pub(crate) replacement: Box<Expr>,
    pub(crate) replacement_code: String,
    pub(crate) slot_alias: Option<ImportBindingSlotAlias>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BundlerExportSlotMode {
    Live,
    Static,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ImportBindingSlotAlias {
    pub(crate) source_object_name: String,
    pub(crate) source_slot: usize,
}

pub(super) fn bind_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
    // Locals whose target export is provably reassigned: those alias the
    // exporter's live accessor instead of its value property, and reads of them
    // were rewritten into calls. See `emit_goog`'s live-export section.
    live_imported_ids: &HashSet<Id>,
) -> Vec<String> {
    specifiers
        .iter()
        .map(|specifier| match specifier {
            ImportSpecifier::Default(default_specifier) => format!(
                "const {} = {}.default;",
                default_specifier.local.sym, local_name
            ),
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                let source_name = if live_imported_ids.contains(&named_specifier.local.to_id()) {
                    live_export_accessor_name(&imported_name)
                } else {
                    imported_name
                };
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    member_access(local_name, &source_name)
                )
            }
        })
        .collect()
}

/// The export name carrying a live accessor for `export_name`.
///
/// Derived from the export name rather than allocated, because the exporting
/// module and every importer have to agree on it without a side channel.
pub(crate) fn live_export_accessor_name(export_name: &str) -> String {
    format!("__gccLive_{export_name}")
}

pub(super) fn plan_bundler_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<(Vec<String>, Vec<ImportBindingRewrite>), String> {
    let mut lines = Vec::new();
    let mut rewrites = Vec::new();
    for specifier in specifiers {
        match specifier {
            ImportSpecifier::Default(default_specifier) => {
                let slot = target_slots
                    .slot_for("default")
                    .ok_or_else(|| "Missing bundler-runtime default export slot".to_string())?;
                rewrites.push(ImportBindingRewrite {
                    binding_id: default_specifier.local.to_id(),
                    local_name: default_specifier.local.sym.to_string(),
                    replacement: Box::new(slot_access_expr(local_name, slot)),
                    replacement_code: stable_slot_access(local_name, slot),
                    slot_alias: Some(ImportBindingSlotAlias {
                        source_object_name: local_name.to_string(),
                        source_slot: slot,
                    }),
                });
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                lines.push(format!(
                    "const {} = {};",
                    namespace_specifier.local.sym, local_name
                ));
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                let slot = target_slots.slot_for(&imported_name).ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for imported name {imported_name}")
                })?;
                rewrites.push(ImportBindingRewrite {
                    binding_id: named_specifier.local.to_id(),
                    local_name: named_specifier.local.sym.to_string(),
                    replacement: Box::new(slot_access_expr(local_name, slot)),
                    replacement_code: stable_slot_access(local_name, slot),
                    slot_alias: Some(ImportBindingSlotAlias {
                        source_object_name: local_name.to_string(),
                        source_slot: slot,
                    }),
                });
            }
        }
    }
    Ok((lines, rewrites))
}

pub(super) fn collect_named_export_bindings(
    named_export: &swc_core::ecma::ast::NamedExport,
) -> Vec<NamedExportBinding> {
    named_export
        .specifiers
        .iter()
        .filter_map(|specifier| {
            let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                return None;
            };
            let local_name = module_export_name_to_string(&named.orig);
            let export_name = named
                .exported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| local_name.clone());
            Some(NamedExportBinding {
                export_name,
                local_name,
            })
        })
        .collect()
}

pub(super) fn reject_namespace_export_specifiers(
    named_export: &swc_core::ecma::ast::NamedExport,
    file_path: &Path,
) -> std::result::Result<(), String> {
    if named_export.specifiers.iter().any(|specifier| {
        matches!(
            specifier,
            swc_core::ecma::ast::ExportSpecifier::Namespace(_)
        )
    }) {
        return Err(format!(
            "bundler-runtime does not support namespace re-exports in {}",
            file_path.display()
        ));
    }
    Ok(())
}

pub(crate) fn exported_decl_names(decl: &swc_core::ecma::ast::Decl) -> Vec<String> {
    match decl {
        swc_core::ecma::ast::Decl::Fn(function_decl) => vec![function_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Class(class_decl) => vec![class_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Var(var_decl) => var_decl
            .decls
            .iter()
            .flat_map(|decl| binding_names(&decl.name))
            .collect(),
        _ => Vec::new(),
    }
}

fn binding_names(pattern: &Pat) -> Vec<String> {
    match pattern {
        Pat::Ident(ident) => vec![ident.id.sym.to_string()],
        Pat::Array(array) => array
            .elems
            .iter()
            .flatten()
            .flat_map(binding_names)
            .collect(),
        Pat::Object(object) => object
            .props
            .iter()
            .flat_map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    binding_names(&key_value.value)
                }
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    vec![assign.key.sym.to_string()]
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(rest) => binding_names(&rest.arg),
            })
            .collect(),
        Pat::Assign(assign) => binding_names(&assign.left),
        Pat::Rest(rest) => binding_names(&rest.arg),
        _ => Vec::new(),
    }
}

pub(crate) fn member_access(object_name: &str, property_name: &str) -> String {
    if is_valid_js_identifier(property_name) {
        format!("{object_name}.{property_name}")
    } else {
        format!("{object_name}[{property_name:?}]")
    }
}

pub(crate) fn stable_slot_access(object_name: &str, slot: usize) -> String {
    format!("{object_name}[{slot}]")
}

fn slot_access_expr(object_name: &str, slot: usize) -> Expr {
    Expr::Member(MemberExpr {
        span: Default::default(),
        obj: Box::new(Expr::Ident(create_ident(object_name))),
        prop: MemberProp::Computed(ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                span: Default::default(),
                value: slot as f64,
                raw: None,
            }))),
        }),
    })
}

pub(crate) fn apply_import_binding_rewrites(
    module: &mut Module,
    rewrites: &[ImportBindingRewrite],
) {
    if rewrites.is_empty() {
        return;
    }
    let rewrite_map = rewrites
        .iter()
        .map(|rewrite| (rewrite.binding_id.clone(), rewrite.replacement.clone()))
        .collect::<HashMap<_, _>>();
    module.visit_mut_with(&mut ImportBindingRewriteVisitor { rewrite_map });
}

struct ImportBindingRewriteVisitor {
    rewrite_map: HashMap<Id, Box<Expr>>,
}

impl VisitMut for ImportBindingRewriteVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);
        let Expr::Ident(ident) = expr else {
            return;
        };
        let Some(replacement) = self.rewrite_map.get(&ident.to_id()) else {
            return;
        };
        *expr = *replacement.clone();
    }

    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        if let Prop::Shorthand(ident) = prop {
            if let Some(replacement) = self.rewrite_map.get(&ident.to_id()) {
                *prop = Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(ident.clone().into()),
                    value: replacement.clone(),
                });
                return;
            }
        }
        prop.visit_mut_children_with(self);
    }
}

pub(crate) fn render_live_export_slot(slot: usize, value_expression: &str) -> String {
    render_live_export_slot_with("__live", "__exports", slot, value_expression)
}

pub(crate) fn render_live_export_slot_with(
    live_name: &str,
    exports_name: &str,
    slot: usize,
    value_expression: &str,
) -> String {
    format!("{live_name}({exports_name},{slot},function(){{return {value_expression};}});")
}

pub(crate) fn render_packed_live_export_slots_with(
    live_name: &str,
    exports_name: &str,
    source_object_name: &str,
    slot_pairs: &[(usize, usize)],
) -> String {
    let flat_pairs = slot_pairs
        .iter()
        .flat_map(|(target_slot, source_slot)| [target_slot, source_slot])
        .map(|slot| slot.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("{live_name}({exports_name},{source_object_name},[{flat_pairs}]);")
}

pub(crate) fn render_namespace_export_slots_with(
    exports_name: &str,
    export_slots: &[(String, usize)],
) -> String {
    let descriptors = export_slots
        .iter()
        .map(|(export_name, slot)| {
            let key = if is_valid_js_identifier(export_name) && export_name != "__cjsExports" {
                export_name.clone()
            } else {
                format!("{export_name:?}")
            };
            format!(
                "{key}:{{configurable:true,enumerable:true,get:function(){{return {exports_name}[{slot}];}}}}"
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("Object.defineProperties({exports_name},{{{descriptors}}});")
}

pub(crate) fn render_static_export_slot(slot: usize, value_expression: &str) -> String {
    render_static_export_slot_with("__exports", slot, value_expression)
}

pub(crate) fn render_static_export_slot_with(
    exports_name: &str,
    slot: usize,
    value_expression: &str,
) -> String {
    format!("{exports_name}[{slot}]={value_expression};")
}

pub(crate) fn module_export_name_to_string(name: &swc_core::ecma::ast::ModuleExportName) -> String {
    match name {
        swc_core::ecma::ast::ModuleExportName::Ident(ident) => ident.sym.to_string(),
        swc_core::ecma::ast::ModuleExportName::Str(value) => {
            value.value.to_string_lossy().to_string()
        }
    }
}
