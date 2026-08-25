//! Statement assembly for goog.module emit.

use std::collections::HashSet;
use std::path::Path;

use oxc_ast::ast::*;

use super::super::super::emit::PreservedImportPlan;
use super::super::super::fresh::FreshNameAllocator;
use super::super::super::hoist::NamespaceUsage;
use super::super::super::identity::{BindingKeySet, ModuleIdentity};
use super::super::super::nocollapse::NocollapseAssignments;
use super::super::super::type_metadata_oxc::PreparedTypeMetadata;
use super::super::super::{resolve_module_id_for_specifier, resolved_import_key, TranspileContext};
use super::super::external::boundary_identity;
use super::super::imports::{
    boundary_identity_token, convert_export_all, convert_external_import_decl, convert_import_decl,
    convert_named_export, validate_preserved_import,
};
use super::names::{default_declaration_name, exported_decl_names, print_node};

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_goog_module_statements<'a>(
    file_path: &Path,
    identity: &ModuleIdentity,
    context: &TranspileContext,
    module_id: &str,
    namespace_usage: &NamespaceUsage,
    live_imported_ids: &BindingKeySet,
    live_imported_locals: &HashSet<String>,
    body: oxc_allocator::Vec<'a, Statement<'a>>,
    output: &mut Vec<String>,
    preserved_extern_lines: &mut Vec<String>,
    preserved_imports: &mut Vec<PreservedImportPlan>,
    fresh_names: &mut FreshNameAllocator,
    type_metadata: &mut PreparedTypeMetadata,
    nocollapse_assignments: &NocollapseAssignments,
    import_counter: &mut usize,
    export_counter: &mut usize,
) -> std::result::Result<(), String> {
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
                    output.extend(plan.lines);
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
                            Some((identity, namespace_usage)),
                            false,
                            fresh_names,
                        )?;
                        plan.preserved_import.external_specifier = None;
                        plan.preserved_import.target_module_id = preserved.moduleId.clone();
                        output.extend(plan.lines);
                        preserved_extern_lines.extend(plan.extern_lines);
                        preserved_imports.push(plan.preserved_import);
                    } else {
                        output.extend(convert_import_decl(
                            file_path,
                            &import,
                            identity,
                            context,
                            import_counter,
                            fresh_names,
                            live_imported_ids,
                        )?);
                    }
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                let export = export.unbox();
                if export.export_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(declaration) = export.declaration {
                    let exported_names = exported_decl_names(&declaration, identity);
                    output.push(type_metadata.render_statement_with_nocollapse(
                        identity,
                        declaration.into(),
                        &[],
                        Some(nocollapse_assignments),
                    )?);
                    for export_name in exported_names {
                        output.push(format!("exports.{export_name} = {export_name};"));
                    }
                } else {
                    output.extend(convert_named_export(
                        file_path,
                        &export,
                        context,
                        export_counter,
                        fresh_names,
                        live_imported_locals,
                    )?);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let export = export.unbox();
                let local_name = default_declaration_name(&export.declaration)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        fresh_names.fresh(&format!("__goog_default_export_{}", *export_counter))
                    });
                *export_counter += 1;
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
            Statement::ExportAllDeclaration(export) => output.extend(convert_export_all(
                file_path,
                &export,
                context,
                export_counter,
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
    Ok(())
}
