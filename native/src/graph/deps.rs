use super::*;
use crate::transpile::no_substitution_template_value;

pub(super) fn extract_dependencies(module: &Module) -> Vec<String> {
    let mut dependencies = Vec::new();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) => {
                if !import_decl.type_only {
                    dependencies.push(import_decl.src.value.to_string_lossy().to_string());
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if !named.type_only {
                    if let Some(src) = &named.src {
                        dependencies.push(src.value.to_string_lossy().to_string());
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) if !export_all.type_only => {
                dependencies.push(export_all.src.value.to_string_lossy().to_string());
            }
            _ => {}
        }
    }

    dependencies
}

pub(super) fn collect_dynamic_import_specifiers(
    module: &Module,
) -> std::result::Result<Vec<String>, String> {
    let mut collector = DynamicImportCallCollector {
        errors: Vec::new(),
        specifiers: Vec::new(),
    };
    module.visit_with(&mut collector);
    if !collector.errors.is_empty() {
        return Err(collector.errors.join("\n"));
    }
    Ok(collector.specifiers)
}

struct DynamicImportCallCollector {
    errors: Vec<String>,
    specifiers: Vec<String>,
}

impl Visit for DynamicImportCallCollector {
    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);

        let Callee::Import(_) = &call_expr.callee else {
            return;
        };
        if call_expr.args.len() != 1 {
            self.errors
                .push("import() requires exactly one string literal argument".to_string());
            return;
        }
        match &*call_expr.args[0].expr {
            Expr::Lit(Lit::Str(string)) => {
                self.specifiers
                    .push(string.value.to_string_lossy().to_string());
            }
            Expr::Tpl(template) => match no_substitution_template_value(template) {
                Some(specifier) => self.specifiers.push(specifier),
                None => self
                    .errors
                    .push("import() requires a string literal module specifier".to_string()),
            },
            _ => self
                .errors
                .push("import() requires a string literal module specifier".to_string()),
        }
    }
}
