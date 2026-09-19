//! Internal goog.require import and named/star export assembly.

use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::{
    ExportAllDeclaration, ExportFromDeclaration, ExportNamedDeclaration, ImportDeclaration,
    ImportDeclarationSpecifier, ImportOrExportKind,
};

use super::super::super::fresh::FreshNameAllocator;
use super::super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::super::{
    live_export_accessor_name, member_access, resolve_module_id_for_specifier, TranspileContext,
};
use super::module_export_name;

pub(crate) fn convert_import_decl(
    file_path: &Path,
    import: &ImportDeclaration<'_>,
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
            live_imported_ids,
            &module_id,
            context,
        )?);
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
            &HashSet::new(),
            &module_id,
            context,
        )?);
    }
    Ok(lines)
}

fn bind_import_specifiers(
    require_name: &str,
    specifiers: &[&ImportDeclarationSpecifier<'_>],
    live_imported_ids: &BindingKeySet,
    module_id: &str,
    context: &TranspileContext,
) -> Result<Vec<String>, String> {
    specifiers
        .iter()
        .map(|specifier| {
            Ok(match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    let local = named.local.name.as_str();
                    let imported = module_export_name(&named.imported);
                    let property = if live_imported_ids
                        .contains(&ModuleIdentity::key_of_binding(&named.local)?)
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
                    member_access(
                        require_name,
                        &if live_imported_ids
                            .contains(&ModuleIdentity::key_of_binding(&default.local)?)
                        {
                            live_export_accessor_name("default")
                        } else {
                            "default".to_string()
                        }
                    )
                ),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    format!(
                        "const {} = {};",
                        namespace.local.name,
                        namespace_expression(require_name, module_id, context)
                    )
                }
            })
        })
        .collect()
}

fn namespace_expression(require_name: &str, module_id: &str, context: &TranspileContext) -> String {
    if let Some(live) = context
        .goog_live_modules
        .get(module_id)
        .filter(|live| !live.names.is_empty())
    {
        member_access(require_name, &live.namespace_export)
    } else {
        require_name.to_string()
    }
}

pub(crate) fn convert_export_from(
    file_path: &Path,
    export: &ExportFromDeclaration<'_>,
    context: &TranspileContext,
    export_counter: &mut usize,
    fresh_names: &mut FreshNameAllocator,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let mut lines = Vec::new();
    let require_name = fresh_names.fresh(&format!("__goog_export_{}", *export_counter));
    *export_counter += 1;
    let module_id =
        resolve_module_id_for_specifier(file_path, export.source.value.as_str(), context)?;
    lines.push(format!(
        "const {require_name} = goog.require({module_id:?});"
    ));
    for specifier in &export.specifiers {
        if specifier.export_kind == ImportOrExportKind::Type {
            continue;
        }
        let exported = module_export_name(&specifier.exported);
        let imported = module_export_name(&specifier.local);
        lines.push(format!(
            "exports.{exported} = {};",
            member_access(&require_name, &imported)
        ));
        if context
            .goog_live_modules
            .get(&module_id)
            .is_some_and(|live| live.names.contains(&imported))
        {
            lines.push(format!(
                "exports.{} = {};",
                live_export_accessor_name(&exported),
                member_access(&require_name, &live_export_accessor_name(&imported))
            ));
        }
    }
    Ok(lines)
}

pub(crate) fn convert_named_export(
    export: &ExportNamedDeclaration<'_>,
    live_imported_locals: &HashSet<String>,
) -> std::result::Result<Vec<String>, String> {
    if export.export_kind == ImportOrExportKind::Type {
        return Ok(Vec::new());
    }
    let mut lines = Vec::new();

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
        let exported = module_export_name(&specifier.exported);
        lines.push(format!("exports.{exported} = {value};"));
        if live_imported_locals.contains(&module_export_name(&specifier.local)) {
            lines.push(format!(
                "exports.{} = {};",
                live_export_accessor_name(&exported),
                module_export_name(&specifier.local)
            ));
        }
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
            "exports.{} = {};",
            module_export_name(exported),
            namespace_expression(&require_name, &module_id, context)
        ));
    } else {
        let slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| {
                format!(
                    "Missing export facts for {module_id} imported from {}",
                    file_path.display()
                )
            })?;
        let own_id = crate::pathing::to_goog_module_id(file_path, &context.workspace_dir);
        let own = context.goog_live_modules.get(&own_id);
        let live = context.goog_live_modules.get(&module_id);
        for name in slots.export_names() {
            if name == "default" || own.is_some_and(|own| own.explicit.contains(name)) {
                continue;
            }
            lines.push(format!(
                "exports.{name} = {};",
                member_access(&require_name, name)
            ));
            if live.is_some_and(|live| live.names.contains(name)) {
                let accessor = live_export_accessor_name(name);
                lines.push(format!(
                    "exports.{accessor} = {};",
                    member_access(&require_name, &accessor)
                ));
            }
        }
    }
    Ok(lines)
}
