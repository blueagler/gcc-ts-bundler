//! Statement assembly for goog.module emit.

use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::{ExportDefaultDeclarationKind, ImportOrExportKind, Statement};

use super::super::super::emit::PreservedImportPlan;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::NamespaceUsage;
use super::super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::super::nocollapse::NocollapseAssignments;
use super::super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::super::{resolve_module_id_for_specifier, resolved_import_key, TranspileContext};
use super::super::external::boundary_identity;
use super::super::imports::{
    boundary_identity_token, convert_export_all, convert_export_from, convert_external_import_decl,
    convert_import_decl, convert_named_export, validate_preserved_import,
};
use super::names::{default_declaration_name, exported_decl_names, print_node};

pub(super) struct GoogModuleStatementsInput<'s, 'm> {
    pub(super) file_path: &'s Path,
    pub(super) identity: &'s ModuleIdentity,
    pub(super) context: &'s TranspileContext,
    pub(super) module_id: &'s str,
    pub(super) namespace_usage: &'s NamespaceUsage,
    pub(super) live_imported_ids: &'s BindingKeySet,
    pub(super) live_imported_locals: &'s HashSet<String>,
    pub(super) output: &'s mut Vec<String>,
    pub(super) preserved_extern_lines: &'s mut Vec<String>,
    pub(super) preserved_imports: &'s mut Vec<PreservedImportPlan>,
    pub(super) fresh_names: &'s mut FreshNameAllocator,
    pub(super) type_metadata: &'s mut PreparedTypeMetadata<'m>,
    pub(super) nocollapse_assignments: &'s NocollapseAssignments,
}

pub(super) fn emit_goog_module_statements<'a>(
    body: oxc_allocator::Vec<'a, Statement<'a>>,
    input: GoogModuleStatementsInput<'_, '_>,
) -> std::result::Result<(), String> {
    let GoogModuleStatementsInput {
        file_path,
        identity,
        context,
        module_id,
        namespace_usage,
        live_imported_ids,
        live_imported_locals,
        output,
        preserved_extern_lines,
        preserved_imports,
        fresh_names,
        type_metadata,
        nocollapse_assignments,
    } = input;
    let mut import_counter = 0;
    let mut export_counter = 0;
    let import_start = output.len();
    let mut imports = Vec::new();
    for statement in body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if let Some(specifier) = context.external_specifiers.get(&resolved_import_key(
                    file_path,
                    import.source.value.as_str(),
                )) {
                    let plan = convert_external_import_decl(
                        &import,
                        specifier,
                        boundary_identity_token(context, specifier),
                        None,
                        context.opaque_external_specifiers.contains(specifier),
                        fresh_names,
                    )?;
                    imports.extend(plan.lines);
                    preserved_extern_lines.extend(plan.extern_lines);
                    preserved_imports.push(plan.preserved_import);
                } else {
                    let target_module_id = resolve_module_id_for_specifier(
                        file_path,
                        import.source.value.as_str(),
                        context,
                    )?;
                    if let Some(preserved) = context.preserved_modules.get(&target_module_id) {
                        validate_preserved_import(&import, preserved)?;
                        let mut plan = convert_external_import_decl(
                            &import,
                            import.source.value.as_str(),
                            boundary_identity_token(
                                context,
                                &boundary_identity(module_id, import.source.value.as_str()),
                            ),
                            Some(namespace_usage),
                            false,
                            fresh_names,
                        )?;
                        plan.preserved_import.external_specifier = None;
                        plan.preserved_import
                            .target_module_id
                            .clone_from(&preserved.module_id);
                        imports.extend(plan.lines);
                        preserved_extern_lines.extend(plan.extern_lines);
                        preserved_imports.push(plan.preserved_import);
                    } else {
                        imports.extend(convert_import_decl(
                            file_path,
                            &import,
                            context,
                            &mut import_counter,
                            fresh_names,
                            live_imported_ids,
                        )?);
                    }
                }
            }
            Statement::ExportDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind() == ImportOrExportKind::Type {
                    continue;
                }
                let declaration = export.declaration;
                let exported_names = exported_decl_names(&declaration)?;
                output.push(type_metadata.render_statement_with_nocollapse(
                    identity,
                    declaration.into(),
                    &[],
                    Some(nocollapse_assignments),
                )?);
                for export_name in exported_names {
                    output.push(format!("exports.{export_name} = {export_name};"));
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                output.extend(convert_named_export(&export, live_imported_locals)?);
            }
            Statement::ExportFromDeclaration(export) => {
                imports.extend(convert_export_from(
                    file_path,
                    &export,
                    context,
                    &mut export_counter,
                    fresh_names,
                )?);
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration).map_or_else(
                    || fresh_names.fresh(&format!("__goog_default_export_{export_counter}")),
                    str::to_string,
                );
                export_counter += 1;
                match export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function)
                        if function.id.is_some() =>
                    {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::FunctionDeclaration(function),
                            &[],
                            Some(nocollapse_assignments),
                        )?);
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) if class.id.is_some() => {
                        output.push(type_metadata.render_statement_with_nocollapse(
                            identity,
                            Statement::ClassDeclaration(class),
                            &[],
                            Some(nocollapse_assignments),
                        )?);
                    }
                    declaration => {
                        let printed = print_node(&declaration);
                        output.push(format!(
                            "const {local_name} = {};",
                            printed.trim().trim_end_matches(';')
                        ));
                    }
                }
                output.push(format!("exports.default = {local_name};"));
            }
            Statement::ExportAllDeclaration(export) => imports.extend(convert_export_all(
                file_path,
                &export,
                context,
                &mut export_counter,
                fresh_names,
            )?),
            statement if statement.is_typescript_syntax() => {}
            statement => output.push(type_metadata.render_statement_with_nocollapse(
                identity,
                statement,
                &[],
                Some(nocollapse_assignments),
            )?),
        }
    }
    // Static dependencies are initialized before the module body regardless
    // of declaration position. Keep their relative source order intact.
    drop(output.splice(import_start..import_start, imports));
    Ok(())
}
