//! Internal goog.require import and named/star export assembly.

use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::*;

use super::super::super::fresh::FreshNameAllocator;
use super::super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::super::{
    live_export_accessor_name, member_access, resolve_module_id_for_specifier, TranspileContext,
};
use super::module_export_name;

pub(crate) fn convert_import_decl(
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

pub(crate) fn convert_named_export(
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

pub(crate) fn convert_export_all(
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
