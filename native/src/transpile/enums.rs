use super::*;

#[derive(Clone)]
pub(super) enum EnumLiteralValue {
    Bool(bool),
    Number(f64),
    String(String),
}

pub(super) fn collect_ts_enum_literal_values(
    module: &Module,
) -> HashMap<String, HashMap<String, EnumLiteralValue>> {
    let mut enums = HashMap::new();
    for item in &module.body {
        let enum_decl = match item {
            ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsEnum(enum_decl))) => {
                Some(enum_decl)
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                match &export_decl.decl {
                    swc_core::ecma::ast::Decl::TsEnum(enum_decl) => Some(enum_decl),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(enum_decl) = enum_decl else {
            continue;
        };

        let mut members = HashMap::new();
        let mut next_number = 0f64;
        let mut has_next_number = true;
        for member in &enum_decl.members {
            let member_name = match &member.id {
                TsEnumMemberId::Ident(ident) => ident.sym.to_string(),
                TsEnumMemberId::Str(value) => value.value.to_string_lossy().to_string(),
            };
            let value = if let Some(initializer) = &member.init {
                let Some(value) = enum_literal_value_from_expr(initializer) else {
                    has_next_number = false;
                    continue;
                };
                if let EnumLiteralValue::Number(number) = value {
                    next_number = number + 1.0;
                    has_next_number = true;
                    EnumLiteralValue::Number(number)
                } else {
                    has_next_number = false;
                    value
                }
            } else if has_next_number {
                let value = EnumLiteralValue::Number(next_number);
                next_number += 1.0;
                value
            } else {
                continue;
            };
            members.insert(member_name, value);
        }
        if !members.is_empty() {
            enums.insert(enum_decl.id.sym.to_string(), members);
        }
    }
    enums
}

pub(super) fn collect_imported_ts_enum_literal_values(
    module: &Module,
    file_path: &Path,
) -> HashMap<String, HashMap<String, EnumLiteralValue>> {
    let mut imported = HashMap::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item
        else {
            continue;
        };
        let specifier = import_decl.src.value.to_string_lossy().to_string();
        if !specifier.starts_with('.') {
            continue;
        }
        let Some(resolved_path) = resolve_relative_module(file_path, &specifier) else {
            continue;
        };
        let Ok(target_module) = get_or_parse_cached_module(&resolved_path) else {
            continue;
        };
        let mut target_values = collect_ts_enum_literal_values(&target_module);
        if target_values.is_empty() {
            for metadata_path in enum_metadata_candidate_paths(&resolved_path) {
                if !metadata_path.exists() {
                    continue;
                }
                let Ok(metadata_module) = get_or_parse_cached_module(&metadata_path) else {
                    continue;
                };
                target_values = collect_ts_enum_literal_values(&metadata_module);
                if !target_values.is_empty() {
                    break;
                }
            }
        }
        if target_values.is_empty() {
            continue;
        }
        for import_specifier in &import_decl.specifiers {
            let swc_core::ecma::ast::ImportSpecifier::Named(named) = import_specifier else {
                continue;
            };
            let imported_name = match &named.imported {
                Some(swc_core::ecma::ast::ModuleExportName::Ident(ident)) => ident.sym.to_string(),
                Some(swc_core::ecma::ast::ModuleExportName::Str(value)) => {
                    value.value.to_string_lossy().to_string()
                }
                None => named.local.sym.to_string(),
            };
            let Some(enum_members) = target_values.get(&imported_name) else {
                continue;
            };
            imported.insert(named.local.sym.to_string(), enum_members.clone());
        }
    }
    imported
}

fn enum_metadata_candidate_paths(resolved_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if resolved_path.extension().and_then(|value| value.to_str()) == Some("js") {
        candidates.push(resolved_path.with_extension("d.ts"));
        let resolved_str = resolved_path.to_string_lossy();
        if resolved_str.contains("/dist/esm/") {
            let source_guess = resolved_str.replace("/dist/esm/", "/src/");
            candidates.push(PathBuf::from(source_guess.clone()).with_extension("ts"));
            candidates.push(PathBuf::from(source_guess).with_extension("tsx"));
        }
    }
    candidates
}

