#![allow(non_snake_case)]

mod commonjs;
mod compat;
mod context;
mod emit;
mod emit_goog;
mod emit_runtime;
mod externs;
mod imports_exports;
mod js_compat;
mod namespace;
mod print;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::mem;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rayon::prelude::*;
use swc_core::common::{sync::Lrc, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::{
    ArrowExpr, BindingIdent, BlockStmt, BlockStmtOrExpr, Bool, CallExpr, Callee, EmptyStmt, Expr,
    ExprStmt, Id, Ident, ImportDecl, ImportDefaultSpecifier, ImportSpecifier, Lit, MemberExpr,
    MemberProp, Module, ModuleItem, Pass, Pat, Program, PropName, Stmt, Str, SuperProp,
    TsEnumMemberId, UnaryExpr, UnaryOp, VarDecl, VarDeclKind, VarDeclarator,
};
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_react::{jsx, Options as ReactOptions, Runtime as ReactRuntime};
use swc_ecma_transforms_typescript::strip;

use crate::closure_metadata::{
    load_closure_metadata, ClosureEnumDeclaration, ClosureFileMetadata, ClosureTopLevelDoc,
};
use crate::commonjs::{analyze_commonjs_module, evaluate_boolean_expr};
use crate::module_cache::{get_or_parse_cached_module, parse_module};
use crate::pathing::{normalize_path, to_bundler_runtime_module_id, to_goog_module_id};
use crate::support_files::{collect_commonjs_specifiers, emit_package_support_files};

use self::commonjs::*;
use self::compat::*;
pub(crate) use self::context::ChunkMode;
use self::context::*;
use self::emit::*;
use self::emit_goog::*;
use self::emit_runtime::*;
use self::externs::*;
use self::imports_exports::*;
use self::js_compat::*;
use self::namespace::*;
use self::print::*;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub externsPath: String,
    pub supportFiles: Vec<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasInput {
    pub packageName: String,
    pub subpath: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LazyImportInput {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

pub fn transpile_sources(
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    metadata_path: String,
    chunk_mode: String,
    workspace_dir: String,
    package_aliases: Vec<PackageAliasInput>,
    package_json_files: Vec<String>,
    lazy_imports: Vec<LazyImportInput>,
) -> std::result::Result<TranspileOutput, String> {
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let chunk_mode = parse_chunk_mode(&chunk_mode)?;
    let bundler_module_slots = if chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(&file_names, &workspace_dir, &package_aliases)?
    } else {
        HashMap::new()
    };
    let bundler_runtime_logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect::<HashMap<_, _>>();
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let context = TranspileContext {
        bundler_module_slots,
        bundler_runtime_logical_ids,
        chunk_mode,
        commonjs_specifiers: collect_commonjs_specifiers(&package_aliases)?
            .into_iter()
            .collect(),
        file_metadata,
        global_property_names: collect_global_property_names(&file_names)?,
        instance_method_names: collect_instance_method_names(&file_names)?,
        lazy_imports_by_file: group_lazy_imports_by_file(lazy_imports),
        package_aliases,
        static_property_names: collect_static_property_names(&file_names)?,
        workspace_dir: workspace_dir.clone(),
    };

    let emitted_outputs = file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let code = GLOBALS.set(&Globals::new(), || {
                let code = transform_source_file(&file_path, &context)?;
                Ok::<_, String>(code)
            })?;

            Ok::<_, String>((output_path, code))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    fs::write(
        &externs_path,
        render_generated_externs(
            &context.global_property_names,
            &context.static_property_names,
        ),
    )
    .map_err(|error| error.to_string())?;

    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    for (output_path, code) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&output_path, code).map_err(|error| error.to_string())?;
        emitted_files.push(output_path.to_string_lossy().to_string());
    }

    emitted_files.sort();
    let support_files = emit_package_support_files(
        &out_dir,
        &workspace_dir,
        chunk_mode,
        &context.package_aliases,
        &package_json_files,
    )?;
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        externsPath: externs_path,
        supportFiles: support_files,
    })
}

fn transform_source_file(
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let file_metadata = context
        .file_metadata
        .get(&file_path.to_string_lossy().to_string())
        .cloned();
    let module = if let Some(decorated_output_text) = file_metadata
        .as_ref()
        .and_then(|metadata| metadata.decorated_output_text.clone())
    {
        parse_module(&file_path.with_extension("js"), &decorated_output_text)?
    } else {
        get_or_parse_cached_module(&file_path.to_path_buf())?
    };
    let commonjs_analysis = analyze_commonjs_module(&module);

    if should_normalize_commonjs(file_path, &commonjs_analysis) {
        return normalize_commonjs_module(
            module,
            &commonjs_analysis,
            file_path,
            context,
            file_metadata.as_ref(),
        );
    }

    let program = if should_run_resolver(file_path) {
        transform_program(module, file_path, context, file_metadata.as_ref())?
    } else {
        transform_js_pass_through_program(module, source_text, file_path, context)
    };
    emit_module_program(file_path, program, context, file_metadata.as_ref(), None)
}

