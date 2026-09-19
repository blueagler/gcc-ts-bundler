use oxc_ast::ast::ModuleExportName;

use super::super::super::emit::PreservedImportPlan;
use super::super::import_plan::ImportBindingRewrite;

pub(crate) struct HoistedImportPlan {
    pub(crate) extern_lines: Vec<String>,
    pub(crate) lines: Vec<String>,
    pub(crate) preserved_imports: Vec<PreservedImportPlan>,
    pub(crate) rewrites: Vec<ImportBindingRewrite>,
}

pub(crate) fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}