pub(crate) fn resolve_relative_module(file_path: &Path, specifier: &str) -> Option<PathBuf> {
    let base = normalize_path(&file_path.parent()?.join(specifier));
    let candidates: Vec<PathBuf> = if base.extension().is_some() {
        let extension = base
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        match extension {
            "js" => vec![
                base.clone(),
                base.with_extension("ts"),
                base.with_extension("tsx"),
                base.with_extension("mts"),
                base.with_extension("cjs"),
                base.with_extension("cts"),
                base.with_extension("jsx"),
                base.with_extension("mjs"),
            ],
            "cjs" => vec![
                base.clone(),
                base.with_extension("js"),
                base.with_extension("ts"),
                base.with_extension("cts"),
            ],
            _ => vec![base],
        }
    } else {
        vec![
            base.with_extension("ts"),
            base.with_extension("tsx"),
            base.with_extension("mts"),
            base.with_extension("js"),
            base.with_extension("cjs"),
            base.with_extension("cts"),
            base.with_extension("jsx"),
            base.with_extension("mjs"),
            base.join("index.ts"),
            base.join("index.tsx"),
            base.join("index.mts"),
            base.join("index.js"),
            base.join("index.cjs"),
            base.join("index.cts"),
            base.join("index.jsx"),
            base.join("index.mjs"),
        ]
    };
    candidates
        .into_iter()
        .find(|candidate: &PathBuf| candidate.exists())
}

fn enum_literal_value_from_expr(expr: &Expr) -> Option<EnumLiteralValue> {
    match expr {
        Expr::Lit(Lit::Num(value)) => Some(EnumLiteralValue::Number(value.value)),
        Expr::Lit(Lit::Str(value)) => Some(EnumLiteralValue::String(
            value.value.to_string_lossy().to_string(),
        )),
        Expr::Lit(Lit::Bool(value)) => Some(EnumLiteralValue::Bool(value.value)),
        Expr::Unary(UnaryExpr {
            op: UnaryOp::Minus,
            arg,
            ..
        }) => {
            let EnumLiteralValue::Number(value) = enum_literal_value_from_expr(arg)? else {
                return None;
            };
            Some(EnumLiteralValue::Number(-value))
        }
        Expr::Paren(parenthesized) => enum_literal_value_from_expr(&parenthesized.expr),
        _ => None,
    }
}

pub(super) struct EnumValueInlineVisitor {
    values: HashMap<String, HashMap<String, EnumLiteralValue>>,
}

impl EnumValueInlineVisitor {
    pub(super) fn new(values: HashMap<String, HashMap<String, EnumLiteralValue>>) -> Self {
        Self { values }
    }
}

impl VisitMut for EnumValueInlineVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let member_name = match &member.prop {
            MemberProp::Ident(ident) => Some(ident.sym.to_string()),
            MemberProp::Computed(computed) => match &*computed.expr {
                Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
                _ => None,
            },
            _ => None,
        };
        let Some(member_name) = member_name else {
            return;
        };
        let Some(enum_members) = self.values.get(object_ident.sym.as_ref()) else {
            return;
        };
        let Some(value) = enum_members.get(&member_name) else {
            return;
        };

        *expr = match value {
            EnumLiteralValue::Bool(value) => Expr::Lit(Lit::Bool(Bool {
                span: Default::default(),
                value: *value,
            })),
            EnumLiteralValue::Number(value) => Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                span: Default::default(),
                value: *value,
                raw: None,
            })),
            EnumLiteralValue::String(value) => Expr::Lit(Lit::Str(Str {
                span: Default::default(),
                value: value.clone().into(),
                raw: None,
            })),
        };
    }
}