fn collect_global_this_compat_property_names(
    program: &Program,
    unresolved_ctxt: swc_core::common::SyntaxContext,
) -> HashSet<String> {
    let mut collector = GlobalThisCompatCollector::new(unresolved_ctxt);
    program.visit_with(&mut collector);
    collector.properties
}

struct GlobalThisCompatCollector {
    aliases: HashSet<Id>,
    properties: HashSet<String>,
    unresolved_ctxt: swc_core::common::SyntaxContext,
}

#[derive(Clone)]
enum EnumLiteralValue {
    Bool(bool),
    Number(f64),
    String(String),
}

fn collect_ts_enum_literal_values(
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

fn collect_imported_ts_enum_literal_values(
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
        if let Ok(relative) = resolved_path.strip_prefix("/") {
            let _ = relative;
        }
        let resolved_str = resolved_path.to_string_lossy();
        if resolved_str.contains("/dist/esm/") {
            let source_guess = resolved_str.replace("/dist/esm/", "/src/");
            candidates.push(PathBuf::from(source_guess.clone()).with_extension("ts"));
            candidates.push(PathBuf::from(source_guess).with_extension("tsx"));
        }
    }
    candidates
}

fn resolve_relative_module(file_path: &Path, specifier: &str) -> Option<PathBuf> {
    let base = normalize_path(&file_path.parent()?.join(specifier));
    let candidates = if base.extension().is_some() {
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
    candidates.into_iter().find(|candidate| candidate.exists())
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

struct EnumValueInlineVisitor {
    values: HashMap<String, HashMap<String, EnumLiteralValue>>,
}

impl EnumValueInlineVisitor {
    fn new(values: HashMap<String, HashMap<String, EnumLiteralValue>>) -> Self {
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

impl GlobalThisCompatCollector {
    fn new(unresolved_ctxt: swc_core::common::SyntaxContext) -> Self {
        Self {
            aliases: HashSet::new(),
            properties: HashSet::new(),
            unresolved_ctxt,
        }
    }

    fn is_global_this_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if ident.sym == *"globalThis" && ident.ctxt == self.unresolved_ctxt)
    }

    fn is_global_this_alias_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if self.aliases.contains(&ident.to_id()))
    }

    fn is_global_object_expr(&self, expr: &Expr) -> bool {
        self.is_global_this_expr(expr) || self.is_global_this_alias_expr(expr)
    }
}

impl Visit for GlobalThisCompatCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name {
            if let Some(init) = &declarator.init {
                if self.is_global_object_expr(init) {
                    self.aliases.insert(binding.id.to_id());
                }
            }
        }

        declarator.visit_children_with(self);
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if let Expr::Ident(object_ident) = &*member_expr.obj {
            if self.is_global_object_expr(&Expr::Ident(object_ident.clone())) {
                if let Some(property_name) = member_prop_name(&member_expr.prop) {
                    self.properties.insert(property_name);
                }
            }
        }

        member_expr.visit_children_with(self);
    }
}

struct GlobalThisCompatVisitor {
    replacements: HashMap<String, Box<Expr>>,
    unresolved_ctxt: swc_core::common::SyntaxContext,
}

impl GlobalThisCompatVisitor {
    fn new(
        property_names: HashSet<String>,
        unresolved_ctxt: swc_core::common::SyntaxContext,
    ) -> std::result::Result<Self, String> {
        let mut replacements = HashMap::new();
        for property_name in property_names {
            replacements.insert(
                property_name.clone(),
                parse_global_this_property_expr(&property_name)?,
            );
        }

        Ok(Self {
            replacements,
            unresolved_ctxt,
        })
    }
}

impl VisitMut for GlobalThisCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Ident(ident) = expr {
            if ident.ctxt == self.unresolved_ctxt {
                if let Some(replacement) = self.replacements.get(ident.sym.as_ref()) {
                    *expr = *replacement.clone();
                }
            }
        }
    }
}

fn parse_global_this_property_expr(property_name: &str) -> std::result::Result<Box<Expr>, String> {
    let expression = if is_valid_identifier(property_name) {
        format!("globalThis.{property_name};")
    } else {
        format!("globalThis[{:?}];", property_name)
    };
    let module = parse_module(&PathBuf::from("compat-snippet.js"), &expression)?;
    let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = module
        .body
        .into_iter()
        .next()
        .ok_or_else(|| "missing compat snippet expression".to_string())?
    else {
        return Err("invalid compat snippet expression".to_string());
    };
    let Expr::Member(MemberExpr { .. }) = &*expr else {
        return Err("invalid compat snippet member expression".to_string());
    };
    Ok(expr)
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) => {
                Some(value.value.to_string_lossy().to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

fn is_valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn is_typescript_source_file(file_path: &Path) -> bool {
    matches!(
        file_path.extension().and_then(|value| value.to_str()),
        Some("ts") | Some("tsx") | Some("mts")
    ) && !file_path.to_string_lossy().ends_with(".d.ts")
}

fn should_run_resolver(file_path: &Path) -> bool {
    is_typescript_source_file(file_path)
}

fn should_run_react_transform(file_path: &Path) -> bool {
    matches!(
        file_path.extension().and_then(|value| value.to_str()),
        Some("tsx") | Some("jsx")
    )
}

#[cfg(test)]
mod tests;
