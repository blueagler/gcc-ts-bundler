use super::*;

pub(crate) fn group_lazy_imports_by_file(
    lazy_imports: Vec<LazyImportInput>,
) -> HashMap<String, Vec<LazyImportInput>> {
    let mut grouped = HashMap::<String, Vec<LazyImportInput>>::new();
    for entry in lazy_imports {
        grouped
            .entry(entry.importerFilePath.clone())
            .or_default()
            .push(entry);
    }
    for entries in grouped.values_mut() {
        entries.sort_by(|left, right| left.specifier.cmp(&right.specifier));
    }
    grouped
}

fn lazy_lookup_key(importer_file_path: &str, specifier: &str) -> String {
    format!("{importer_file_path}\0{specifier}")
}

pub(crate) struct DynamicImportRewriteVisitor {
    importer_file_path: String,
    lazy_imports: HashMap<String, LazyImportInput>,
}

impl DynamicImportRewriteVisitor {
    pub(crate) fn new(file_path: &Path, lazy_imports: &[LazyImportInput]) -> Self {
        Self {
            importer_file_path: file_path.to_string_lossy().to_string(),
            lazy_imports: lazy_imports
                .iter()
                .cloned()
                .map(|entry| {
                    (
                        lazy_lookup_key(&entry.importerFilePath, &entry.specifier),
                        entry,
                    )
                })
                .collect(),
        }
    }
}

impl VisitMut for DynamicImportRewriteVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Call(call_expr) = expr else {
            return;
        };
        let Callee::Import(_) = &call_expr.callee else {
            return;
        };
        if call_expr.args.len() != 1 {
            return;
        }
        let specifier = match &*call_expr.args[0].expr {
            Expr::Lit(Lit::Str(string)) => string.value.to_string_lossy().to_string(),
            Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
                template.quasis[0].raw.to_string()
            }
            _ => return,
        };
        let key = lazy_lookup_key(&self.importer_file_path, &specifier);
        let Some(lazy_import) = self.lazy_imports.get(&key) else {
            return;
        };
        *expr = Expr::Call(CallExpr {
            span: Default::default(),
            ctxt: Default::default(),
            callee: Callee::Expr(Box::new(Expr::Ident(create_ident("__dynamicImport")))),
            args: vec![swc_core::ecma::ast::ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    raw: None,
                    span: Default::default(),
                    value: to_bundler_runtime_module_id(&lazy_import.moduleId).into(),
                }))),
            }],
            type_args: None,
        });
    }
}
