//! External and preserved-module import assembly for goog.module emit.

use oxc_ast::ast::{ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind};

use super::super::super::emit::PreservedImportPlan;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::NamespaceUsage;
use super::super::super::identity::ModuleIdentity;
use super::super::super::{is_valid_js_identifier, TranspileContext};
use super::module_export_name;

pub(crate) struct ExternalImportPlan {
    pub(crate) extern_lines: Vec<String>,
    pub(crate) lines: Vec<String>,
    pub(crate) preserved_import: PreservedImportPlan,
}

pub(crate) fn boundary_identity_token(context: &TranspileContext, identity: &str) -> String {
    context
        .boundary_identity_tokens
        .get(identity)
        .cloned()
        .unwrap_or_else(|| crate::utils::hash48_base36(identity))
}

fn boundary_export_slot(specifier: &ImportDeclarationSpecifier<'_>) -> String {
    match specifier {
        ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => "0".to_string(),
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => "s".to_string(),
        ImportDeclarationSpecifier::ImportSpecifier(named) => {
            let imported_name = module_export_name(&named.imported);
            if is_valid_js_identifier(&imported_name) {
                format!("n{imported_name}")
            } else {
                format!("q{}", crate::utils::hash48_base36(&imported_name))
            }
        }
    }
}

fn fresh_boundary_name(
    fresh_names: &mut FreshNameAllocator,
    boundary_token: &str,
    slot: &str,
) -> String {
    let mut collision_ordinal = None;
    loop {
        let token = collision_ordinal.map_or_else(
            || boundary_token.to_string(),
            |ordinal| format!("{boundary_token}z{}", crate::utils::base36(ordinal)),
        );
        let candidate = format!("e{token}_0_{slot}");
        if fresh_names.try_reserve(&candidate) {
            return candidate;
        }
        collision_ordinal = Some(collision_ordinal.map_or(0, |ordinal| ordinal + 1));
    }
}

pub(crate) fn convert_external_import_decl(
    import: &ImportDeclaration<'_>,
    external_specifier: &str,
    boundary_token: String,
    namespace_externs: Option<&NamespaceUsage>,
    opaque_external: bool,
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
    let mut boundary_exports = Vec::new();
    let mut boundary_names = Vec::new();
    let mut extern_lines = Vec::new();
    let mut lines = Vec::new();
    let mut default_binding = None;
    let mut namespace_binding = None;
    let mut named_bindings = Vec::new();
    for specifier in import.specifiers.iter().flatten() {
        if matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named) if named.import_kind == ImportOrExportKind::Type)
        {
            continue;
        }
        let boundary = fresh_boundary_name(
            fresh_names,
            &boundary_token,
            &boundary_export_slot(specifier),
        );
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
                if let Some(namespace_usage) = namespace_externs {
                    if let Some(member_names) = namespace_usage
                        .member_only_usage(ModuleIdentity::key_of_binding(&namespace.local)?)
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
