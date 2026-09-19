//! Import and export assembly for goog.module emit.

use oxc_ast::ast::{
    ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName,
};

mod convert;
mod external;

pub(crate) use convert::{
    convert_export_all, convert_export_from, convert_import_decl, convert_named_export,
};
pub(crate) use external::{boundary_identity_token, convert_external_import_decl};

pub(crate) fn validate_preserved_import(
    import: &ImportDeclaration<'_>,
    preserved: &super::super::PreservedModuleInput,
) -> std::result::Result<(), String> {
    for specifier in import.specifiers.iter().flatten() {
        match specifier {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(_)
                if !preserved.has_default_export =>
            {
                return Err(format!(
                    "Preserved module {} has no default export",
                    preserved.file_path
                ));
            }
            ImportDeclarationSpecifier::ImportSpecifier(named)
                if named.import_kind != ImportOrExportKind::Type =>
            {
                let imported_name = module_export_name(&named.imported);
                if !preserved.export_names.contains(&imported_name) {
                    return Err(format!(
                        "Preserved module {} does not export {imported_name:?}",
                        preserved.file_path
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(string) => string.value.to_string(),
    }
}
