use super::*;

pub(super) fn bind_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
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
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    member_access(local_name, &imported_name)
                )
            }
        })
        .collect()
}

pub(super) fn bind_bundler_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::with_capacity(specifiers.len());
    for specifier in specifiers {
        let line = match specifier {
            ImportSpecifier::Default(default_specifier) => {
                let slot = target_slots
                    .slot_for("default")
                    .ok_or_else(|| "Missing bundler-runtime default export slot".to_string())?;
                format!(
                    "const {} = {};",
                    default_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
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
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
        };
        lines.push(line);
    }
    Ok(lines)
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

pub(crate) fn render_module_export_slot(slot: usize, value_expression: &str) -> String {
    format!("__exports[{slot}] = {value_expression};")
}

pub(crate) fn module_export_name_to_string(
    name: &swc_core::ecma::ast::ModuleExportName,
) -> String {
    match name {
        swc_core::ecma::ast::ModuleExportName::Ident(ident) => ident.sym.to_string(),
        swc_core::ecma::ast::ModuleExportName::Str(value) => {
            value.value.to_string_lossy().to_string()
        }
    }
}
