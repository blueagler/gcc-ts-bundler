use oxc_ast::ast::{ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind};

use super::super::super::emit::PreservedImportPlan;
use super::super::super::identity::ModuleIdentity;
use super::super::super::is_valid_js_identifier;
use super::super::import_plan::{ImportBindingRewrite, ImportReplacement};
use super::planner::HoistedImportPlanner;
use super::types::{module_export_name, HoistedImportPlan};

impl HoistedImportPlanner<'_> {
    pub(crate) fn plan_preserved_import(
        &mut self,
        import: &ImportDeclaration<'_>,
        preserved: &super::super::super::PreservedModuleInput,
    ) -> std::result::Result<HoistedImportPlan, String> {
        if import.import_kind == ImportOrExportKind::Type {
            return Ok(HoistedImportPlan {
                extern_lines: Vec::new(),
                lines: Vec::new(),
                preserved_imports: Vec::new(),
                rewrites: Vec::new(),
            });
        }
        let import_index = self.preserved_import_count;
        self.preserved_import_count += 1;
        let mut boundary_exports = Vec::new();
        let mut boundary_names = Vec::new();
        let mut extern_lines = Vec::new();
        let mut rewrites = Vec::new();
        let mut default_binding = None;
        let mut namespace_binding = None;
        let mut named_bindings = Vec::new();
        for (specifier_index, specifier) in import.specifiers.iter().flatten().enumerate() {
            let preferred = format!(
                "__gcc_preserved_{}_{}_{}",
                &crate::utils::hash_content(&preserved.module_id)[..12],
                self.consumer_ordinal,
                import_index * 16 + specifier_index
            );
            let boundary = self.fresh_names.fresh(&preferred);
            boundary_names.push(boundary.clone());
            extern_lines.push(format!("var {boundary};"));
            match specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    if !preserved.has_default_export {
                        return Err(format!(
                            "Preserved module {} has no default export",
                            preserved.file_path
                        ));
                    }
                    boundary_exports.push("default".to_string());
                    default_binding = Some(boundary.clone());
                    rewrites.push(ImportBindingRewrite {
                        binding_id: ModuleIdentity::key_of_binding(&default.local)?,
                        replacement: ImportReplacement::Name(boundary.clone()),
                    });
                }
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    if named.import_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    let imported_name = module_export_name(&named.imported);
                    if !preserved.export_names.contains(&imported_name) {
                        return Err(format!(
                            "Preserved module {} does not export {imported_name:?}",
                            preserved.file_path
                        ));
                    }
                    if !is_valid_js_identifier(&imported_name) {
                        return Err(format!(
                            "Preserved module {} exports unsupported non-identifier name {imported_name:?}",
                            preserved.file_path
                        ));
                    }
                    boundary_exports.push(imported_name.clone());
                    named_bindings.push(format!("{imported_name} as {boundary}"));
                    rewrites.push(ImportBindingRewrite {
                        binding_id: ModuleIdentity::key_of_binding(&named.local)?,
                        replacement: ImportReplacement::Name(boundary.clone()),
                    });
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    boundary_exports.push("*".to_string());
                    namespace_binding = Some(boundary.clone());
                    for export_name in &preserved.export_names {
                        if is_valid_js_identifier(export_name) {
                            extern_lines.push(format!("{boundary}.{export_name};"));
                        }
                    }
                    if preserved.has_default_export {
                        extern_lines.push(format!("{boundary}.default;"));
                    }
                    rewrites.push(ImportBindingRewrite {
                        binding_id: ModuleIdentity::key_of_binding(&namespace.local)?,
                        replacement: ImportReplacement::Name(boundary.clone()),
                    });
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
            (Some(default), Some(namespace), true) => {
                format!("{default}, * as {namespace}")
            }
            (None, None, false) => format!("{{ {} }}", named_bindings.join(", ")),
            (Some(default), None, false) => {
                format!("{default}, {{ {} }}", named_bindings.join(", "))
            }
            (_, Some(_), false) => {
                return Err(format!(
                    "Preserved module import in {} has an unsupported namespace/named combination",
                    preserved.file_path
                ));
            }
        };
        Ok(HoistedImportPlan {
            extern_lines,
            lines: Vec::new(),
            preserved_imports: vec![PreservedImportPlan {
                boundary_exports,
                boundary_names,
                external_specifier: None,
                import_clause,
                target_module_id: preserved.module_id.clone(),
            }],
            rewrites,
        })
    }
}
