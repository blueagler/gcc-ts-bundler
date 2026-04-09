#![allow(non_snake_case)]

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
use crate::pathing::{normalize_path, to_goog_module_id};
use crate::support_files::{collect_commonjs_specifiers, emit_package_support_files};

fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "off" => Ok(ChunkMode::Off),
        "bundler-runtime" => Ok(ChunkMode::BundlerRuntime),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

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

#[derive(Clone, Debug)]
struct TranspileContext {
    bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    chunk_mode: ChunkMode,
    commonjs_specifiers: HashSet<String>,
    file_metadata: HashMap<String, ClosureFileMetadata>,
    global_property_names: HashSet<String>,
    instance_method_names: HashSet<String>,
    lazy_imports_by_file: HashMap<String, Vec<LazyImportInput>>,
    package_aliases: Vec<PackageAliasInput>,
    static_property_names: HashSet<String>,
    workspace_dir: PathBuf,
}

#[derive(Clone, Debug, Default)]
struct BundlerModuleSlots {
    export_slots: BTreeMap<String, usize>,
}

impl BundlerModuleSlots {
    fn from_export_names(export_names: &BTreeSet<String>) -> Self {
        let mut export_slots = BTreeMap::new();
        let mut next_slot = 0usize;
        if export_names.contains("default") {
            export_slots.insert("default".to_string(), 0);
            next_slot = 1;
        }
        for export_name in export_names {
            if export_name == "default" {
                continue;
            }
            export_slots.insert(export_name.clone(), next_slot);
            next_slot += 1;
        }
        Self { export_slots }
    }

    fn export_names(&self) -> impl Iterator<Item = &String> {
        self.export_slots.keys()
    }

    fn slot_for(&self, export_name: &str) -> Option<usize> {
        self.export_slots.get(export_name).copied()
    }
}

#[derive(Clone, Debug, Default)]
struct RawBundlerExportInfo {
    explicit_exports: BTreeSet<String>,
    export_all_modules: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChunkMode {
    Off,
    BundlerRuntime,
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
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let context = TranspileContext {
        bundler_module_slots,
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

fn collect_bundler_module_slots(
    file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
) -> std::result::Result<HashMap<String, BundlerModuleSlots>, String> {
    let resolution_context = TranspileContext {
        bundler_module_slots: HashMap::new(),
        chunk_mode: ChunkMode::BundlerRuntime,
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        global_property_names: HashSet::new(),
        instance_method_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        package_aliases: package_aliases.to_vec(),
        static_property_names: HashSet::new(),
        workspace_dir: workspace_dir.to_path_buf(),
    };

    let mut raw_exports_by_module = HashMap::<String, RawBundlerExportInfo>::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let module_id = to_goog_module_id(&file_path, workspace_dir);
        let module = get_or_parse_cached_module(&file_path)?;
        let commonjs_analysis = analyze_commonjs_module(&module);
        let raw_exports = if should_normalize_commonjs(&file_path, &commonjs_analysis) {
            RawBundlerExportInfo {
                explicit_exports: BTreeSet::from([
                    "__cjsExports".to_string(),
                    "default".to_string(),
                ]),
                export_all_modules: Vec::new(),
            }
        } else {
            collect_raw_bundler_exports(&module, &file_path, &resolution_context)?
        };
        raw_exports_by_module.insert(module_id, raw_exports);
    }

    let mut resolved_export_names = raw_exports_by_module
        .iter()
        .map(|(module_id, raw)| (module_id.clone(), raw.explicit_exports.clone()))
        .collect::<HashMap<_, _>>();

    loop {
        let mut changed = false;
        for (module_id, raw_exports) in &raw_exports_by_module {
            for target_module_id in &raw_exports.export_all_modules {
                let Some(target_names) = resolved_export_names.get(target_module_id).cloned() else {
                    return Err(format!(
                        "Unable to resolve bundler-runtime slot exports for module {target_module_id}"
                    ));
                };
                let resolved_names = resolved_export_names
                    .entry(module_id.clone())
                    .or_default();
                for export_name in target_names {
                    if export_name == "default" {
                        continue;
                    }
                    changed |= resolved_names.insert(export_name);
                }
            }
        }
        if !changed {
            break;
        }
    }

    Ok(resolved_export_names
        .into_iter()
        .map(|(module_id, export_names)| {
            (module_id, BundlerModuleSlots::from_export_names(&export_names))
        })
        .collect())
}

fn collect_raw_bundler_exports(
    module: &Module,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<RawBundlerExportInfo, String> {
    let mut raw_exports = RawBundlerExportInfo::default();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                raw_exports
                    .explicit_exports
                    .extend(exported_decl_names(&export_decl.decl));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                if matches!(
                    named_export.type_only,
                    true
                ) {
                    continue;
                }
                if let Some(src) = &named_export.src {
                    for specifier in &named_export.specifiers {
                        match specifier {
                            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                                let local_name = module_export_name_to_string(&named.orig);
                                let export_name = named
                                    .exported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or(local_name);
                                raw_exports.explicit_exports.insert(export_name);
                            }
                            swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                                return Err(format!(
                                    "bundler-runtime does not support namespace re-exports in {}",
                                    file_path.display()
                                ));
                            }
                            _ => {}
                        }
                    }
                    if named_export.specifiers.is_empty() {
                        let module_id = resolve_module_id_for_specifier(
                            file_path,
                            &src.value.to_string_lossy(),
                            context,
                        )?;
                        raw_exports.export_all_modules.push(module_id);
                    }
                } else {
                    for specifier in &named_export.specifiers {
                        match specifier {
                            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                                let local_name = module_export_name_to_string(&named.orig);
                                let export_name = named
                                    .exported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or(local_name);
                                raw_exports.explicit_exports.insert(export_name);
                            }
                            swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                                return Err(format!(
                                    "bundler-runtime does not support namespace re-exports in {}",
                                    file_path.display()
                                ));
                            }
                            _ => {}
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(_))
            | ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(_)) => {
                raw_exports.explicit_exports.insert("default".to_string());
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                raw_exports.export_all_modules.push(module_id);
            }
            _ => {}
        }
    }

    Ok(raw_exports)
}

#[cfg(test)]
fn render_externs(
    export_names: &BTreeSet<String>,
    enum_externs: &BTreeMap<String, BTreeSet<String>>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut all_names = export_names.clone();
    for member_names in enum_externs.values() {
        all_names.extend(member_names.iter().cloned());
    }
    if all_names.is_empty() {
        lines.push(String::new());
        return lines.join("\n");
    }

    for name in all_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Object.prototype.{name};"));
        } else {
            lines.push(format!("Object.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn render_generated_externs(
    global_property_names: &HashSet<String>,
    static_property_names: &HashSet<String>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut global_names = global_property_names.iter().cloned().collect::<Vec<_>>();
    global_names.sort();
    for name in global_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Window.prototype.{name};"));
        } else {
            lines.push(format!("Window.prototype[{name:?}];"));
        }
    }
    let mut static_names = static_property_names.iter().cloned().collect::<Vec<_>>();
    static_names.sort();
    for name in static_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Function.prototype.{name};"));
        } else {
            lines.push(format!("Function.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn collect_static_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        match get_or_parse_cached_module(&file_path) {
            Ok(module) => {
                let mut collector = StaticPropertyNameCollector::default();
                module.visit_with(&mut collector);
                names.extend(collector.names);
            }
            Err(_) => {
                let source_text =
                    fs::read_to_string(file_name).map_err(|error| error.to_string())?;
                names.extend(collect_static_property_names_from_text(&source_text));
            }
        }
    }
    Ok(names)
}

fn collect_instance_method_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        if let Ok(module) = get_or_parse_cached_module(&file_path) {
            let mut collector = InstanceMethodNameCollector::default();
            module.visit_with(&mut collector);
            names.extend(collector.names);
        }
    }
    Ok(names)
}

fn collect_static_property_names_from_text(source_text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, property_name) in collect_class_static_assignments(source_text) {
        names.insert(property_name);
    }
    if let Ok(regex) = regex::Regex::new(r"\bstatic\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\()") {
        for captures in regex.captures_iter(source_text) {
            if let Some(capture) = captures.get(1) {
                names.insert(capture.as_str().to_string());
            }
        }
    }
    names
}

#[derive(Default)]
struct StaticPropertyNameCollector {
    class_name_stack: Vec<Option<String>>,
    names: HashSet<String>,
    static_context_depth: usize,
}

impl StaticPropertyNameCollector {
    fn with_static_context<F>(&mut self, callback: F)
    where
        F: FnOnce(&mut Self),
    {
        self.static_context_depth += 1;
        callback(self);
        self.static_context_depth -= 1;
    }

    fn current_class_name(&self) -> Option<&str> {
        self.class_name_stack
            .last()
            .and_then(|name| name.as_deref())
    }

    fn insert_prop_name(&mut self, prop_name: Option<String>) {
        if let Some(prop_name) = prop_name {
            self.names.insert(prop_name);
        }
    }
}

impl Visit for StaticPropertyNameCollector {
    fn visit_class_decl(&mut self, class_decl: &swc_core::ecma::ast::ClassDecl) {
        self.class_name_stack
            .push(Some(class_decl.ident.sym.to_string()));
        class_decl.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_class_expr(&mut self, class_expr: &swc_core::ecma::ast::ClassExpr) {
        self.class_name_stack
            .push(class_expr.ident.as_ref().map(|ident| ident.sym.to_string()));
        class_expr.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_class_member(&mut self, member: &swc_core::ecma::ast::ClassMember) {
        match member {
            swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                if prop.is_static {
                    self.insert_prop_name(prop_name_to_string(&prop.key));
                }
                prop.visit_children_with(self);
            }
            swc_core::ecma::ast::ClassMember::Method(method) => {
                if method.is_static {
                    self.insert_prop_name(prop_name_to_string(&method.key));
                }
                if method.is_static {
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            swc_core::ecma::ast::ClassMember::PrivateMethod(method) => {
                if method.is_static {
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            _ => member.visit_children_with(self),
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if self.static_context_depth > 0 {
            let is_static_target = match &*member_expr.obj {
                Expr::This(_) => true,
                Expr::Ident(ident) => self
                    .current_class_name()
                    .map(|class_name| ident.sym.as_ref() == class_name)
                    .unwrap_or(false),
                _ => false,
            };
            if is_static_target {
                self.insert_prop_name(member_prop_name(&member_expr.prop));
            }
        }
        member_expr.visit_children_with(self);
    }
}

#[derive(Default)]
struct InstanceMethodNameCollector {
    names: HashSet<String>,
}

impl InstanceMethodNameCollector {
    fn insert_prop_name(&mut self, prop_name: Option<String>) {
        if let Some(prop_name) = prop_name {
            self.names.insert(prop_name);
        }
    }
}

impl Visit for InstanceMethodNameCollector {
    fn visit_class_member(&mut self, member: &swc_core::ecma::ast::ClassMember) {
        match member {
            swc_core::ecma::ast::ClassMember::Method(method) => {
                if !method.is_static {
                    self.insert_prop_name(prop_name_to_string(&method.key));
                }
                method.visit_children_with(self);
            }
            _ => member.visit_children_with(self),
        }
    }
}

fn is_valid_js_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn collect_names_from_files(
    file_names: &[String],
    collect_names: fn(&str) -> HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let source_text = fs::read_to_string(file_name).map_err(|error| error.to_string())?;
        names.extend(collect_names(&source_text));
    }
    Ok(names)
}

#[cfg(test)]
fn collect_commonjs_extern_names(
    module: &Module,
    analysis: &crate::commonjs::CommonJsAnalysis,
) -> Vec<String> {
    let mut externs = analysis
        .export_names
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let object_bindings = collect_top_level_object_bindings(module);

    for item in &module.body {
        let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item else {
            continue;
        };
        let Expr::Assign(assign) = &**expr else {
            continue;
        };
        if assign.op != swc_core::ecma::ast::AssignOp::Assign {
            continue;
        }
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &assign.left
        else {
            continue;
        };
        if !is_commonjs_export_member_expr(member) && !is_module_exports_member_expr(member) {
            continue;
        }
        let Expr::Ident(ident) = &*assign.right else {
            continue;
        };
        if let Some(bound_props) = object_bindings.get(ident.sym.as_ref()) {
            externs.extend(bound_props.iter().cloned());
        }
    }

    externs.into_iter().collect()
}

#[cfg(test)]
fn collect_top_level_object_bindings(module: &Module) -> HashMap<String, BTreeSet<String>> {
    let mut bindings = HashMap::new();

    for item in &module.body {
        let ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl))) = item else {
            continue;
        };
        for declarator in &var_decl.decls {
            let Pat::Ident(binding) = &declarator.name else {
                continue;
            };
            let Some(init) = &declarator.init else {
                continue;
            };
            let Expr::Object(object) = &**init else {
                continue;
            };
            let props = object_literal_prop_names(object);
            if !props.is_empty() {
                bindings.insert(binding.id.sym.to_string(), props);
            }
        }
    }

    bindings
}

#[cfg(test)]
fn collect_protocol_extern_names(module: &Module) -> BTreeSet<String> {
    let mut collector = ProtocolExternCollector::default();
    module.visit_with(&mut collector);
    collector.names
}

#[cfg(test)]
fn collect_enum_extern_names(module: &Module) -> BTreeSet<String> {
    collect_enum_extern_specs(module)
        .into_values()
        .flatten()
        .collect()
}

#[cfg(test)]
fn collect_enum_extern_specs(module: &Module) -> BTreeMap<String, BTreeSet<String>> {
    let mut collector = EnumExternCollector::default();
    module.visit_with(&mut collector);
    collector.enums
}

#[cfg(test)]
#[derive(Default)]
struct EnumExternCollector {
    enums: BTreeMap<String, BTreeSet<String>>,
}

#[cfg(test)]
impl Visit for EnumExternCollector {
    fn visit_ts_enum_decl(&mut self, enum_decl: &swc_core::ecma::ast::TsEnumDecl) {
        let enum_name = enum_decl.id.sym.to_string();
        let entry = self.enums.entry(enum_name).or_default();
        for member in &enum_decl.members {
            match &member.id {
                TsEnumMemberId::Ident(ident) => {
                    entry.insert(ident.sym.to_string());
                }
                TsEnumMemberId::Str(value) => {
                    entry.insert(value.value.to_string_lossy().to_string());
                }
            }
        }
        enum_decl.visit_children_with(self);
    }
}

#[cfg(test)]
#[derive(Default)]
struct ProtocolExternCollector {
    names: BTreeSet<String>,
}

#[cfg(test)]
impl Visit for ProtocolExternCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);

        let Pat::Object(object_pat) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if !is_protocol_object_name(ident.sym.as_ref()) {
            return;
        }
        for prop in &object_pat.props {
            match prop {
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    self.names.insert(assign.key.sym.to_string());
                }
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    if let Some(name) = prop_name_to_string(&key_value.key) {
                        self.names.insert(name);
                    }
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(_) => {}
            }
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        member_expr.visit_children_with(self);

        let Expr::Ident(ident) = &*member_expr.obj else {
            return;
        };
        if !is_protocol_object_name(ident.sym.as_ref()) {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member_expr.prop else {
            return;
        };
        self.names.insert(prop_ident.sym.to_string());
    }
}

#[cfg(test)]
fn is_protocol_object_name(value: &str) -> bool {
    matches!(
        value,
        "config" | "configs" | "options" | "option" | "opts" | "factory" | "factories"
    )
}

#[cfg(test)]
fn object_literal_prop_names(object: &swc_core::ecma::ast::ObjectLit) -> BTreeSet<String> {
    let mut props = BTreeSet::new();
    for property in &object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = property else {
            continue;
        };
        match &**prop {
            swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                if let Some(name) = prop_name_to_string(&key_value.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Shorthand(ident) => {
                props.insert(ident.sym.to_string());
            }
            swc_core::ecma::ast::Prop::Method(method) => {
                if let Some(name) = prop_name_to_string(&method.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Getter(getter) => {
                if let Some(name) = prop_name_to_string(&getter.key) {
                    props.insert(name);
                }
            }
            swc_core::ecma::ast::Prop::Setter(setter) => {
                if let Some(name) = prop_name_to_string(&setter.key) {
                    props.insert(name);
                }
            }
            _ => {}
        }
    }
    props
}

fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
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

fn should_normalize_commonjs(
    file_path: &Path,
    analysis: &crate::commonjs::CommonJsAnalysis,
) -> bool {
    analysis.has_commonjs
        && file_path.to_string_lossy().contains("/node_modules/")
        && !file_path.to_string_lossy().ends_with(".d.ts")
}

fn normalize_commonjs_module(
    module: Module,
    analysis: &crate::commonjs::CommonJsAnalysis,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<String, String> {
    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!("Unsupported CommonJS pattern: {reason}"));
    }

    let require_bindings = analysis
        .dependencies
        .iter()
        .enumerate()
        .map(|(index, specifier)| (specifier.clone(), format!("__cjs_require_{index}")))
        .collect::<HashMap<_, _>>();

    let import_items = analysis
        .dependencies
        .iter()
        .enumerate()
        .flat_map(|(index, specifier)| {
            parse_module_items(&format!(
                "import * as __cjs_import_{index} from {:?}; const __cjs_require_{index} = \"__cjsExports\" in __cjs_import_{index} ? __cjs_import_{index}.__cjsExports : __cjs_import_{index};",
                to_emitted_commonjs_specifier(specifier)
            ))
            .unwrap_or_default()
        })
        .collect::<Vec<_>>();

    let mut program = Program::Module(module);
    program.visit_mut_with(&mut CommonJsRewriteVisitor::new(require_bindings)?);
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };

    let mut normalized_body = Vec::new();
    normalized_body.extend(import_items);
    normalized_body.extend(parse_module_items("var module = { exports: {} };")?);
    normalized_body.extend(module.body.drain(..));
    normalized_body.extend(parse_module_items("var __cjsExports = module.exports;")?);

    let mut program = Program::Module(Module {
        body: normalized_body,
        shebang: None,
        span: module.span,
    });
    let has_t_declaration = false;
    program.visit_mut_with(&mut JsCompatAstVisitor::new(has_t_declaration));
    apply_file_compat_transforms(&mut program, file_path, context);

    emit_module_program(
        file_path,
        program,
        context,
        file_metadata,
        Some("__cjsExports"),
    )
}

fn to_emitted_commonjs_specifier(specifier: &str) -> String {
    if specifier.starts_with('.') {
        return specifier.replace(".cjs", ".js").replace(".cts", ".js");
    }

    specifier.to_string()
}

fn apply_js_compat_text_fixes(source_text: String) -> String {
    let global_properties = collect_global_this_property_names(&source_text);
    let mut source_text =
        rewrite_async_function_comment_placement(rewrite_typescript_helper_this_fallbacks(
            rewrite_process_env_node_env(rewrite_directory_module_specifiers(source_text)),
        ));
    for property_name in global_properties {
        let pattern = format!(r"(?m)(?P<prefix>^|[^\w$.]){property_name}(?P<suffix>\.)");
        let replacement = format!("${{prefix}}globalThis.{property_name}${{suffix}}");
        source_text = regex::Regex::new(&pattern)
            .map(|regex| {
                regex
                    .replace_all(&source_text, replacement.as_str())
                    .into_owned()
            })
            .unwrap_or(source_text);
    }
    source_text = annotate_nocollapse_static_members(source_text);

    for property_name in collect_closure_protocol_properties(&source_text) {
        source_text = rewrite_protected_property_accesses(source_text, &property_name);
    }

    for (class_name, property_name, initializer) in collect_static_fallbacks(&source_text) {
        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("{class_name}[{property_name:?}]").as_str(),
                )
                .into_owned();
        }
        source_text.push('\n');
        source_text.push_str(&format!(
            "{class_name}[{:?}] = {class_name}[{:?}] ?? {};\n",
            property_name, property_name, initializer
        ));
    }

    for (class_name, property_name) in collect_class_static_assignments(&source_text) {
        let this_pattern = format!(r"\bthis\s*\.\s*{}\b", regex::escape(&property_name));
        if let Ok(regex) = regex::Regex::new(&this_pattern) {
            source_text = regex
                .replace_all(&source_text, format!("this[{property_name:?}]").as_str())
                .into_owned();
        }

        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("{class_name}[{property_name:?}]").as_str(),
                )
                .into_owned();
        }
    }

    source_text
}

fn rewrite_async_function_comment_placement(source_text: String) -> String {
    regex::Regex::new(r#"(?s)async\s*(/\*\*.*?\*/)\s*function"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\nasync function")
                .into_owned()
        })
        .unwrap_or(source_text)
}

fn rewrite_typescript_helper_this_fallbacks(source_text: String) -> String {
    regex::Regex::new(
        r#"(?m)\b(var|let|const)\s+(__[A-Za-z0-9_$]+)\s*=\s*\(this\s*&&\s*this(?:\.__[A-Za-z0-9_$]+|\s*\[\s*"__[A-Za-z0-9_$]+"\s*\])\)\s*\|\|\s*function"#,
    )
    .map(|regex| regex.replace_all(&source_text, "$1 $2 = function").into_owned())
    .unwrap_or(source_text)
}

fn rewrite_process_env_node_env(source_text: String) -> String {
    regex::Regex::new(r#"\bprocess\.env\.NODE_ENV\b"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "\"production\"")
                .into_owned()
        })
        .unwrap_or(source_text)
}

fn annotate_nocollapse_static_members(mut source_text: String) -> String {
    for (class_name, property_name) in collect_class_static_assignments(&source_text) {
        for pattern in [
            format!(
                r"(?m)^(?P<indent>\s*)(?P<target>{}\s*\.\s*{}\s*=)",
                regex::escape(&class_name),
                regex::escape(&property_name),
            ),
            format!(
                r#"(?m)^(?P<indent>\s*)(?P<target>{}\s*\[\s*"{}"\s*\]\s*=)"#,
                regex::escape(&class_name),
                regex::escape(&property_name),
            ),
        ] {
            if let Ok(regex) = regex::Regex::new(&pattern) {
                source_text = regex
                    .replace_all(
                        &source_text,
                        "${indent}/** @nocollapse */\n${indent}${target}",
                    )
                    .into_owned();
            }
        }
    }

    if let Ok(regex) =
        regex::Regex::new(r"(?m)^(?P<indent>\s*)(?P<field>static\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=)")
    {
        source_text = regex
            .replace_all(
                &source_text,
                "${indent}/** @nocollapse */\n${indent}${field}",
            )
            .into_owned();
    }
    if let Ok(regex) = regex::Regex::new(
        r"(?m)^(?P<indent>\s*)(?P<field>static\s+(?:get\s+|set\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*\()",
    ) {
        source_text = regex
            .replace_all(
                &source_text,
                "${indent}/** @nocollapse */\n${indent}${field}",
            )
            .into_owned();
    }

    source_text
}

#[cfg(test)]
fn transform_js_pass_through_module(
    module: Module,
    source_text: String,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    GLOBALS.set(&Globals::new(), || {
        let program =
            transform_js_pass_through_program(module, source_text.clone(), file_path, context);
        print_program(&program)
            .map(apply_js_compat_text_fixes)
            .or_else(|_| Ok(apply_js_compat_text_fixes(source_text)))
    })
}

fn transform_js_pass_through_program(
    module: Module,
    source_text: String,
    file_path: &Path,
    context: &TranspileContext,
) -> Program {
    let mut program = Program::Module(module);
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    resolver(unresolved_mark, top_level_mark, true).process(&mut program);
    let unresolved_ctxt = swc_core::common::SyntaxContext::empty().apply_mark(unresolved_mark);
    let compat_property_names =
        collect_global_this_compat_property_names(&program, unresolved_ctxt);
    if !compat_property_names.is_empty() {
        program.visit_mut_with(
            &mut GlobalThisCompatVisitor::new(compat_property_names, unresolved_ctxt)
                .expect("global compat rewrite"),
        );
    }
    let has_t_declaration = source_declares_ident(&source_text, "T");
    program.visit_mut_with(&mut JsCompatAstVisitor::new(has_t_declaration));
    apply_file_compat_transforms(&mut program, file_path, context);
    program
}

fn source_declares_ident(source_text: &str, name: &str) -> bool {
    let pattern = format!(
        r#"(?m)\b(?:var|let|const|function|class|import)\s+{}\b"#,
        regex::escape(name)
    );
    regex::Regex::new(&pattern)
        .map(|regex| regex.is_match(source_text))
        .unwrap_or(false)
}

struct JsCompatAstVisitor {
    has_t_declaration: bool,
}

impl JsCompatAstVisitor {
    fn new(has_t_declaration: bool) -> Self {
        Self { has_t_declaration }
    }
}

impl VisitMut for JsCompatAstVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Cond(conditional) = expr {
            if let Expr::Lit(Lit::Bool(Bool { value, .. })) = &*conditional.test {
                let replacement = if *value {
                    mem::replace(
                        &mut conditional.cons,
                        Box::new(Expr::Invalid(Default::default())),
                    )
                } else {
                    mem::replace(
                        &mut conditional.alt,
                        Box::new(Expr::Invalid(Default::default())),
                    )
                };
                *expr = *replacement;
                return;
            }
        }

        if self.has_t_declaration {
            return;
        }

        let Expr::Arrow(ArrowExpr { params, body, .. }) = expr else {
            return;
        };
        if !params.is_empty() {
            return;
        }
        let BlockStmtOrExpr::Expr(returned_expr) = &mut **body else {
            return;
        };
        if !matches!(&**returned_expr, Expr::Ident(ident) if ident.sym == "T") {
            return;
        }

        *returned_expr = Box::new(Expr::Unary(UnaryExpr {
            span: Default::default(),
            op: UnaryOp::Void,
            arg: Box::new(Expr::Lit(Lit::Num(0f64.into()))),
        }));
    }
}

fn rewrite_directory_module_specifiers(source_text: String) -> String {
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)'\.'"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1'./index.js'")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)"\.""#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\"./index.js\"")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)'\.\.'"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1'../index.js'")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)"\.\.""#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\"../index.js\"")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*'\.'\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('./index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*"\."\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('./index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*'\.\.'\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('../index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    regex::Regex::new(r#"import\(\s*"\.\."\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('../index.js')")
                .into_owned()
        })
        .unwrap_or(source_text)
}

fn parse_module_items(source: &str) -> std::result::Result<Vec<ModuleItem>, String> {
    Ok(parse_module(&PathBuf::from("snippet.js"), source)?.body)
}

fn collect_global_this_property_names(source_text: &str) -> HashSet<String> {
    let mut global_aliases = HashSet::from(["globalThis".to_string()]);
    if let Ok(alias_regex) = regex::Regex::new(
        r"(?m)(?:^|[;,]\s*|\b(?:const|let|var)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        let mut changed = true;
        while changed {
            changed = false;
            for captures in alias_regex.captures_iter(source_text) {
                let alias = captures
                    .get(1)
                    .map(|capture| capture.as_str())
                    .unwrap_or_default();
                let target = captures
                    .get(2)
                    .map(|capture| capture.as_str())
                    .unwrap_or_default();
                if global_aliases.contains(target) && global_aliases.insert(alias.to_string()) {
                    changed = true;
                }
            }
        }
    }

    let mut properties = HashSet::new();
    for alias in global_aliases {
        if let Ok(regex) = regex::Regex::new(&format!(r"{alias}\.([A-Za-z_$][A-Za-z0-9_$]*)")) {
            for captures in regex.captures_iter(source_text) {
                if let Some(capture) = captures.get(1) {
                    let property_name = capture.as_str();
                    if is_global_protocol_name(property_name) {
                        properties.insert(property_name.to_string());
                    }
                }
            }
        }
    }

    properties
}

fn is_global_protocol_name(name: &str) -> bool {
    name.len() >= 8 || name.chars().any(|character| character.is_ascii_uppercase())
}

fn collect_global_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    collect_names_from_files(file_names, collect_global_this_property_names)
}

fn collect_static_fallbacks(source_text: &str) -> Vec<(String, String, String)> {
    let assignment_regex = match regex::Regex::new(
        r#"(?s)([A-Z][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\["([A-Za-z_$][A-Za-z0-9_$]*)"\])\s*=\s*(\[[^;]*?\]);"#,
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };

    let mut fallbacks = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let property_name = captures
            .get(2)
            .or_else(|| captures.get(3))
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let initializer = captures
            .get(4)
            .map(|capture| capture.as_str().to_string())
            .unwrap_or_default();

        if initializer.is_empty()
            || !source_text.contains(&format!("this.constructor.{property_name}"))
        {
            continue;
        }

        fallbacks.push((
            class_name.to_string(),
            property_name.to_string(),
            initializer,
        ));
    }

    fallbacks
}

fn collect_closure_protocol_properties(source_text: &str) -> HashSet<String> {
    regex::Regex::new(r#"JSCompiler_renameProperty\(\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']"#)
        .ok()
        .map(|regex| {
            regex
                .captures_iter(source_text)
                .filter_map(|captures| captures.get(1).map(|capture| capture.as_str().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn rewrite_protected_property_accesses(mut source_text: String, property_name: &str) -> String {
    let constructor_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])(?P<object>([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor)\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}${{object}}[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    let this_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])this\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&this_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}this[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    let identifier_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&identifier_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}${{object}}[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    source_text
}

struct CommonJsRewriteVisitor {
    module_exports_expr: Box<Expr>,
    production_expr: Box<Expr>,
    require_bindings: HashMap<String, String>,
    commonjs_object_bindings: HashSet<String>,
}

impl CommonJsRewriteVisitor {
    fn new(require_bindings: HashMap<String, String>) -> std::result::Result<Self, String> {
        let commonjs_object_bindings = require_bindings.values().cloned().collect::<HashSet<_>>();
        Ok(Self {
            module_exports_expr: parse_expr("module.exports")?,
            production_expr: parse_expr("\"production\"")?,
            require_bindings,
            commonjs_object_bindings,
        })
    }
}

impl VisitMut for CommonJsRewriteVisitor {
    fn visit_mut_assign_expr(&mut self, expression: &mut swc_core::ecma::ast::AssignExpr) {
        expression.visit_mut_children_with(self);

        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Member(member),
        ) = &mut expression.left
        else {
            return;
        };

        if is_commonjs_export_member_expr(member) {
            quote_commonjs_export_member(member);
            if let Expr::Object(object) = &mut *expression.right {
                quote_commonjs_export_object(object);
            }
            return;
        }

        if is_module_exports_member_expr(member) {
            quote_commonjs_export_member(member);
            if let Expr::Object(object) = &mut *expression.right {
                quote_commonjs_export_object(object);
            }
            return;
        }
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Member(member_expr)
                if !member_expr.prop.is_computed()
                    && matches!(&*member_expr.obj, Expr::Ident(ident) if self.commonjs_object_bindings.contains(ident.sym.as_ref())) =>
            {
                if let MemberProp::Ident(ident) = &member_expr.prop {
                    member_expr.prop = create_string_computed_prop(ident.sym.as_ref());
                }
            }
            Expr::Member(member_expr) if is_commonjs_export_member_expr(member_expr) => {
                quote_commonjs_export_member(member_expr);
            }
            Expr::Call(call_expr) => {
                if let Some(specifier) = require_call_specifier(call_expr) {
                    if let Some(binding_name) = self.require_bindings.get(&specifier) {
                        *expr =
                            *parse_expr(binding_name).expect("valid require binding identifier");
                    }
                }
            }
            Expr::Ident(ident) if ident.sym == *"exports" => {
                *expr = *self.module_exports_expr.clone();
            }
            Expr::Member(member_expr) if is_process_env_node_env_expr(member_expr) => {
                *expr = *self.production_expr.clone();
            }
            _ => {}
        }
    }

    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);

        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if self.commonjs_object_bindings.contains(ident.sym.as_ref()) {
            self.commonjs_object_bindings
                .insert(binding.id.sym.to_string());
        }
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        match stmt {
            Stmt::Expr(ExprStmt { expr, .. }) => {
                if matches!(&**expr, Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) if value.value == *"use strict")
                {
                    *stmt = Stmt::Empty(EmptyStmt {
                        span: Default::default(),
                    });
                    return;
                }

                if matches!(&**expr, Expr::Call(call_expr) if object_define_property_es_module(call_expr))
                {
                    *stmt = Stmt::Empty(EmptyStmt {
                        span: Default::default(),
                    });
                    return;
                }
            }
            Stmt::If(if_stmt) => match evaluate_boolean_expr(&if_stmt.test) {
                Some(true) => {
                    *stmt = *if_stmt.cons.clone();
                }
                Some(false) => {
                    *stmt = if_stmt
                        .alt
                        .as_ref()
                        .map(|alt| *alt.clone())
                        .unwrap_or(Stmt::Empty(EmptyStmt {
                            span: Default::default(),
                        }));
                }
                None => {}
            },
            _ => {}
        }
    }
}

fn is_commonjs_export_member_expr(member_expr: &MemberExpr) -> bool {
    matches!(
        &*member_expr.obj,
        Expr::Ident(ident) if ident.sym == *"exports"
    ) || matches!(
        &*member_expr.obj,
        Expr::Member(member) if is_module_exports_member_expr(member)
    )
}

fn quote_commonjs_export_member(member_expr: &mut MemberExpr) {
    if let MemberProp::Ident(ident) = &member_expr.prop {
        member_expr.prop = create_string_computed_prop(ident.sym.as_ref());
    }
}

fn quote_commonjs_export_object(object: &mut swc_core::ecma::ast::ObjectLit) {
    for property in &mut object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = property else {
            continue;
        };
        match &mut **prop {
            swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                key_value.key = quote_commonjs_prop_name(key_value.key.clone());
            }
            swc_core::ecma::ast::Prop::Shorthand(ident) => {
                let key = quote_commonjs_prop_name(PropName::Ident(ident.clone().into()));
                *prop = Box::new(swc_core::ecma::ast::Prop::KeyValue(
                    swc_core::ecma::ast::KeyValueProp {
                        key,
                        value: Box::new(Expr::Ident(ident.clone())),
                    },
                ));
            }
            _ => {}
        }
    }
}

fn quote_commonjs_prop_name(prop_name: PropName) -> PropName {
    match prop_name {
        PropName::Ident(ident) => {
            PropName::Computed(create_string_computed_name(ident.sym.as_ref()))
        }
        PropName::Num(number) => {
            PropName::Computed(create_string_computed_name(&number.value.to_string()))
        }
        other => other,
    }
}

fn create_string_computed_prop(property_name: &str) -> MemberProp {
    MemberProp::Computed(create_string_computed_name(property_name))
}

fn create_string_computed_super_prop(property_name: &str) -> SuperProp {
    SuperProp::Computed(create_string_computed_name(property_name))
}

fn create_string_computed_name(property_name: &str) -> swc_core::ecma::ast::ComputedPropName {
    swc_core::ecma::ast::ComputedPropName {
        span: Default::default(),
        expr: Box::new(Expr::Lit(Lit::Str(Str {
            span: Default::default(),
            value: property_name.into(),
            raw: None,
        }))),
    }
}

fn is_module_exports_member_expr(member_expr: &MemberExpr) -> bool {
    matches!(
        (&*member_expr.obj, &member_expr.prop),
        (Expr::Ident(module_ident), MemberProp::Ident(exports_ident))
            if module_ident.sym == *"module" && exports_ident.sym == *"exports"
    )
}

fn parse_expr(source: &str) -> std::result::Result<Box<Expr>, String> {
    let mut items = parse_module_items(&format!("{source};"))?;
    let Some(ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. }))) = items.pop() else {
        return Err("Expected expression snippet".to_string());
    };
    Ok(expr)
}

fn is_process_env_node_env_expr(member_expr: &MemberExpr) -> bool {
    let MemberProp::Ident(node_env_ident) = &member_expr.prop else {
        return false;
    };
    if node_env_ident.sym != *"NODE_ENV" {
        return false;
    }

    let Expr::Member(env_member) = &*member_expr.obj else {
        return false;
    };
    let MemberProp::Ident(env_ident) = &env_member.prop else {
        return false;
    };
    if env_ident.sym != *"env" {
        return false;
    }

    matches!(&*env_member.obj, Expr::Ident(process_ident) if process_ident.sym == *"process")
}

fn object_define_property_es_module(call_expr: &CallExpr) -> bool {
    let Callee::Expr(callee) = &call_expr.callee else {
        return false;
    };
    let Expr::Member(member) = &**callee else {
        return false;
    };
    let MemberProp::Ident(ident) = &member.prop else {
        return false;
    };
    if ident.sym != *"defineProperty" || call_expr.args.len() < 2 {
        return false;
    }
    matches!(&*member.obj, Expr::Ident(object_ident) if object_ident.sym == *"Object")
        && matches!(&*call_expr.args[0].expr, Expr::Ident(exports_ident) if exports_ident.sym == *"exports")
        && matches!(&*call_expr.args[1].expr, Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) if value.value == *"__esModule")
}

fn require_call_specifier(expression: &CallExpr) -> Option<String> {
    let Callee::Expr(callee) = &expression.callee else {
        return None;
    };
    let Expr::Ident(ident) = &**callee else {
        return None;
    };
    if ident.sym != *"require" || expression.args.len() != 1 {
        return None;
    }

    match &*expression.args[0].expr {
        Expr::Lit(swc_core::ecma::ast::Lit::Str(string)) => {
            Some(string.value.to_string_lossy().to_string())
        }
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            Some(template.quasis[0].raw.to_string())
        }
        _ => None,
    }
}

fn collect_class_static_assignments(source_text: &str) -> Vec<(String, String)> {
    let class_binding_regex = match regex::Regex::new(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b|class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };
    let assignment_regex =
        match regex::Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=") {
            Ok(regex) => regex,
            Err(_) => return Vec::new(),
        };

    let mut class_bindings = HashSet::new();
    for captures in class_binding_regex.captures_iter(source_text) {
        if let Some(capture) = captures.get(1).or_else(|| captures.get(2)) {
            class_bindings.insert(capture.as_str().to_string());
        }
    }

    let mut assignments = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let property_name = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        if class_bindings.contains(class_name) {
            assignments.push((class_name.to_string(), property_name.to_string()));
        }
    }

    assignments
}

fn apply_program_compat_transforms(program: &mut Program, context: &TranspileContext) {
    let mut commonjs_namespace_bindings = HashSet::new();
    if let Program::Module(module) = program {
        commonjs_namespace_bindings =
            rewrite_commonjs_imports(module, &context.commonjs_specifiers);
    }

    if !commonjs_namespace_bindings.is_empty() {
        program.visit_mut_with(&mut CommonJsNamespaceAccessVisitor::new(
            commonjs_namespace_bindings,
        ));
    }
    // Preserve global object properties discovered from the input graph so
    // helper-lowered globals stay stable across ADVANCED renaming.
    if !context.global_property_names.is_empty() {
        let aliases = collect_global_this_aliases(program);
        program.visit_mut_with(&mut GlobalThisPropertyCompatVisitor::new(
            context.global_property_names.clone(),
            aliases,
        ));
    }
    // Preserve statically discovered constructor/class properties that are
    // referenced across file and chunk boundaries.
    if !context.static_property_names.is_empty() {
        program.visit_mut_with(&mut StaticPropertyCompatVisitor::new(
            context.static_property_names.clone(),
        ));
    }
    // Preserve instance method names discovered from the analyzed program so
    // helper-generated reflective access stays coherent after renaming.
    if !context.instance_method_names.is_empty() {
        program.visit_mut_with(&mut InstanceMethodCompatVisitor::new(
            context.instance_method_names.clone(),
        ));
    }
    // Preserve protocol-style property names that are encoded in runtime
    // contracts rather than flowing through type information.
    program.visit_mut_with(&mut InternalProtocolMemberCompatVisitor);
    program.visit_mut_with(&mut DerivedClassMethodKeyCompatVisitor);
    program.visit_mut_with(&mut ConstantLikePropertyCompatVisitor);
    program.visit_mut_with(&mut UppercaseStaticMemberCompatVisitor);
    // Closure's goog.module body rejects raw throw statements, so rewrite them
    // into equivalent synchronous IIFEs in off-mode module output.
    if context.chunk_mode == ChunkMode::Off {
        program.visit_mut_with(&mut GoogModuleThrowRewriteVisitor);
    }
    program.visit_mut_with(&mut ObjectPatternParamVisitor::default());
}

fn apply_file_compat_transforms(
    program: &mut Program,
    file_path: &Path,
    context: &TranspileContext,
) {
    apply_program_compat_transforms(program, context);
    if context.chunk_mode == ChunkMode::BundlerRuntime {
        if let Some(lazy_imports) = context
            .lazy_imports_by_file
            .get(&file_path.to_string_lossy().to_string())
        {
            program.visit_mut_with(&mut DynamicImportRewriteVisitor::new(
                file_path,
                lazy_imports,
            ));
        }
    }
}

fn group_lazy_imports_by_file(
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

struct DynamicImportRewriteVisitor {
    importer_file_path: String,
    lazy_imports: HashMap<String, LazyImportInput>,
}

impl DynamicImportRewriteVisitor {
    fn new(file_path: &Path, lazy_imports: &[LazyImportInput]) -> Self {
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
                    value: lazy_import.moduleId.clone().into(),
                }))),
            }],
            type_args: None,
        });
    }
}

fn rewrite_bundler_runtime_namespace_usage(
    module: &mut Module,
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<(), String> {
    let dynamic_import_wrappers = collect_dynamic_import_wrappers(module);
    let promise_carriers = collect_dynamic_import_promise_carriers(module, &dynamic_import_wrappers);
    let mut visitor =
        BundlerRuntimeNamespaceVisitor::new(
            file_path,
            context,
            dynamic_import_wrappers,
            promise_carriers,
        );
    module.visit_mut_with(&mut visitor);
    if visitor.errors.is_empty() {
        Ok(())
    } else {
        Err(visitor.errors.join("\n"))
    }
}

#[derive(Clone, Debug, Default)]
struct DynamicImportWrappers {
    function_wrappers: HashMap<Id, BTreeSet<String>>,
    object_wrappers: HashMap<Id, BTreeMap<String, BTreeSet<String>>>,
}

fn collect_dynamic_import_promise_carriers(
    module: &Module,
    dynamic_import_wrappers: &DynamicImportWrappers,
) -> HashMap<Id, BTreeSet<String>> {
    let mut collector = PromiseCarrierCollector {
        carriers: HashMap::new(),
        dynamic_import_wrappers: dynamic_import_wrappers.clone(),
    };
    module.visit_with(&mut collector);
    collector.carriers
}

#[derive(Clone)]
struct PromiseCarrierCollector {
    carriers: HashMap<Id, BTreeSet<String>>,
    dynamic_import_wrappers: DynamicImportWrappers,
}

impl PromiseCarrierCollector {
    fn module_ids_for_promise_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Ident(ident) => self.carriers.get(&ident.to_id()).cloned(),
            Expr::Call(call_expr) => {
                if let Some(module_ids) = dynamic_import_module_ids_from_call(call_expr) {
                    return Some(module_ids);
                }
                let Callee::Expr(callee_expr) = &call_expr.callee else {
                    return None;
                };
                match &**callee_expr {
                    Expr::Ident(ident) if call_expr.args.is_empty() => self
                        .dynamic_import_wrappers
                        .function_wrappers
                        .get(&ident.to_id())
                        .cloned(),
                    Expr::Member(member) if call_expr.args.is_empty() => {
                        let Expr::Ident(object_ident) = &*member.obj else {
                            return None;
                        };
                        let wrapper_map = self
                            .dynamic_import_wrappers
                            .object_wrappers
                            .get(&object_ident.to_id())?;
                        let prop_name = member_prop_name(&member.prop);
                        if let Some(prop_name) = prop_name {
                            wrapper_map.get(&prop_name).cloned()
                        } else {
                            let mut module_ids = BTreeSet::new();
                            for ids in wrapper_map.values() {
                                module_ids.extend(ids.iter().cloned());
                            }
                            (!module_ids.is_empty()).then_some(module_ids)
                        }
                    }
                    _ if call_expr.args.len() == 1 => {
                        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
                            return None;
                        };
                        self.carriers.get(&carrier_ident.to_id()).cloned()
                    }
                    _ => None,
                }
            }
            Expr::Paren(paren) => self.module_ids_for_promise_expr(&paren.expr),
            _ => None,
        }
    }
}

impl Visit for PromiseCarrierCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);
        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        if let Some(module_ids) = self.module_ids_for_promise_expr(init) {
            self.carriers.insert(binding.id.to_id(), module_ids);
        }
    }

    fn visit_assign_expr(&mut self, assign_expr: &swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_children_with(self);
        let Some(module_ids) = self.module_ids_for_promise_expr(&assign_expr.right) else {
            return;
        };
        let swc_core::ecma::ast::AssignTarget::Simple(
            swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
        ) = &assign_expr.left
        else {
            return;
        };
        self.carriers.insert(binding.id.to_id(), module_ids);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        call_expr.visit_children_with(self);
        if call_expr.args.len() < 2 {
            return;
        }
        let Some(module_ids) = self.module_ids_for_promise_expr(&call_expr.args[1].expr) else {
            return;
        };
        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
            return;
        };
        self.carriers.insert(carrier_ident.to_id(), module_ids);
    }
}

fn collect_dynamic_import_wrappers(module: &Module) -> DynamicImportWrappers {
    let mut collector = DynamicImportWrapperCollector::default();
    module.visit_with(&mut collector);
    collector.wrappers
}

#[derive(Default)]
struct DynamicImportWrapperCollector {
    wrappers: DynamicImportWrappers,
}

impl Visit for DynamicImportWrapperCollector {
    fn visit_fn_decl(&mut self, function_decl: &swc_core::ecma::ast::FnDecl) {
        if let Some(module_ids) =
            extract_dynamic_import_module_ids_from_function(&function_decl.function)
        {
            self.wrappers
                .function_wrappers
                .insert(function_decl.ident.to_id(), module_ids);
        }
        function_decl.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        let Pat::Ident(binding) = &declarator.name else {
            declarator.visit_children_with(self);
            return;
        };
        if let Some(init) = declarator.init.as_deref() {
            if let Some(module_ids) = extract_dynamic_import_module_ids_from_expr(init) {
                self.wrappers
                    .function_wrappers
                    .insert(binding.id.to_id(), module_ids);
            } else if let Some(object_wrappers) = extract_dynamic_import_object_wrappers(init) {
                self.wrappers
                    .object_wrappers
                    .insert(binding.id.to_id(), object_wrappers);
            }
        }
        declarator.visit_children_with(self);
    }
}

fn extract_dynamic_import_module_ids_from_function(
    function: &swc_core::ecma::ast::Function,
) -> Option<BTreeSet<String>> {
    if !function.params.is_empty() {
        return None;
    }
    let body = function.body.as_ref()?;
    if body.stmts.len() != 1 {
        return None;
    }
    let Stmt::Return(return_stmt) = &body.stmts[0] else {
        return None;
    };
    let argument = return_stmt.arg.as_deref()?;
    extract_dynamic_import_module_ids_from_expr(argument)
}

fn extract_dynamic_import_module_ids_from_expr(expr: &Expr) -> Option<BTreeSet<String>> {
    match expr {
        Expr::Arrow(arrow) => extract_dynamic_import_module_ids_from_arrow(arrow),
        Expr::Fn(function_expr) => {
            extract_dynamic_import_module_ids_from_function(&function_expr.function)
        }
        Expr::Call(call_expr) => dynamic_import_module_ids_from_call(call_expr),
        Expr::Paren(paren) => extract_dynamic_import_module_ids_from_expr(&paren.expr),
        _ => None,
    }
}

fn extract_dynamic_import_module_ids_from_arrow(
    arrow: &ArrowExpr,
) -> Option<BTreeSet<String>> {
    if !arrow.params.is_empty() {
        return None;
    }
    match &*arrow.body {
        BlockStmtOrExpr::Expr(expr) => extract_dynamic_import_module_ids_from_expr(expr),
        BlockStmtOrExpr::BlockStmt(block) => {
            if block.stmts.len() != 1 {
                return None;
            }
            let Stmt::Return(return_stmt) = &block.stmts[0] else {
                return None;
            };
            let argument = return_stmt.arg.as_deref()?;
            extract_dynamic_import_module_ids_from_expr(argument)
        }
    }
}

fn extract_dynamic_import_object_wrappers(
    expr: &Expr,
) -> Option<BTreeMap<String, BTreeSet<String>>> {
    let Expr::Object(object) = expr else {
        return None;
    };
    let mut wrappers = BTreeMap::new();
    for prop in &object.props {
        let swc_core::ecma::ast::PropOrSpread::Prop(prop) = prop else {
            return None;
        };
        let swc_core::ecma::ast::Prop::KeyValue(key_value) = &**prop else {
            return None;
        };
        let prop_name = prop_name_to_string(&key_value.key)?;
        let module_ids = extract_dynamic_import_module_ids_from_expr(&key_value.value)?;
        wrappers.insert(prop_name, module_ids);
    }
    (!wrappers.is_empty()).then_some(wrappers)
}

fn dynamic_import_module_ids_from_call(
    call_expr: &CallExpr,
) -> Option<BTreeSet<String>> {
    let Callee::Expr(callee_expr) = &call_expr.callee else {
        return None;
    };
    let Expr::Ident(callee_ident) = &**callee_expr else {
        return None;
    };
    if callee_ident.sym != *"__dynamicImport" || call_expr.args.len() != 1 {
        return None;
    }
    let Expr::Lit(Lit::Str(module_id)) = &*call_expr.args[0].expr else {
        return None;
    };
    Some(BTreeSet::from([module_id.value.to_string_lossy().to_string()]))
}

struct BundlerRuntimeNamespaceVisitor<'a> {
    context: &'a TranspileContext,
    dynamic_import_wrappers: DynamicImportWrappers,
    errors: Vec<String>,
    file_path: String,
    namespace_bindings: HashMap<Id, BTreeSet<String>>,
    promise_carriers: HashMap<Id, BTreeSet<String>>,
}

impl<'a> BundlerRuntimeNamespaceVisitor<'a> {
    fn new(
        file_path: &Path,
        context: &'a TranspileContext,
        dynamic_import_wrappers: DynamicImportWrappers,
        promise_carriers: HashMap<Id, BTreeSet<String>>,
    ) -> Self {
        Self {
            context,
            dynamic_import_wrappers,
            errors: Vec::new(),
            file_path: file_path.display().to_string(),
            namespace_bindings: HashMap::new(),
            promise_carriers,
        }
    }

    fn push_error(&mut self, message: impl Into<String>) {
        self.errors.push(format!(
            "{}: {}",
            self.file_path,
            message.into()
        ));
    }

    fn module_ids_for_promise_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Ident(ident) => self.promise_carriers.get(&ident.to_id()).cloned(),
            Expr::Call(call_expr) => {
                if let Some(module_ids) = dynamic_import_module_ids_from_call(call_expr) {
                    return Some(module_ids);
                }
                let Callee::Expr(callee_expr) = &call_expr.callee else {
                    return None;
                };
                match &**callee_expr {
                    Expr::Ident(ident) if call_expr.args.is_empty() => self
                        .dynamic_import_wrappers
                        .function_wrappers
                        .get(&ident.to_id())
                        .cloned(),
                    Expr::Member(member) if call_expr.args.is_empty() => {
                        let Expr::Ident(object_ident) = &*member.obj else {
                            return None;
                        };
                        let wrapper_map = self
                            .dynamic_import_wrappers
                            .object_wrappers
                            .get(&object_ident.to_id())?;
                        let prop_name = member_prop_name(&member.prop);
                        if let Some(prop_name) = prop_name {
                            wrapper_map.get(&prop_name).cloned()
                        } else {
                            let mut module_ids = BTreeSet::new();
                            for ids in wrapper_map.values() {
                                module_ids.extend(ids.iter().cloned());
                            }
                            (!module_ids.is_empty()).then_some(module_ids)
                        }
                    }
                    _ if call_expr.args.len() == 1 => {
                        let Expr::Ident(carrier_ident) = &*call_expr.args[0].expr else {
                            return None;
                        };
                        self.promise_carriers.get(&carrier_ident.to_id()).cloned()
                    }
                    _ => None,
                }
            }
            Expr::Paren(paren) => self.module_ids_for_promise_expr(&paren.expr),
            _ => None,
        }
    }

    fn module_ids_for_namespace_expr(&self, expr: &Expr) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Ident(ident) => self.namespace_bindings.get(&ident.to_id()).cloned(),
            Expr::Await(await_expr) => self.module_ids_for_promise_expr(&await_expr.arg),
            Expr::Call(call_expr) if call_expr.args.len() == 1 => {
                let Expr::Ident(binding_ident) = &*call_expr.args[0].expr else {
                    return None;
                };
                self.namespace_bindings.get(&binding_ident.to_id()).cloned()
            }
            Expr::Paren(paren) => self.module_ids_for_namespace_expr(&paren.expr),
            _ => None,
        }
    }

    fn slot_for_module_ids(
        &self,
        module_ids: &BTreeSet<String>,
        export_name: &str,
    ) -> std::result::Result<usize, String> {
        let mut resolved_slot = None::<usize>;
        for module_id in module_ids {
            let Some(slots) = self.context.bundler_module_slots.get(module_id) else {
                return Err(format!(
                    "Missing bundler-runtime export slot metadata for {}",
                    module_id
                ));
            };
            let Some(slot) = slots.slot_for(export_name) else {
                return Err(format!(
                    "bundler-runtime cannot rewrite namespace access for export {:?} from {}",
                    export_name, module_id
                ));
            };
            if let Some(existing_slot) = resolved_slot {
                if existing_slot != slot {
                    return Err(format!(
                        "bundler-runtime cannot rewrite namespace access for export {:?} because slot assignments diverge across dynamic import targets",
                        export_name
                    ));
                }
            } else {
                resolved_slot = Some(slot);
            }
        }
        resolved_slot.ok_or_else(|| "Missing bundler-runtime namespace slots".to_string())
    }

    fn rewrite_namespace_pattern(
        &mut self,
        pattern: &mut Pat,
        module_ids: &BTreeSet<String>,
    ) -> bool {
        match pattern {
            Pat::Ident(binding) => {
                self.namespace_bindings
                    .insert(binding.id.to_id(), module_ids.clone());
                true
            }
            Pat::Object(object) => {
                for prop in &mut object.props {
                    match prop {
                        swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                            let Some(export_name) = prop_name_to_string(&key_value.key) else {
                                self.push_error(
                                    "bundler-runtime only supports literal namespace destructuring keys",
                                );
                                return false;
                            };
                            let Ok(slot) = self.slot_for_module_ids(module_ids, &export_name) else {
                                self.push_error(format!(
                                    "bundler-runtime cannot destructure namespace export {:?}",
                                    export_name
                                ));
                                return false;
                            };
                            key_value.key = PropName::Num(swc_core::ecma::ast::Number {
                                span: Default::default(),
                                value: slot as f64,
                                raw: None,
                            });
                        }
                        swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                            let export_name = assign.key.sym.to_string();
                            let Ok(slot) = self.slot_for_module_ids(module_ids, &export_name) else {
                                self.push_error(format!(
                                    "bundler-runtime cannot destructure namespace export {:?}",
                                    export_name
                                ));
                                return false;
                            };
                            *prop = swc_core::ecma::ast::ObjectPatProp::KeyValue(
                                swc_core::ecma::ast::KeyValuePatProp {
                                    key: PropName::Num(swc_core::ecma::ast::Number {
                                        span: Default::default(),
                                        value: slot as f64,
                                        raw: None,
                                    }),
                                    value: Box::new(Pat::Ident(BindingIdent {
                                        id: assign.key.clone().into(),
                                        type_ann: None,
                                    })),
                                },
                            );
                        }
                        swc_core::ecma::ast::ObjectPatProp::Rest(_) => {
                            self.push_error(
                                "bundler-runtime does not support namespace rest destructuring",
                            );
                            return false;
                        }
                    }
                }
                true
            }
            _ => {
                self.push_error(
                    "bundler-runtime only supports identifier and object destructuring for namespace values",
                );
                false
            }
        }
    }

    fn promise_module_ids_from_supplier_callback(
        &self,
        expr: &Expr,
    ) -> Option<BTreeSet<String>> {
        match expr {
            Expr::Arrow(arrow) if arrow.params.is_empty() => match &*arrow.body {
                BlockStmtOrExpr::Expr(body_expr) => self.module_ids_for_promise_expr(body_expr),
                BlockStmtOrExpr::BlockStmt(block) => {
                    if block.stmts.len() != 1 {
                        return None;
                    }
                    let Stmt::Return(return_stmt) = &block.stmts[0] else {
                        return None;
                    };
                    let argument = return_stmt.arg.as_deref()?;
                    self.module_ids_for_promise_expr(argument)
                }
            },
            Expr::Fn(function_expr) if function_expr.function.params.is_empty() => {
                let body = function_expr.function.body.as_ref()?;
                if body.stmts.len() != 1 {
                    return None;
                }
                let Stmt::Return(return_stmt) = &body.stmts[0] else {
                    return None;
                };
                let argument = return_stmt.arg.as_deref()?;
                self.module_ids_for_promise_expr(argument)
            }
            _ => None,
        }
    }

    fn visit_callback_expr_with_namespace_binding(
        &mut self,
        expr: &mut Expr,
        module_ids: &BTreeSet<String>,
        bind_first_param: bool,
    ) {
        match expr {
            Expr::Arrow(arrow) => {
                let target_pattern = if bind_first_param {
                    arrow.params.first_mut()
                } else {
                    arrow.params.last_mut()
                };
                let Some(target_pattern) = target_pattern else {
                    expr.visit_mut_with(self);
                    return;
                };
                let mut inserted = Vec::new();
                if let Pat::Ident(binding) = target_pattern {
                    let binding_id = binding.id.to_id();
                    self.namespace_bindings
                        .insert(binding_id.clone(), module_ids.clone());
                    inserted.push(binding_id);
                } else if !self.rewrite_namespace_pattern(target_pattern, module_ids) {
                    return;
                }
                match &mut *arrow.body {
                    BlockStmtOrExpr::Expr(body_expr) => body_expr.visit_mut_with(self),
                    BlockStmtOrExpr::BlockStmt(block) => block.visit_mut_with(self),
                }
                for binding_id in inserted {
                    self.namespace_bindings.remove(&binding_id);
                }
            }
            Expr::Fn(function_expr) => {
                let target_param = if bind_first_param {
                    function_expr.function.params.first_mut()
                } else {
                    function_expr.function.params.last_mut()
                };
                let Some(target_param) = target_param else {
                    expr.visit_mut_with(self);
                    return;
                };
                let mut inserted = Vec::new();
                if let Pat::Ident(binding) = &mut target_param.pat {
                    let binding_id = binding.id.to_id();
                    self.namespace_bindings
                        .insert(binding_id.clone(), module_ids.clone());
                    inserted.push(binding_id);
                } else if !self.rewrite_namespace_pattern(&mut target_param.pat, module_ids) {
                    return;
                }
                if let Some(body) = &mut function_expr.function.body {
                    body.visit_mut_with(self);
                }
                for binding_id in inserted {
                    self.namespace_bindings.remove(&binding_id);
                }
            }
            _ => expr.visit_mut_with(self),
        }
    }
}

impl VisitMut for BundlerRuntimeNamespaceVisitor<'_> {
    fn visit_mut_module_item(&mut self, item: &mut ModuleItem) {
        if let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = item {
            let module_id = resolve_module_id_for_specifier(
                Path::new(&self.file_path),
                &import_decl.src.value.to_string_lossy(),
                self.context,
            );
            if let Ok(module_id) = module_id {
                for specifier in &import_decl.specifiers {
                    if let ImportSpecifier::Namespace(namespace_specifier) = specifier {
                        self.namespace_bindings.insert(
                            namespace_specifier.local.to_id(),
                            BTreeSet::from([module_id.clone()]),
                        );
                    }
                }
            }
        }
        item.visit_mut_children_with(self);
    }

    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);

        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        if let Some(module_ids) = self.module_ids_for_namespace_expr(init) {
            let _ = self.rewrite_namespace_pattern(&mut declarator.name, &module_ids);
            return;
        }
        let Some(module_ids) = self.module_ids_for_promise_expr(init) else {
            return;
        };
        let Pat::Ident(binding) = &declarator.name else {
            self.push_error(
                "bundler-runtime only supports binding promise-like import values to identifiers",
            );
            return;
        };
        self.promise_carriers.insert(binding.id.to_id(), module_ids);
    }

    fn visit_mut_member_expr(&mut self, member_expr: &mut MemberExpr) {
        member_expr.obj.visit_mut_with(self);
        match &mut member_expr.prop {
            MemberProp::Computed(computed) => {
                computed.visit_mut_with(self);
            }
            MemberProp::PrivateName(_) => {}
            MemberProp::Ident(_) => {}
        }

        let Some(module_ids) = self.module_ids_for_namespace_expr(&member_expr.obj) else {
            return;
        };

        let Some(export_name) = member_prop_name(&member_expr.prop) else {
            self.push_error(
                "bundler-runtime does not support computed namespace property access",
            );
            return;
        };
        let slot = match self.slot_for_module_ids(&module_ids, &export_name) {
            Ok(slot) => slot,
            Err(message) => {
                self.push_error(message);
                return;
            }
        };
        member_expr.prop = MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Num(swc_core::ecma::ast::Number {
                span: Default::default(),
                value: slot as f64,
                raw: None,
            }))),
        });
    }

    fn visit_mut_call_expr(&mut self, call_expr: &mut CallExpr) {
        let promise_from_then = if let Callee::Expr(callee_expr) = &call_expr.callee {
            if let Expr::Member(member) = &**callee_expr {
                if matches!(member_prop_name(&member.prop).as_deref(), Some("then")) {
                    self.module_ids_for_promise_expr(&member.obj)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        let promise_source_indices = call_expr
            .args
            .iter()
            .enumerate()
            .filter_map(|(index, arg)| {
                self.promise_module_ids_from_supplier_callback(&arg.expr)
                    .map(|module_ids| (index, module_ids))
            })
            .collect::<Vec<_>>();

        match &mut call_expr.callee {
            Callee::Expr(expr) => expr.visit_mut_with(self),
            _ => {}
        }
        for (index, arg) in call_expr.args.iter_mut().enumerate() {
            if index == 0 {
                if let Some(module_ids) = &promise_from_then {
                    self.visit_callback_expr_with_namespace_binding(
                        &mut arg.expr,
                        module_ids,
                        true,
                    );
                    continue;
                }
            }
            if let Some((_, module_ids)) = promise_source_indices
                .iter()
                .find(|(source_index, _)| *source_index != index)
            {
                self.visit_callback_expr_with_namespace_binding(
                    &mut arg.expr,
                    module_ids,
                    false,
                );
                continue;
            }
            arg.expr.visit_mut_with(self);
        }

        if let Callee::Expr(callee_expr) = &call_expr.callee {
            if let Expr::Member(member) = &**callee_expr {
                if matches!(&*member.obj, Expr::Ident(object_ident) if object_ident.sym == *"Object") {
                    if let Some(method_name) = member_prop_name(&member.prop) {
                        if matches!(method_name.as_str(), "assign" | "entries" | "keys" | "values") {
                            if call_expr.args.iter().any(|arg| {
                                matches!(&*arg.expr, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
                            }) {
                                self.push_error(
                                    "bundler-runtime does not support reflective Object.* operations on module namespace values",
                                );
                            }
                        }
                    }
                }
            }
        }

        let is_namespace_passthrough_call =
            call_expr.args.len() == 1
                && matches!(
                    &*call_expr.args[0].expr,
                    Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id())
                );
        if !is_namespace_passthrough_call
            && call_expr.args.iter().any(|arg| {
                matches!(&*arg.expr, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id()))
            })
        {
            self.push_error(
                "bundler-runtime does not support passing module namespace values to calls",
            );
        }
    }

    fn visit_mut_return_stmt(&mut self, return_stmt: &mut swc_core::ecma::ast::ReturnStmt) {
        return_stmt.visit_mut_children_with(self);
        if let Some(argument) = &return_stmt.arg {
            if matches!(&**argument, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id())) {
                self.push_error(
                    "bundler-runtime does not support returning module namespace values",
                );
            }
        }
    }

    fn visit_mut_assign_expr(&mut self, assign_expr: &mut swc_core::ecma::ast::AssignExpr) {
        assign_expr.visit_mut_children_with(self);
        if let Some(module_ids) = self.module_ids_for_promise_expr(&assign_expr.right) {
            if let swc_core::ecma::ast::AssignTarget::Simple(
                swc_core::ecma::ast::SimpleAssignTarget::Ident(binding),
            ) = &assign_expr.left
            {
                self.promise_carriers.insert(binding.id.to_id(), module_ids);
                return;
            }
        }
        if matches!(&*assign_expr.right, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id())) {
            self.push_error(
                "bundler-runtime does not support reassigning or storing module namespace values",
            );
        }
    }

    fn visit_mut_for_in_stmt(&mut self, for_in_stmt: &mut swc_core::ecma::ast::ForInStmt) {
        for_in_stmt.visit_mut_children_with(self);
        if matches!(&*for_in_stmt.right, Expr::Ident(ident) if self.namespace_bindings.contains_key(&ident.to_id())) {
            self.push_error(
                "bundler-runtime does not support iterating over module namespace values",
            );
        }
    }
}

struct StaticPropertyCompatVisitor {
    property_names: HashSet<String>,
}

impl StaticPropertyCompatVisitor {
    fn new(property_names: HashSet<String>) -> Self {
        Self { property_names }
    }
}

impl VisitMut for StaticPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !self.property_names.contains(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }
}

struct InstanceMethodCompatVisitor {
    method_names: HashSet<String>,
}

impl InstanceMethodCompatVisitor {
    fn new(method_names: HashSet<String>) -> Self {
        Self { method_names }
    }
}

impl VisitMut for InstanceMethodCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        match expr {
            Expr::Member(member) => {
                if member.prop.is_computed() {
                    return;
                }
                let Expr::This(_) = &*member.obj else {
                    return;
                };
                let MemberProp::Ident(prop_ident) = &member.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
            }
            Expr::SuperProp(super_prop) => {
                let SuperProp::Ident(prop_ident) = &super_prop.prop else {
                    return;
                };
                if !self.method_names.contains(prop_ident.sym.as_ref()) {
                    return;
                }

                super_prop.prop = create_string_computed_super_prop(prop_ident.sym.as_ref());
            }
            _ => {}
        }
    }
}

struct GlobalThisAliasCollector {
    aliases: HashSet<String>,
}

impl Visit for GlobalThisAliasCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        declarator.visit_children_with(self);

        let Pat::Ident(binding) = &declarator.name else {
            return;
        };
        let Some(init) = &declarator.init else {
            return;
        };
        let Expr::Ident(ident) = &**init else {
            return;
        };
        if self.aliases.contains(ident.sym.as_ref()) {
            self.aliases.insert(binding.id.sym.to_string());
        }
    }
}

fn collect_global_this_aliases(program: &Program) -> HashSet<String> {
    let mut collector = GlobalThisAliasCollector {
        aliases: HashSet::from(["globalThis".to_string()]),
    };
    program.visit_with(&mut collector);
    collector.aliases
}

struct GlobalThisPropertyCompatVisitor {
    aliases: HashSet<String>,
    property_names: HashSet<String>,
}

impl GlobalThisPropertyCompatVisitor {
    fn new(property_names: HashSet<String>, aliases: HashSet<String>) -> Self {
        Self {
            aliases,
            property_names,
        }
    }
}

impl VisitMut for GlobalThisPropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if self.aliases.contains(object_ident.sym.as_ref())
            && self.property_names.contains(prop_ident.sym.as_ref())
        {
            member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
        }
    }
}

struct ConstantLikePropertyCompatVisitor;

struct InternalProtocolMemberCompatVisitor;

fn is_internal_protocol_name(name: &str) -> bool {
    name.starts_with('_') || name.contains('$')
}

impl VisitMut for InternalProtocolMemberCompatVisitor {
    fn visit_mut_member_expr(&mut self, member: &mut MemberExpr) {
        member.visit_mut_children_with(self);

        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_internal_protocol_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_internal_protocol_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }

    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method)
                    if prop_name_to_string(&method.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::ClassProp(prop)
                    if prop_name_to_string(&prop.key)
                        .map(|name| is_internal_protocol_name(&name))
                        .unwrap_or(false) =>
                {
                    prop.key = quote_prop_name(prop.key.clone());
                }
                _ => {}
            }
        }
    }
}

impl VisitMut for ConstantLikePropertyCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_constant_like_property_name(prop_ident.sym.as_ref()) {
            return;
        }

        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }

    fn visit_mut_prop_name(&mut self, prop_name: &mut PropName) {
        prop_name.visit_mut_children_with(self);

        let PropName::Ident(ident) = prop_name else {
            return;
        };
        if !is_constant_like_property_name(ident.sym.as_ref()) {
            return;
        }

        *prop_name = PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        });
    }
}

struct UppercaseStaticMemberCompatVisitor;

impl VisitMut for UppercaseStaticMemberCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        if !is_component_like_name(object_ident.sym.as_ref())
            || !is_component_like_name(prop_ident.sym.as_ref())
        {
            return;
        }

        member.prop = MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
            span: Default::default(),
            expr: Box::new(Expr::Lit(Lit::Str(Str {
                span: Default::default(),
                value: prop_ident.sym.to_string().into(),
                raw: None,
            }))),
        });
    }
}

struct DerivedClassMethodKeyCompatVisitor;

impl VisitMut for DerivedClassMethodKeyCompatVisitor {
    fn visit_mut_class(&mut self, class: &mut swc_core::ecma::ast::Class) {
        class.visit_mut_children_with(self);
        if class.super_class.is_none() {
            return;
        }
        for member in &mut class.body {
            match member {
                swc_core::ecma::ast::ClassMember::Method(method) => {
                    method.key = quote_prop_name(method.key.clone());
                }
                swc_core::ecma::ast::ClassMember::PrivateMethod(_) => {}
                swc_core::ecma::ast::ClassMember::ClassProp(prop) => {
                    if !prop.is_static {
                        prop.key = quote_prop_name(prop.key.clone());
                    }
                }
                _ => {}
            }
        }
    }
}

struct CommonJsNamespaceAccessVisitor {
    bindings: HashSet<String>,
}

impl CommonJsNamespaceAccessVisitor {
    fn new(bindings: HashSet<String>) -> Self {
        Self { bindings }
    }
}

impl VisitMut for CommonJsNamespaceAccessVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        let Expr::Member(member) = expr else {
            return;
        };
        if member.prop.is_computed() {
            return;
        }
        let Expr::Ident(object_ident) = &*member.obj else {
            return;
        };
        if !self.bindings.contains(object_ident.sym.as_ref()) {
            return;
        }
        let MemberProp::Ident(prop_ident) = &member.prop else {
            return;
        };
        member.prop = create_string_computed_prop(prop_ident.sym.as_ref());
    }
}

struct GoogModuleThrowRewriteVisitor;

impl VisitMut for GoogModuleThrowRewriteVisitor {
    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        let Stmt::Throw(throw_stmt) = stmt else {
            return;
        };
        let argument = mem::replace(
            &mut throw_stmt.arg,
            Box::new(Expr::Invalid(Default::default())),
        );
        *stmt = create_throw_iife_statement(argument);
    }
}

fn create_throw_iife_statement(argument: Box<Expr>) -> Stmt {
    let throw_arrow = Expr::Arrow(ArrowExpr {
        span: Default::default(),
        ctxt: Default::default(),
        params: Vec::new(),
        body: Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
            span: Default::default(),
            ctxt: Default::default(),
            stmts: vec![Stmt::Throw(swc_core::ecma::ast::ThrowStmt {
                span: Default::default(),
                arg: argument,
            })],
        })),
        is_async: false,
        is_generator: false,
        return_type: None,
        type_params: None,
    });
    Stmt::Expr(ExprStmt {
        span: Default::default(),
        expr: Box::new(Expr::Call(CallExpr {
            span: Default::default(),
            ctxt: Default::default(),
            callee: Callee::Expr(Box::new(Expr::Paren(swc_core::ecma::ast::ParenExpr {
                span: Default::default(),
                expr: Box::new(throw_arrow),
            }))),
            args: Vec::new(),
            type_args: None,
        })),
    })
}

fn rewrite_commonjs_imports(
    module: &mut Module,
    commonjs_specifiers: &HashSet<String>,
) -> HashSet<String> {
    if commonjs_specifiers.is_empty() {
        return HashSet::new();
    }

    let mut import_counter = 0usize;
    let mut next_body = Vec::with_capacity(module.body.len());
    let mut namespace_bindings = HashSet::new();

    for item in module.body.drain(..) {
        let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) = &item
        else {
            next_body.push(item);
            continue;
        };

        let specifier = import_decl.src.value.to_string_lossy().to_string();
        if !commonjs_specifiers.contains(&specifier) {
            next_body.push(item);
            continue;
        }

        let (rewritten_items, bindings) =
            rewrite_commonjs_import_decl(import_decl, &specifier, &mut import_counter);
        namespace_bindings.extend(bindings);
        if rewritten_items.is_empty() {
            next_body.push(item);
        } else {
            next_body.extend(rewritten_items);
        }
    }

    module.body = next_body;
    namespace_bindings
}

fn rewrite_commonjs_import_decl(
    import_decl: &ImportDecl,
    specifier: &str,
    import_counter: &mut usize,
) -> (Vec<ModuleItem>, HashSet<String>) {
    let mut default_local: Option<String> = None;
    let mut namespace_local: Option<String> = None;
    let mut named_bindings: Vec<(String, String)> = Vec::new();

    for import_specifier in &import_decl.specifiers {
        match import_specifier {
            ImportSpecifier::Default(default_specifier) => {
                default_local = Some(default_specifier.local.sym.to_string());
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                namespace_local = Some(namespace_specifier.local.sym.to_string());
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported = match &named_specifier.imported {
                    Some(swc_core::ecma::ast::ModuleExportName::Ident(ident)) => {
                        ident.sym.to_string()
                    }
                    Some(swc_core::ecma::ast::ModuleExportName::Str(string)) => {
                        string.value.to_string_lossy().to_string()
                    }
                    None => named_specifier.local.sym.to_string(),
                };
                named_bindings.push((imported, named_specifier.local.sym.to_string()));
            }
        }
    }

    if namespace_local.is_none() && named_bindings.is_empty() {
        return (Vec::new(), HashSet::new());
    }

    let helper_name = default_local.clone().unwrap_or_else(|| {
        let helper = format!("__cjs_import_{import_counter}");
        *import_counter += 1;
        helper
    });

    let mut items = vec![create_default_import_item(&helper_name, specifier)];
    let mut bindings = HashSet::new();
    bindings.insert(helper_name.clone());

    if let Some(namespace_binding) = namespace_local {
        if namespace_binding != helper_name {
            items.push(create_const_alias_item(&namespace_binding, &helper_name));
        }
        bindings.insert(namespace_binding);
    }

    if !named_bindings.is_empty() {
        items.push(create_named_destructure_item(&helper_name, &named_bindings));
    }

    (items, bindings)
}

fn create_default_import_item(local_name: &str, specifier: &str) -> ModuleItem {
    ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(ImportDecl {
        specifiers: vec![ImportSpecifier::Default(ImportDefaultSpecifier {
            local: create_ident(local_name),
            span: Default::default(),
        })],
        src: Box::new(Str {
            span: Default::default(),
            value: specifier.into(),
            raw: None,
        }),
        type_only: false,
        with: None,
        phase: Default::default(),
        span: Default::default(),
    }))
}

fn create_const_alias_item(local_name: &str, target_name: &str) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(
        VarDecl {
            kind: VarDeclKind::Const,
            span: Default::default(),
            ctxt: Default::default(),
            declare: false,
            decls: vec![VarDeclarator {
                span: Default::default(),
                definite: false,
                name: Pat::Ident(BindingIdent {
                    id: create_ident(local_name),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Ident(create_ident(target_name)))),
            }],
        },
    ))))
}

fn create_named_destructure_item(source_name: &str, bindings: &[(String, String)]) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(
        VarDecl {
            kind: VarDeclKind::Const,
            span: Default::default(),
            ctxt: Default::default(),
            declare: false,
            decls: bindings
                .iter()
                .map(|(imported, local)| VarDeclarator {
                    span: Default::default(),
                    definite: false,
                    name: Pat::Ident(BindingIdent {
                        id: create_ident(local),
                        type_ann: None,
                    }),
                    init: Some(Box::new(Expr::Member(MemberExpr {
                        span: Default::default(),
                        obj: Box::new(Expr::Ident(create_ident(source_name))),
                        prop: create_string_computed_prop(imported),
                    }))),
                })
                .collect(),
        },
    ))))
}

fn create_ident(value: &str) -> Ident {
    Ident::new(value.into(), Default::default(), Default::default())
}

fn create_rename_property_expr(property_name: &str, object_name: &str) -> Expr {
    create_rename_property_expr_for_object(property_name, Expr::Ident(create_ident(object_name)))
}

fn create_rename_property_expr_for_object(property_name: &str, object_expr: Expr) -> Expr {
    Expr::Call(CallExpr {
        span: Default::default(),
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
            span: Default::default(),
            obj: Box::new(Expr::Member(MemberExpr {
                span: Default::default(),
                obj: Box::new(Expr::Ident(create_ident("goog"))),
                prop: MemberProp::Ident(create_ident("reflect").into()),
            })),
            prop: MemberProp::Ident(create_ident("objectProperty").into()),
        }))),
        args: vec![
            swc_core::ecma::ast::ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    span: Default::default(),
                    value: property_name.into(),
                    raw: None,
                }))),
            },
            swc_core::ecma::ast::ExprOrSpread {
                spread: None,
                expr: Box::new(object_expr),
            },
        ],
        type_args: None,
    })
}

#[derive(Default)]
struct ObjectPatternParamVisitor;

impl VisitMut for ObjectPatternParamVisitor {
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        items.visit_mut_children_with(self);

        for item in items {
            let ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) =
                item
            else {
                continue;
            };

            match &mut export_decl.decl {
                swc_core::ecma::ast::Decl::Fn(function_decl)
                    if is_component_like_name(function_decl.ident.sym.as_ref()) =>
                {
                    rewrite_function_like_component(&mut function_decl.function);
                }
                swc_core::ecma::ast::Decl::Var(var_decl) => {
                    for declarator in &mut var_decl.decls {
                        let Pat::Ident(binding) = &declarator.name else {
                            continue;
                        };
                        if !is_component_like_name(binding.id.sym.as_ref()) {
                            continue;
                        }
                        if let Some(init) = &mut declarator.init {
                            match &mut **init {
                                Expr::Arrow(arrow) => rewrite_arrow_component(arrow),
                                Expr::Fn(function_expr) => {
                                    rewrite_function_like_component(&mut function_expr.function)
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn visit_mut_stmt(&mut self, stmt: &mut Stmt) {
        stmt.visit_mut_children_with(self);

        match stmt {
            Stmt::Decl(swc_core::ecma::ast::Decl::Fn(function_decl)) => {
                if is_component_like_name(function_decl.ident.sym.as_ref()) {
                    rewrite_function_like_component(&mut function_decl.function);
                }
            }
            Stmt::Decl(swc_core::ecma::ast::Decl::Var(var_decl)) => {
                for declarator in &mut var_decl.decls {
                    let Pat::Ident(binding) = &declarator.name else {
                        continue;
                    };
                    if !is_component_like_name(binding.id.sym.as_ref()) {
                        continue;
                    }
                    if let Some(init) = &mut declarator.init {
                        match &mut **init {
                            Expr::Arrow(arrow) => rewrite_arrow_component(arrow),
                            Expr::Fn(function_expr) => {
                                rewrite_function_like_component(&mut function_expr.function)
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn is_component_like_name(value: &str) -> bool {
    value
        .chars()
        .next()
        .map(|character| character.is_ascii_uppercase())
        .unwrap_or(false)
}

fn is_constant_like_property_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_uppercase() {
        return false;
    }
    value.chars().all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    })
}

fn rewrite_function_like_component(function: &mut swc_core::ecma::ast::Function) {
    let Some(first_param) = function.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = &first_param.pat else {
        return;
    };

    let props_ident = create_ident("__props");
    let setup_stmts = build_component_prop_setup(object_pat, "__props").unwrap_or_else(|| {
        vec![create_props_destructure_stmt(
            quote_object_pattern_keys(object_pat.clone()),
            &props_ident,
        )]
    });
    first_param.pat = Pat::Ident(BindingIdent {
        id: props_ident.clone(),
        type_ann: None,
    });

    if let Some(body) = &mut function.body {
        body.stmts.splice(0..0, setup_stmts);
    }
}

fn rewrite_arrow_component(arrow: &mut ArrowExpr) {
    let Some(first_param) = arrow.params.first_mut() else {
        return;
    };
    let Pat::Object(object_pat) = first_param else {
        return;
    };

    let props_ident = create_ident("__props");
    let setup_stmts = build_component_prop_setup(object_pat, "__props").unwrap_or_else(|| {
        vec![create_props_destructure_stmt(
            quote_object_pattern_keys(object_pat.clone()),
            &props_ident,
        )]
    });
    *first_param = Pat::Ident(BindingIdent {
        id: props_ident.clone(),
        type_ann: None,
    });

    match &mut *arrow.body {
        BlockStmtOrExpr::BlockStmt(block) => {
            block.stmts.splice(0..0, setup_stmts);
        }
        BlockStmtOrExpr::Expr(expression) => {
            let return_stmt = Stmt::Return(swc_core::ecma::ast::ReturnStmt {
                span: Default::default(),
                arg: Some(expression.clone()),
            });
            arrow.body = Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: Default::default(),
                ctxt: Default::default(),
                stmts: setup_stmts.into_iter().chain([return_stmt]).collect(),
            }));
        }
    }
}

fn create_props_destructure_stmt(
    object_pat: swc_core::ecma::ast::ObjectPat,
    props_ident: &Ident,
) -> Stmt {
    Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(VarDecl {
        kind: VarDeclKind::Const,
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        decls: vec![VarDeclarator {
            span: Default::default(),
            definite: false,
            name: Pat::Object(object_pat),
            init: Some(Box::new(Expr::Ident(props_ident.clone()))),
        }],
    })))
}

fn quote_object_pattern_keys(
    object_pat: swc_core::ecma::ast::ObjectPat,
) -> swc_core::ecma::ast::ObjectPat {
    swc_core::ecma::ast::ObjectPat {
        props: object_pat
            .props
            .into_iter()
            .map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(
                        swc_core::ecma::ast::KeyValuePatProp {
                            key: PropName::Str(Str {
                                span: Default::default(),
                                value: assign.key.sym.to_string().into(),
                                raw: None,
                            }),
                            value: Box::new(match assign.value {
                                Some(value) => Pat::Assign(swc_core::ecma::ast::AssignPat {
                                    span: assign.span,
                                    left: Box::new(Pat::Ident(assign.key)),
                                    right: value,
                                }),
                                None => Pat::Ident(assign.key),
                            }),
                        },
                    )
                }
                swc_core::ecma::ast::ObjectPatProp::KeyValue(mut key_value) => {
                    key_value.key = quote_prop_name(key_value.key);
                    if let Pat::Object(nested) = *key_value.value.clone() {
                        key_value.value = Box::new(Pat::Object(quote_object_pattern_keys(nested)));
                    }
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value)
                }
                other => other,
            })
            .collect(),
        ..object_pat
    }
}

fn build_component_prop_setup(
    object_pat: &swc_core::ecma::ast::ObjectPat,
    props_name: &str,
) -> Option<Vec<Stmt>> {
    let mut statements = Vec::new();
    let mut omitted_keys = Vec::new();
    let mut rest_name: Option<String> = None;

    for prop in &object_pat.props {
        match prop {
            swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                if assign.value.is_some() {
                    return None;
                }
                let key = assign.key.sym.to_string();
                omitted_keys.push(key.clone());
                statements.push(create_component_prop_read_stmt(
                    &assign.key.sym.to_string(),
                    &assign.key.sym.to_string(),
                    props_name,
                ));
            }
            swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                let key = match &key_value.key {
                    PropName::Ident(ident) => ident.sym.to_string(),
                    PropName::Str(value) => value.value.to_string_lossy().to_string(),
                    _ => return None,
                };
                let Pat::Ident(binding) = &*key_value.value else {
                    return None;
                };
                omitted_keys.push(key.clone());
                statements.push(create_component_prop_read_stmt(
                    &key,
                    &binding.id.sym.to_string(),
                    props_name,
                ));
            }
            swc_core::ecma::ast::ObjectPatProp::Rest(rest) => {
                let Pat::Ident(binding) = &*rest.arg else {
                    return None;
                };
                rest_name = Some(binding.id.sym.to_string());
            }
        }
    }

    if let Some(rest_name) = rest_name {
        statements.extend(create_rest_props_stmts(
            &rest_name,
            props_name,
            &omitted_keys,
        )?);
    }

    Some(statements)
}

fn create_component_prop_read_stmt(key: &str, local_name: &str, props_name: &str) -> Stmt {
    Stmt::Decl(swc_core::ecma::ast::Decl::Var(Box::new(VarDecl {
        kind: VarDeclKind::Const,
        span: Default::default(),
        ctxt: Default::default(),
        declare: false,
        decls: vec![VarDeclarator {
            span: Default::default(),
            definite: false,
            name: Pat::Ident(BindingIdent {
                id: create_ident(local_name),
                type_ann: None,
            }),
            init: Some(Box::new(Expr::Member(MemberExpr {
                span: Default::default(),
                obj: Box::new(Expr::Ident(create_ident(props_name))),
                prop: MemberProp::Computed(swc_core::ecma::ast::ComputedPropName {
                    span: Default::default(),
                    expr: Box::new(create_rename_property_expr(key, props_name)),
                }),
            }))),
        }],
    })))
}

fn create_rest_props_stmts(
    rest_name: &str,
    props_name: &str,
    omitted_keys: &[String],
) -> Option<Vec<Stmt>> {
    let conditions = omitted_keys
        .iter()
        .map(|key| format!("key !== goog.reflect.objectProperty({key:?}, {props_name})"))
        .collect::<Vec<_>>()
        .join(" && ");
    let guard = if conditions.is_empty() {
        "true".to_string()
    } else {
        conditions
    };
    let snippet = format!(
        "const {rest_name} = /** @dict */ ({{}});\nfor (const key in {props_name}) {{ if ({guard}) {rest_name}[key] = {props_name}[key]; }}"
    );
    let items = parse_module_items(&snippet).ok()?;
    let mut statements = Vec::with_capacity(items.len());
    for item in items {
        let ModuleItem::Stmt(statement) = item else {
            return None;
        };
        statements.push(statement);
    }
    Some(statements)
}

fn quote_prop_name(prop_name: PropName) -> PropName {
    match prop_name {
        PropName::Ident(ident) => PropName::Str(Str {
            span: Default::default(),
            value: ident.sym.to_string().into(),
            raw: None,
        }),
        PropName::Num(number) => PropName::Str(Str {
            span: Default::default(),
            value: number.value.to_string().into(),
            raw: None,
        }),
        other => other,
    }
}

fn transform_program(
    module: swc_core::ecma::ast::Module,
    file_path: &Path,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<Program, String> {
    let safe_enums = file_metadata
        .map(|metadata| {
            metadata
                .enum_declarations
                .iter()
                .map(|enum_decl| enum_decl.name.clone())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let module = remove_closure_safe_enums(module, &safe_enums);
    let mut enum_literal_values = collect_ts_enum_literal_values(&module);
    enum_literal_values.extend(collect_imported_ts_enum_literal_values(&module, file_path));
    let mut program = Program::Module(module);
    let cm: Lrc<SourceMap> = Default::default();
    let resolver_marks = if should_run_resolver(file_path) {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        resolver(unresolved_mark, top_level_mark, true).process(&mut program);
        Some((unresolved_mark, top_level_mark))
    } else {
        None
    };
    let unresolved_ctxt = resolver_marks
        .map(|(unresolved_mark, _)| {
            swc_core::common::SyntaxContext::empty().apply_mark(unresolved_mark)
        })
        .unwrap_or_else(swc_core::common::SyntaxContext::empty);
    let compat_property_names =
        collect_global_this_compat_property_names(&program, unresolved_ctxt);
    if !compat_property_names.is_empty() {
        program.visit_mut_with(&mut GlobalThisCompatVisitor::new(
            compat_property_names,
            unresolved_ctxt,
        )?);
    }
    if let Some((unresolved_mark, top_level_mark)) = resolver_marks {
        if should_run_react_transform(file_path) {
            jsx(
                cm,
                None::<swc_core::common::comments::SingleThreadedComments>,
                ReactOptions {
                    runtime: Some(ReactRuntime::Classic),
                    development: Some(false),
                    ..Default::default()
                },
                top_level_mark,
                unresolved_mark,
            )
            .process(&mut program);
        }
        strip(unresolved_mark, top_level_mark).process(&mut program);
    }
    if !enum_literal_values.is_empty() {
        program.visit_mut_with(&mut EnumValueInlineVisitor::new(enum_literal_values));
    }
    apply_file_compat_transforms(&mut program, file_path, context);
    Ok(program)
}

fn remove_closure_safe_enums(module: Module, safe_enums: &HashSet<String>) -> Module {
    if safe_enums.is_empty() {
        return module;
    }

    Module {
        body: module
            .body
            .into_iter()
            .filter(|item| match item {
                ModuleItem::Stmt(Stmt::Decl(swc_core::ecma::ast::Decl::TsEnum(enum_decl))) => {
                    !safe_enums.contains(enum_decl.id.sym.as_ref())
                }
                ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(
                    export_decl,
                )) => match &export_decl.decl {
                    swc_core::ecma::ast::Decl::TsEnum(enum_decl) => {
                        !safe_enums.contains(enum_decl.id.sym.as_ref())
                    }
                    _ => true,
                },
                _ => true,
            })
            .collect(),
        ..module
    }
}

fn print_program(program: &Program) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default(),
            cm,
            comments: None,
            wr: writer,
        };
        emitter
            .emit_program(program)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn print_module_item(item: ModuleItem) -> std::result::Result<String, String> {
    print_program(&Program::Module(Module {
        body: vec![item],
        shebang: None,
        span: Default::default(),
    }))
}

fn print_statement(statement: Stmt) -> std::result::Result<String, String> {
    print_module_item(ModuleItem::Stmt(statement))
}

fn print_expression(expression: Expr) -> std::result::Result<String, String> {
    let printed = print_statement(Stmt::Expr(ExprStmt {
        expr: Box::new(expression),
        span: Default::default(),
    }))?;
    Ok(printed.trim().trim_end_matches(';').to_string())
}

fn emit_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    match context.chunk_mode {
        ChunkMode::BundlerRuntime => emit_bundler_runtime_module_program(
            file_path,
            program,
            context,
            file_metadata,
            commonjs_export_name,
        ),
        ChunkMode::Off => emit_goog_module_program(
            file_path,
            program,
            context,
            file_metadata,
            commonjs_export_name,
        ),
    }
}

fn emit_goog_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let Program::Module(module) = program else {
        return Err("Expected module program".to_string());
    };
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let mut output = vec![format!("goog.module({module_id:?});")];

    if let Some(metadata) = file_metadata {
        for type_decl in &metadata.type_declarations {
            output.push(type_decl.snippet.trim().to_string());
        }
        for enum_decl in &metadata.enum_declarations {
            output.push(render_closure_enum(enum_decl));
            if enum_decl.exported {
                output.push(format!("exports.{} = {};", enum_decl.name, enum_decl.name));
            }
        }
    }

    let mut import_counter = 0usize;
    let mut export_counter = 0usize;

    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                output.extend(convert_import_decl(
                    file_path,
                    &import_decl,
                    context,
                    &mut import_counter,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(print_statement(Stmt::Decl(export_decl.decl))?);
                for export_name in exported_names {
                    output.push(format!("exports.{export_name} = {export_name};"));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                output.extend(convert_named_export(
                    file_path,
                    &named_export,
                    context,
                    &mut export_counter,
                )?);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = format!("__goog_default_export_{export_counter}");
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                output.push(format!("exports.default = {local_name};"));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let local_name = function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__goog_default_export_{export_counter}"));
                    export_counter += 1;
                    if function_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                            swc_core::ecma::ast::FnDecl {
                                declare: false,
                                function: function_expr.function,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            },
                        )))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                    output.push(format!("exports.default = {local_name};"));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let local_name = class_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__goog_default_export_{export_counter}"));
                    export_counter += 1;
                    if class_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(
                            swc_core::ecma::ast::Decl::Class(swc_core::ecma::ast::ClassDecl {
                                class: class_expr.class,
                                declare: false,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            }),
                        ))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Class(class_expr))?
                        ));
                    }
                    output.push(format!("exports.default = {local_name};"));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name = format!("__goog_export_all_{export_counter}");
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                output.push(format!(
                    "const {require_name} = goog.require({export_module_id:?});"
                ));
                output.push(format!(
                    "for (const key in {require_name}) {{ if (key !== \"default\") {{ exports[key] = {require_name}[key]; }} }}"
                ));
            }
            ModuleItem::Stmt(statement) => {
                output.push(print_statement(statement)?);
            }
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        output.push(format!("exports.{export_name} = {export_name};"));
        output.push(format!("exports.default = {export_name};"));
    }

    let mut source_text = output
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(metadata) = file_metadata {
        source_text = attach_top_level_docs(source_text, &metadata.top_level_docs);
    }
    Ok(apply_js_compat_text_fixes(source_text))
}

fn emit_bundler_runtime_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    let Program::Module(mut module) = program else {
        return Err("Expected module program".to_string());
    };
    let module_id = to_goog_module_id(file_path, &context.workspace_dir);
    let current_slots = context
        .bundler_module_slots
        .get(&module_id)
        .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
    rewrite_bundler_runtime_namespace_usage(&mut module, file_path, context)?;
    let mut output = Vec::new();
    let mut dependency_ids = Vec::new();
    let mut import_counter = 0usize;
    let mut export_counter = 0usize;

    if let Some(metadata) = file_metadata {
        for type_decl in &metadata.type_declarations {
            output.push(type_decl.snippet.trim().to_string());
        }
        for enum_decl in &metadata.enum_declarations {
            output.push(render_closure_enum(enum_decl));
            if enum_decl.exported {
                let slot = current_slots.slot_for(&enum_decl.name).ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for {} in {}",
                        enum_decl.name, module_id
                    )
                })?;
                output.push(render_module_export_slot(slot, &enum_decl.name));
            }
        }
    }

    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::Import(import_decl)) => {
                let (lines, deps) = convert_bundler_import_decl(
                    file_path,
                    &import_decl,
                    context,
                    &mut import_counter,
                )?;
                output.extend(lines);
                dependency_ids.extend(deps);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDecl(export_decl)) => {
                let exported_names = exported_decl_names(&export_decl.decl);
                output.push(print_statement(Stmt::Decl(export_decl.decl))?);
                for export_name in exported_names {
                    let slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, module_id
                        )
                    })?;
                    output.push(render_module_export_slot(slot, &export_name));
                }
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportNamed(named_export)) => {
                let (lines, deps) = convert_bundler_named_export(
                    file_path,
                    &named_export,
                    context,
                    current_slots,
                    &mut export_counter,
                )?;
                output.extend(lines);
                dependency_ids.extend(deps);
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultExpr(
                default_expr,
            )) => {
                let local_name = format!("__gcc_default_export_{export_counter}");
                export_counter += 1;
                output.push(format!(
                    "const {local_name} = {};",
                    print_expression(*default_expr.expr)?
                ));
                let slot = current_slots.slot_for("default").ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for default in {}", module_id)
                })?;
                output.push(render_module_export_slot(slot, &local_name));
            }
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportDefaultDecl(
                default_decl,
            )) => match default_decl.decl {
                swc_core::ecma::ast::DefaultDecl::Fn(function_expr) => {
                    let local_name = function_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
                    export_counter += 1;
                    if function_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(swc_core::ecma::ast::Decl::Fn(
                            swc_core::ecma::ast::FnDecl {
                                declare: false,
                                function: function_expr.function,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            },
                        )))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Fn(function_expr))?
                        ));
                    }
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!("Missing bundler-runtime export slot for default in {}", module_id)
                    })?;
                    output.push(render_module_export_slot(slot, &local_name));
                }
                swc_core::ecma::ast::DefaultDecl::Class(class_expr) => {
                    let local_name = class_expr
                        .ident
                        .as_ref()
                        .map(|ident| ident.sym.to_string())
                        .unwrap_or_else(|| format!("__gcc_default_export_{export_counter}"));
                    export_counter += 1;
                    if class_expr.ident.is_some() {
                        output.push(print_statement(Stmt::Decl(
                            swc_core::ecma::ast::Decl::Class(swc_core::ecma::ast::ClassDecl {
                                class: class_expr.class,
                                declare: false,
                                ident: Ident::new(
                                    local_name.clone().into(),
                                    Default::default(),
                                    Default::default(),
                                ),
                            }),
                        ))?);
                    } else {
                        output.push(format!(
                            "const {local_name} = {};",
                            print_expression(Expr::Class(class_expr))?
                        ));
                    }
                    let slot = current_slots.slot_for("default").ok_or_else(|| {
                        format!("Missing bundler-runtime export slot for default in {}", module_id)
                    })?;
                    output.push(render_module_export_slot(slot, &local_name));
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(swc_core::ecma::ast::ModuleDecl::ExportAll(export_all)) => {
                let require_name = format!("__gcc_export_all_{export_counter}");
                export_counter += 1;
                let export_module_id = resolve_module_id_for_specifier(
                    file_path,
                    &export_all.src.value.to_string_lossy(),
                    context,
                )?;
                dependency_ids.push(export_module_id.clone());
                output.push(format!(
                    "const {require_name} = __require({export_module_id:?});"
                ));
                let target_slots = context
                    .bundler_module_slots
                    .get(&export_module_id)
                    .ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slots for re-exported module {}",
                            export_module_id
                        )
                    })?;
                for export_name in target_slots.export_names() {
                    if export_name == "default" {
                        continue;
                    }
                    let source_slot = target_slots.slot_for(export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, export_module_id
                        )
                    })?;
                    let target_slot = current_slots.slot_for(export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            export_name, module_id
                        )
                    })?;
                    output.push(render_module_export_slot(
                        target_slot,
                        &stable_slot_access(&require_name, source_slot),
                    ));
                }
            }
            ModuleItem::Stmt(statement) => output.push(print_statement(statement)?),
            _ => {}
        }
    }

    if let Some(export_name) = commonjs_export_name {
        let export_slot = current_slots.slot_for(export_name).ok_or_else(|| {
            format!(
                "Missing bundler-runtime export slot for {} in {}",
                export_name, module_id
            )
        })?;
        output.push(render_module_export_slot(export_slot, export_name));
        let default_slot = current_slots.slot_for("default").ok_or_else(|| {
            format!("Missing bundler-runtime export slot for default in {}", module_id)
        })?;
        output.push(render_module_export_slot(default_slot, export_name));
    }

    let dependency_ids = dependency_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let body = rewrite_bundler_exports(
        &output
            .into_iter()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let source_text = format!(
        "globalThis[\"__gcc_runtime__\"][\"registerModule\"]({module_id:?}, {}, function(__require, __exports, __dynamicImport, __preloadDynamicImport) {{\n{}\n}});",
        serde_json::to_string(&dependency_ids).map_err(|error| error.to_string())?,
        indent_block(&body)
    );
    Ok(apply_js_compat_text_fixes(source_text))
}

fn convert_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
) -> std::result::Result<Vec<String>, String> {
    let module_id = resolve_module_id_for_specifier(
        file_path,
        &import_decl.src.value.to_string_lossy(),
        context,
    )?;
    let mut lines = Vec::new();
    if import_decl.specifiers.is_empty() {
        lines.push(format!("goog.require({module_id:?});"));
        return Ok(lines);
    }

    let mut value_specifiers = Vec::new();
    let mut type_specifiers = Vec::new();
    for specifier in &import_decl.specifiers {
        match specifier {
            ImportSpecifier::Named(named) if import_decl.type_only || named.is_type_only => {
                type_specifiers.push(specifier);
            }
            _ if import_decl.type_only => type_specifiers.push(specifier),
            _ => value_specifiers.push(specifier),
        }
    }

    if !value_specifiers.is_empty() {
        let local_name = format!("__goog_import_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!("const {local_name} = goog.require({module_id:?});"));
        lines.extend(bind_import_specifiers(&local_name, &value_specifiers));
    }
    if !type_specifiers.is_empty() {
        let local_name = format!("__goog_type_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!(
            "const {local_name} = goog.requireType({module_id:?});"
        ));
        lines.extend(bind_import_specifiers(&local_name, &type_specifiers));
    }

    Ok(lines)
}

fn convert_bundler_import_decl(
    file_path: &Path,
    import_decl: &ImportDecl,
    context: &TranspileContext,
    import_counter: &mut usize,
) -> std::result::Result<(Vec<String>, Vec<String>), String> {
    let module_id = resolve_module_id_for_specifier(
        file_path,
        &import_decl.src.value.to_string_lossy(),
        context,
    )?;
    let mut lines = Vec::new();
    let mut dependency_ids = Vec::new();
    if import_decl.specifiers.is_empty() {
        lines.push(format!("__require({module_id:?});"));
        dependency_ids.push(module_id);
        return Ok((lines, dependency_ids));
    }

    let mut value_specifiers = Vec::new();
    for specifier in &import_decl.specifiers {
        match specifier {
            ImportSpecifier::Named(named) if import_decl.type_only || named.is_type_only => {}
            _ if import_decl.type_only => {}
            _ => value_specifiers.push(specifier),
        }
    }

    if !value_specifiers.is_empty() {
        let local_name = format!("__gcc_import_{}", *import_counter);
        *import_counter += 1;
        lines.push(format!("const {local_name} = __require({module_id:?});"));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        lines.extend(bind_bundler_import_specifiers(
            &local_name,
            &value_specifiers,
            target_slots,
        )?);
        dependency_ids.push(module_id);
    }

    Ok((lines, dependency_ids))
}

fn bind_import_specifiers(local_name: &str, specifiers: &[&ImportSpecifier]) -> Vec<String> {
    specifiers
        .iter()
        .map(|specifier| match specifier {
            ImportSpecifier::Default(default_specifier) => format!(
                "const {} = {}.default;",
                default_specifier.local.sym, local_name
            ),
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    member_access(local_name, &imported_name)
                )
            }
        })
        .collect()
}

fn bind_bundler_import_specifiers(
    local_name: &str,
    specifiers: &[&ImportSpecifier],
    target_slots: &BundlerModuleSlots,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::with_capacity(specifiers.len());
    for specifier in specifiers {
        let line = match specifier {
            ImportSpecifier::Default(default_specifier) => {
                let slot = target_slots
                    .slot_for("default")
                    .ok_or_else(|| "Missing bundler-runtime default export slot".to_string())?;
                format!(
                    "const {} = {};",
                    default_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
            ImportSpecifier::Namespace(namespace_specifier) => {
                format!("const {} = {};", namespace_specifier.local.sym, local_name)
            }
            ImportSpecifier::Named(named_specifier) => {
                let imported_name = named_specifier
                    .imported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| named_specifier.local.sym.to_string());
                let slot = target_slots.slot_for(&imported_name).ok_or_else(|| {
                    format!(
                        "Missing bundler-runtime export slot for imported name {imported_name}"
                    )
                })?;
                format!(
                    "const {} = {};",
                    named_specifier.local.sym,
                    stable_slot_access(local_name, slot)
                )
            }
        };
        lines.push(line);
    }
    Ok(lines)
}

fn convert_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    export_counter: &mut usize,
) -> std::result::Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(src) = &named_export.src {
        let require_name = format!("__goog_export_{}", *export_counter);
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        lines.push(format!(
            "const {require_name} = goog.require({module_id:?});"
        ));
        for specifier in &named_export.specifiers {
            let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
                continue;
            };
            let local_name = module_export_name_to_string(&named.orig);
            let export_name = named
                .exported
                .as_ref()
                .map(module_export_name_to_string)
                .unwrap_or_else(|| local_name.clone());
            lines.push(format!(
                "exports.{export_name} = {};",
                member_access(&require_name, &local_name)
            ));
        }
        return Ok(lines);
    }

    for specifier in &named_export.specifiers {
        let swc_core::ecma::ast::ExportSpecifier::Named(named) = specifier else {
            continue;
        };
        let local_name = module_export_name_to_string(&named.orig);
        let export_name = named
            .exported
            .as_ref()
            .map(module_export_name_to_string)
            .unwrap_or_else(|| local_name.clone());
        lines.push(format!("exports.{export_name} = {local_name};"));
    }
    Ok(lines)
}

fn convert_bundler_named_export(
    file_path: &Path,
    named_export: &swc_core::ecma::ast::NamedExport,
    context: &TranspileContext,
    current_slots: &BundlerModuleSlots,
    export_counter: &mut usize,
) -> std::result::Result<(Vec<String>, Vec<String>), String> {
    let mut lines = Vec::new();
    let mut dependency_ids = Vec::new();
    if let Some(src) = &named_export.src {
        let require_name = format!("__gcc_export_{}", *export_counter);
        *export_counter += 1;
        let module_id =
            resolve_module_id_for_specifier(file_path, &src.value.to_string_lossy(), context)?;
        dependency_ids.push(module_id.clone());
        lines.push(format!("const {require_name} = __require({module_id:?});"));
        let target_slots = context
            .bundler_module_slots
            .get(&module_id)
            .ok_or_else(|| format!("Missing bundler-runtime export slots for {module_id}"))?;
        for specifier in &named_export.specifiers {
            match specifier {
                swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                    let local_name = module_export_name_to_string(&named.orig);
                    let export_name = named
                        .exported
                        .as_ref()
                        .map(module_export_name_to_string)
                        .unwrap_or_else(|| local_name.clone());
                    let source_slot = target_slots.slot_for(&local_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {} in {}",
                            local_name, module_id
                        )
                    })?;
                    let target_slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                        format!(
                            "Missing bundler-runtime export slot for {}",
                            export_name
                        )
                    })?;
                    lines.push(render_module_export_slot(
                        target_slot,
                        &stable_slot_access(&require_name, source_slot),
                    ));
                }
                swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                    return Err(format!(
                        "bundler-runtime does not support namespace re-exports in {}",
                        file_path.display()
                    ));
                }
                _ => {}
            }
        }
        return Ok((lines, dependency_ids));
    }

    for specifier in &named_export.specifiers {
        match specifier {
            swc_core::ecma::ast::ExportSpecifier::Named(named) => {
                let local_name = module_export_name_to_string(&named.orig);
                let export_name = named
                    .exported
                    .as_ref()
                    .map(module_export_name_to_string)
                    .unwrap_or_else(|| local_name.clone());
                let target_slot = current_slots.slot_for(&export_name).ok_or_else(|| {
                    format!("Missing bundler-runtime export slot for {}", export_name)
                })?;
                lines.push(render_module_export_slot(target_slot, &local_name));
            }
            swc_core::ecma::ast::ExportSpecifier::Namespace(_) => {
                return Err(format!(
                    "bundler-runtime does not support namespace re-exports in {}",
                    file_path.display()
                ));
            }
            _ => {}
        }
    }
    Ok((lines, dependency_ids))
}

fn exported_decl_names(decl: &swc_core::ecma::ast::Decl) -> Vec<String> {
    match decl {
        swc_core::ecma::ast::Decl::Fn(function_decl) => vec![function_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Class(class_decl) => vec![class_decl.ident.sym.to_string()],
        swc_core::ecma::ast::Decl::Var(var_decl) => var_decl
            .decls
            .iter()
            .flat_map(|decl| binding_names(&decl.name))
            .collect(),
        _ => Vec::new(),
    }
}

fn binding_names(pattern: &Pat) -> Vec<String> {
    match pattern {
        Pat::Ident(ident) => vec![ident.id.sym.to_string()],
        Pat::Array(array) => array
            .elems
            .iter()
            .flatten()
            .flat_map(binding_names)
            .collect(),
        Pat::Object(object) => object
            .props
            .iter()
            .flat_map(|prop| match prop {
                swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                    binding_names(&key_value.value)
                }
                swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                    vec![assign.key.sym.to_string()]
                }
                swc_core::ecma::ast::ObjectPatProp::Rest(rest) => binding_names(&rest.arg),
            })
            .collect(),
        Pat::Assign(assign) => binding_names(&assign.left),
        Pat::Rest(rest) => binding_names(&rest.arg),
        _ => Vec::new(),
    }
}

fn member_access(object_name: &str, property_name: &str) -> String {
    if is_valid_js_identifier(property_name) {
        format!("{object_name}.{property_name}")
    } else {
        format!("{object_name}[{property_name:?}]")
    }
}

fn stable_slot_access(object_name: &str, slot: usize) -> String {
    format!("{object_name}[{slot}]")
}

fn render_module_export_slot(slot: usize, value_expression: &str) -> String {
    format!("__exports[{slot}] = {value_expression};")
}

fn indent_block(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_bundler_exports(source: &str) -> String {
    let dot_rewritten = regex::Regex::new(r"\bexports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
        .map(|regex| {
            regex
                .replace_all(source, "__exports[\"$1\"] =")
                .into_owned()
        })
        .unwrap_or_else(|_| source.to_string());
    regex::Regex::new(r#"\bexports\[(["'])(.+?)\1\]\s*="#)
        .map(|regex| {
            regex
                .replace_all(&dot_rewritten, "__exports[\"$2\"] =")
                .into_owned()
        })
        .unwrap_or(dot_rewritten)
}

fn module_export_name_to_string(name: &swc_core::ecma::ast::ModuleExportName) -> String {
    match name {
        swc_core::ecma::ast::ModuleExportName::Ident(ident) => ident.sym.to_string(),
        swc_core::ecma::ast::ModuleExportName::Str(value) => {
            value.value.to_string_lossy().to_string()
        }
    }
}

fn resolve_module_id_for_specifier(
    file_path: &Path,
    specifier: &str,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    if specifier.starts_with('.') {
        let resolved = resolve_relative_module(file_path, specifier).ok_or_else(|| {
            format!(
                "Failed to resolve module specifier {specifier:?} from {}",
                file_path.display()
            )
        })?;
        return Ok(to_goog_module_id(&resolved, &context.workspace_dir));
    }

    let (package_name, subpath) = split_package_specifier(specifier);
    let alias = context
        .package_aliases
        .iter()
        .find(|alias| alias.packageName == package_name && alias.subpath == subpath)
        .or_else(|| {
            context
                .package_aliases
                .iter()
                .find(|alias| alias.packageName == package_name && alias.subpath == ".")
        })
        .ok_or_else(|| format!("Failed to resolve package specifier {specifier:?}"))?;
    Ok(to_goog_module_id(
        Path::new(&alias.targetPath),
        &context.workspace_dir,
    ))
}

fn split_package_specifier(specifier: &str) -> (String, String) {
    if specifier.starts_with('@') {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = format!("{}/{}", parts[0], parts[1]);
        let subpath = if parts.len() > 2 {
            format!("./{}", parts[2..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    } else {
        let parts = specifier.split('/').collect::<Vec<_>>();
        let package_name = parts[0].to_string();
        let subpath = if parts.len() > 1 {
            format!("./{}", parts[1..].join("/"))
        } else {
            ".".to_string()
        };
        (package_name, subpath)
    }
}

fn render_closure_enum(enum_decl: &ClosureEnumDeclaration) -> String {
    let member_lines = enum_decl
        .members
        .iter()
        .map(|member| {
            let value = match &member.value {
                serde_json::Value::Bool(value) => value.to_string(),
                serde_json::Value::Number(value) => value.to_string(),
                serde_json::Value::String(value) => format!("{value:?}"),
                _ => "undefined".to_string(),
            };
            if is_valid_js_identifier(&member.name) {
                format!("  {}: {},", member.name, value)
            } else {
                format!("  {:?}: {},", member.name, value)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "/** @enum {{{}}} */\nconst {} = {{\n{}\n}};",
        enum_decl.value_type, enum_decl.name, member_lines
    )
}

fn attach_top_level_docs(source_text: String, docs: &[ClosureTopLevelDoc]) -> String {
    let mut rewritten = source_text;
    for doc in docs {
        let needle = match doc.kind.as_str() {
            "class" => format!("class {}", doc.name),
            _ => format!("function {}", doc.name),
        };
        if let Some(index) = rewritten.find(&needle) {
            rewritten.insert_str(index, &doc.jsdoc);
        }
    }
    rewritten
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
mod tests {
    use super::{
        apply_js_compat_text_fixes, collect_commonjs_extern_names, collect_enum_extern_names,
        collect_protocol_extern_names, collect_static_property_names_from_text, print_program,
        render_externs, render_generated_externs, transform_js_pass_through_module,
        transform_program, transform_source_file, StaticPropertyNameCollector,
    };
    use crate::module_cache::parse_module;
    use crate::pathing::to_goog_module_id;
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use swc_core::common::{Globals, GLOBALS};
    use swc_core::ecma::visit::VisitWith;

    fn empty_context() -> super::TranspileContext {
        super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            commonjs_specifiers: HashSet::new(),
            file_metadata: HashMap::new(),
            global_property_names: HashSet::new(),
            instance_method_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            package_aliases: Vec::new(),
            static_property_names: HashSet::new(),
            workspace_dir: PathBuf::from("/tmp"),
        }
    }

    #[test]
    fn rewrites_global_property_accesses_to_global_this() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
        let module = parse_module(
            &file_path,
            "const value = globalThis.sharedRegistry ?? new WeakMap(); const item = sharedRegistry.get(meta);",
        )
        .unwrap();

        let program = GLOBALS
            .set(&Globals::new(), || {
                transform_program(module, &file_path, &empty_context(), None)
            })
            .unwrap();
        let output = print_program(&program).unwrap();

        assert!(output.contains("globalThis.sharedRegistry.get(meta)"));
    }

    #[test]
    fn leaves_unrelated_identifiers_alone() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
        let module = parse_module(&file_path, "const value = registry.get(meta);").unwrap();

        let program = GLOBALS
            .set(&Globals::new(), || {
                transform_program(module, &file_path, &empty_context(), None)
            })
            .unwrap();
        let output = print_program(&program).unwrap();

        assert!(output.contains("registry.get(meta)"));
        assert!(!output.contains("globalThis.registry.get(meta)"));
    }

    #[test]
    fn preserves_js_source_verbatim() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-compat-{unique}.js"));
        let source_text =
            "/** @nocollapse */\nconst JSCompiler_renameProperty=(prop,_obj)=>prop;\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &file_path,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::new(),
                        chunk_mode: super::ChunkMode::Off,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: vec![super::PackageAliasInput {
                            packageName: "react".to_string(),
                            subpath: ".".to_string(),
                            targetPath: file_path
                                .parent()
                                .unwrap()
                                .parent()
                                .unwrap()
                                .join("react/index.js")
                                .to_string_lossy()
                                .to_string(),
                        }],
                        static_property_names: HashSet::new(),
                        workspace_dir: file_path
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .to_path_buf(),
                    },
                )
            })
            .unwrap();

        assert!(output.contains("goog.module("), "{output}");
        assert!(output.contains("JSCompiler_renameProperty"), "{output}");
    }

    #[test]
    fn adds_generic_static_property_fallbacks() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-{unique}.js"));
        let source_text = "class Demo {}\nDemo.enabledWarnings = [\"x\"];\nfunction run(){ return this.constructor.enabledWarnings.includes(\"x\"); }\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &file_path,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::new(),
                        chunk_mode: super::ChunkMode::Off,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: vec![super::PackageAliasInput {
                            packageName: "react".to_string(),
                            subpath: ".".to_string(),
                            targetPath: file_path
                                .parent()
                                .unwrap()
                                .parent()
                                .unwrap()
                                .join("react/index.js")
                                .to_string_lossy()
                                .to_string(),
                        }],
                        static_property_names: HashSet::new(),
                        workspace_dir: file_path
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .to_path_buf(),
                    },
                )
            })
            .unwrap();

        assert!(
            output.contains("this.constructor[\"enabledWarnings\"].includes(\"x\")"),
            "{output}"
        );
    }

    #[test]
    fn rewrites_global_alias_property_accesses_in_js_pass_through() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-alias-{unique}.js"));
        let source_text = "const global = globalThis;\nglobal.sharedRegistry ??= new WeakMap();\nconst item = sharedRegistry.get(meta);\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &file_path,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::new(),
                        chunk_mode: super::ChunkMode::Off,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: vec![super::PackageAliasInput {
                            packageName: "react".to_string(),
                            subpath: ".".to_string(),
                            targetPath: file_path
                                .parent()
                                .unwrap()
                                .parent()
                                .unwrap()
                                .join("react/index.js")
                                .to_string_lossy()
                                .to_string(),
                        }],
                        static_property_names: HashSet::new(),
                        workspace_dir: file_path
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .parent()
                            .unwrap()
                            .to_path_buf(),
                    },
                )
            })
            .unwrap();

        assert!(
            output.contains("globalThis.sharedRegistry.get(meta)"),
            "{output}"
        );
    }

    #[test]
    fn preserves_class_static_property_names_via_bracket_access() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path =
            std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-quote-{unique}.js"));
        let source_text = "let Demo = class Demo {};\nDemo.styles = theme;\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(&file_path, &empty_context())
            })
            .unwrap();

        assert!(output.contains("Demo[\"styles\"] = theme;"), "{output}");
    }

    #[test]
    fn annotates_static_class_members_with_nocollapse() {
        let transformed = apply_js_compat_text_fixes(
            "class Demo {\n  static styles = theme;\n}\nDemo.styles = theme;\n".to_string(),
        );

        assert!(
            transformed.contains("/** @nocollapse */\n  static styles = theme;"),
            "{transformed}"
        );
        assert!(
            transformed.contains("/** @nocollapse */\nDemo[\"styles\"] = theme;"),
            "{transformed}"
        );
    }

    #[test]
    fn generated_externs_include_global_and_static_protocols() {
        let externs = render_generated_externs(
            &HashSet::from([
                "sharedRegistry".to_string(),
                "reactiveElementVersions".to_string(),
            ]),
            &HashSet::from(["finalize".to_string(), "elementProperties".to_string()]),
        );

        assert!(
            externs.contains("Window.prototype.sharedRegistry;"),
            "{externs}"
        );
        assert!(
            externs.contains("Window.prototype.reactiveElementVersions;"),
            "{externs}"
        );
        assert!(
            externs.contains("Function.prototype.finalize;"),
            "{externs}"
        );
        assert!(
            externs.contains("Function.prototype.elementProperties;"),
            "{externs}"
        );
    }

    #[test]
    fn rewrites_jscompiler_rename_property_protocol_accesses() {
        let transformed = apply_js_compat_text_fixes(
            "const JSCompiler_renameProperty=(prop,_obj)=>prop;\nclass Demo {\n  static check(ctor) { return ctor.elementProperties.size + this.finalized; }\n}\nconst superCtor = Demo;\nDemo[JSCompiler_renameProperty('elementProperties', Demo)] = new Map();\nDemo[JSCompiler_renameProperty('finalized', Demo)] = true;\nsuperCtor.elementProperties;\n".to_string(),
        );

        assert!(
            transformed.contains("ctor[\"elementProperties\"].size"),
            "{transformed}"
        );
        assert!(transformed.contains("this[\"finalized\"]"), "{transformed}");
        assert!(
            transformed.contains("superCtor[\"elementProperties\"]"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_directory_import_specifiers_to_explicit_index_files() {
        let transformed = apply_js_compat_text_fixes(
            "import item from '.';\nexport { other } from '..';\n".to_string(),
        );

        assert!(transformed.contains("from './index.js'"), "{transformed}");
        assert!(transformed.contains("from '../index.js'"), "{transformed}");
    }

    #[test]
    fn moves_jsdoc_ahead_of_async_function_keyword() {
        let transformed = apply_js_compat_text_fixes(
            "async /** @param {?} arg */ function load(arg) { await arg; }\n".to_string(),
        );

        assert!(
            transformed.contains("/** @param {?} arg */\nasync function load(arg)"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_throw_statements_for_goog_module_output() {
        let source =
            "if (typeof globalThis.document === 'undefined') throw new Error('missing');\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &empty_context(),
        )
        .expect("transform");

        assert!(transformed.contains("(()=>{"), "{transformed}");
        assert!(
            transformed.contains("throw new Error('missing')"),
            "{transformed}"
        );
    }

    #[test]
    fn simplifies_literal_conditional_expressions_in_js_pass_through() {
        let source =
            "const value = false ? missing() : fallback();\nconst other = true ? keep() : drop();\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &empty_context(),
        )
        .expect("transform");

        assert!(
            transformed.contains("const value = fallback();"),
            "{transformed}"
        );
        assert!(
            transformed.contains("const other = keep();"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_undeclared_placeholder_returns_to_void_zero() {
        let source = "var RETURN = () => T;\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &empty_context(),
        )
        .expect("transform");

        assert!(
            transformed.contains("var RETURN = ()=>void 0;"),
            "{transformed}"
        );
    }

    #[test]
    fn folds_process_env_node_env_for_browser_packages() {
        let transformed = apply_js_compat_text_fixes(
            "if (process.env.NODE_ENV !== 'production') console.warn('dev');\n".to_string(),
        );

        assert!(
            transformed.contains("\"production\" !== 'production'"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_commonjs_namespace_imports_in_native_stage() {
        let file_path = PathBuf::from("/tmp/src/index.js");
        let source = "import * as demo from \"demo-pkg\";\nexport default demo.answer;\n";
        let transformed = transform_js_pass_through_module(
            parse_module(&file_path, source).expect("module"),
            source.to_string(),
            &file_path,
            &super::TranspileContext {
                bundler_module_slots: HashMap::new(),
                chunk_mode: super::ChunkMode::Off,
                commonjs_specifiers: HashSet::from(["demo-pkg".to_string()]),
                file_metadata: HashMap::new(),
                global_property_names: HashSet::new(),
                instance_method_names: HashSet::new(),
                lazy_imports_by_file: HashMap::new(),
                package_aliases: Vec::new(),
                static_property_names: HashSet::new(),
                workspace_dir: PathBuf::from("/tmp"),
            },
        )
        .expect("transform");

        assert!(
            transformed.contains("import __cjs_import_0 from \"demo-pkg\";"),
            "{transformed}"
        );
        assert!(
            transformed.contains("const demo = __cjs_import_0;"),
            "{transformed}"
        );
        assert!(transformed.contains("demo[\"answer\"]"), "{transformed}");
    }

    #[test]
    fn preserves_module_exports_member_names_in_commonjs_normalization() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir()
            .join(format!("gcc-ts-bundler-cjs-export-{unique}"))
            .join("node_modules/demo/index.js");
        let source_text =
            "module.exports.Component = Component;\nmodule.exports.createContext = createContext;\n";
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(&file_path, &empty_context())
            })
            .unwrap();

        assert!(
            output.contains("module.exports[\"Component\"] = Component;"),
            "{output}"
        );
        assert!(
            output.contains("module.exports[\"createContext\"] = createContext;"),
            "{output}"
        );
    }

    #[test]
    fn preserves_commonjs_alias_member_reads() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir()
            .join(format!("gcc-ts-bundler-cjs-alias-{unique}"))
            .join("node_modules/demo/index.js");
        let source_text = "const React = require(\"react\");\nmodule.exports = React.Component;\n";
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, source_text).unwrap();

        let context = super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            commonjs_specifiers: HashSet::new(),
            file_metadata: HashMap::new(),
            global_property_names: HashSet::new(),
            instance_method_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            package_aliases: vec![super::PackageAliasInput {
                packageName: "react".to_string(),
                subpath: ".".to_string(),
                targetPath: file_path
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("react/index.js")
                    .to_string_lossy()
                    .to_string(),
            }],
            workspace_dir: file_path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf(),
            static_property_names: HashSet::new(),
        };
        let output = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(&file_path, &context)
            })
            .unwrap();

        assert!(
            output.contains("const React = __cjs_require_0;"),
            "{output}"
        );
        assert!(
            output.contains("module[\"exports\"] = React[\"Component\"];"),
            "{output}"
        );
    }

    #[test]
    fn rewrites_component_props_to_runtime_object_reads() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
        let source = "export function RouterProvider({ router, children, ...rest }) { return render(router, children, rest); }\n";
        let transformed = transform_js_pass_through_module(
            parse_module(&file_path, source).expect("module"),
            source.to_string(),
            &file_path,
            &empty_context(),
        )
        .expect("transform");

        assert!(
            transformed.contains("function RouterProvider(__props)"),
            "{transformed}"
        );
        assert!(
            transformed.contains(
                "const router = __props[goog.reflect.objectProperty(\"router\", __props)];"
            ),
            "{transformed}"
        );
        assert!(
            transformed.contains(
                "const children = __props[goog.reflect.objectProperty(\"children\", __props)];"
            ),
            "{transformed}"
        );
        assert!(
            transformed.contains(
                "key !== goog.reflect.objectProperty(\"router\", __props) && key !== goog.reflect.objectProperty(\"children\", __props)"
            ),
            "{transformed}"
        );
    }

    #[test]
    fn preserves_uppercase_static_member_names_with_bracket_access() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.ts");
        let source = "export const enum Flags { None = 0, Dirty = 1 }\nexport const value = Flags.None | Flags.Dirty;\n";
        let transformed = GLOBALS.set(&Globals::new(), || {
            let program = transform_program(
                parse_module(&file_path, source).expect("module"),
                &file_path,
                &empty_context(),
                None,
            )
            .expect("transform");
            print_program(&program).expect("print")
        });

        assert!(
            transformed.contains("const value = 0 | 1;"),
            "{transformed}"
        );
    }

    #[test]
    fn collects_static_property_names_from_assignments_and_fields() {
        let names = collect_static_property_names_from_text(
            "class Demo { static styles = theme; }\nlet Other = class Other {};\nOther.shadowRootOptions = {};\n",
        );

        assert!(names.contains("styles"));
        assert!(names.contains("shadowRootOptions"));
    }

    #[test]
    fn collects_static_property_names_from_static_method_this_access() {
        let module = parse_module(
            std::path::Path::new("fixture.js"),
            "class Demo { static finalize() { this.__attributeToPropertyMap = new Map(); this.elementProperties.set('x', 1); } }",
        )
        .expect("module");
        let mut collector = StaticPropertyNameCollector::default();
        module.visit_with(&mut collector);

        assert!(collector.names.contains("__attributeToPropertyMap"));
        assert!(collector.names.contains("elementProperties"));
    }

    #[test]
    fn preserves_constant_like_object_keys_and_member_reads() {
        let source = "const PartType = { ATTRIBUTE: 1, CHILD: 2, ELEMENT: 6 };\nconst alias = PartType;\nexport const value = alias.CHILD + PartType.ELEMENT;\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &empty_context(),
        )
        .expect("transform");

        assert!(
            transformed.contains("\"ATTRIBUTE\": 1") || transformed.contains("\"ATTRIBUTE\":1"),
            "{transformed}"
        );
        assert!(transformed.contains("alias[\"CHILD\"]"), "{transformed}");
        assert!(
            transformed.contains("PartType[\"ELEMENT\"]"),
            "{transformed}"
        );
    }

    #[test]
    fn preserves_internal_protocol_class_methods_and_calls() {
        let source =
            "class Demo { constructor(){ this.__initialize(); this._$changeProperty(); this.$createRenderRoot$(); } __initialize(){ this.__save(); } __save(){} _$changeProperty(){} $createRenderRoot$(){} }\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &empty_context(),
        )
        .expect("transform");

        assert!(
            transformed.contains("this[\"__initialize\"]()"),
            "{transformed}"
        );
        assert!(transformed.contains("\"__initialize\"()"), "{transformed}");
        assert!(transformed.contains("this[\"__save\"]()"), "{transformed}");
        assert!(transformed.contains("\"__save\"()"), "{transformed}");
        assert!(
            transformed.contains("this[\"_$changeProperty\"]()"),
            "{transformed}"
        );
        assert!(
            transformed.contains("\"_$changeProperty\"()"),
            "{transformed}"
        );
        assert!(
            transformed.contains("this[\"$createRenderRoot$\"]()"),
            "{transformed}"
        );
        assert!(
            transformed.contains("\"$createRenderRoot$\"()"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_collected_global_property_reads_to_bracket_access() {
        let source = "const root = globalThis;\nroot.sharedRegistry = root.sharedRegistry || new WeakMap();\nexport const value = sharedRegistry.get(meta) ?? globalThis.sharedRegistry ?? root.sharedRegistry;\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &super::TranspileContext {
                bundler_module_slots: HashMap::new(),
                chunk_mode: super::ChunkMode::Off,
                commonjs_specifiers: HashSet::new(),
                file_metadata: HashMap::new(),
                global_property_names: HashSet::from(["sharedRegistry".to_string()]),
                instance_method_names: HashSet::new(),
                lazy_imports_by_file: HashMap::new(),
                package_aliases: vec![],
                static_property_names: HashSet::new(),
                workspace_dir: PathBuf::from("/tmp"),
            },
        )
        .expect("transform");

        assert!(
            transformed.contains("root[\"sharedRegistry\"]"),
            "{transformed}"
        );
        assert!(
            transformed.contains("globalThis[\"sharedRegistry\"].get(meta)"),
            "{transformed}"
        );
        assert!(
            transformed.contains("globalThis[\"sharedRegistry\"]"),
            "{transformed}"
        );
    }

    #[test]
    fn rewrites_collected_static_property_reads_to_bracket_access() {
        let source = "class Base { static finalize(ctor) { return ctor.styles && ctor.elementStyles; } }\nclass Demo extends Base {}\nDemo.styles = theme;\n";
        let transformed = transform_js_pass_through_module(
            parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
            source.to_string(),
            std::path::Path::new("fixture.js"),
            &super::TranspileContext {
                bundler_module_slots: HashMap::new(),
                chunk_mode: super::ChunkMode::Off,
                commonjs_specifiers: HashSet::new(),
                file_metadata: HashMap::new(),
                global_property_names: HashSet::new(),
                instance_method_names: HashSet::new(),
                lazy_imports_by_file: HashMap::new(),
                package_aliases: vec![],
                static_property_names: HashSet::from([
                    "styles".to_string(),
                    "elementStyles".to_string(),
                ]),
                workspace_dir: PathBuf::from("/tmp"),
            },
        )
        .expect("transform");

        assert!(transformed.contains("ctor[\"styles\"]"), "{transformed}");
        assert!(
            transformed.contains("ctor[\"elementStyles\"]"),
            "{transformed}"
        );
        assert!(
            transformed.contains("Demo[\"styles\"] = theme;"),
            "{transformed}"
        );
    }

    #[test]
    fn renders_commonjs_export_externs() {
        let externs = render_externs(
            &BTreeSet::from([
                "forwardRef".to_string(),
                "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE".to_string(),
            ]),
            &BTreeMap::new(),
        );

        assert!(
            externs.contains("Object.prototype.forwardRef;"),
            "{externs}"
        );
        assert!(
            externs.contains(
                "Object.prototype.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;"
            ),
            "{externs}"
        );
    }

    #[test]
    fn collects_object_literal_protocol_names_from_exported_bindings() {
        let file_path = PathBuf::from("/tmp/node_modules/demo/index.js");
        let source = "var Shared = { H: null, T: null, S: null };\nmodule.exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Shared;\n";
        let module = parse_module(&file_path, source).expect("module");
        let analysis = crate::commonjs::analyze_commonjs_module(&module);
        let externs = collect_commonjs_extern_names(&module, &analysis);

        assert!(externs
            .iter()
            .any(|name| name == "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"));
        assert!(externs.iter().any(|name| name == "H"));
        assert!(externs.iter().any(|name| name == "T"));
        assert!(externs.iter().any(|name| name == "S"));
    }

    #[test]
    fn collects_protocol_names_from_config_destructuring() {
        let file_path = PathBuf::from("/tmp/node_modules/demo/index.js");
        let source = "function build(config) { const { createMutableStore, createReadonlyStore, batch, init } = config; return { createMutableStore, createReadonlyStore, batch, init }; }\n";
        let module = parse_module(&file_path, source).expect("module");
        let externs = collect_protocol_extern_names(&module);

        assert!(externs.iter().any(|name| name == "createMutableStore"));
        assert!(externs.iter().any(|name| name == "createReadonlyStore"));
        assert!(externs.iter().any(|name| name == "batch"));
        assert!(externs.iter().any(|name| name == "init"));
    }

    #[test]
    fn collects_enum_member_names_for_externs() {
        let file_path = PathBuf::from("/tmp/node_modules/demo/index.ts");
        let source =
            "export const enum ReactiveFlags { None = 0, Mutable = 1, Watching = 2, Dirty = 16 }\n";
        let module = parse_module(&file_path, source).expect("module");
        let externs = collect_enum_extern_names(&module);

        assert!(externs.iter().any(|name| name == "None"));
        assert!(externs.iter().any(|name| name == "Mutable"));
        assert!(externs.iter().any(|name| name == "Watching"));
        assert!(externs.iter().any(|name| name == "Dirty"));
    }

    #[test]
    fn inlines_relative_imported_enum_members() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join(format!("gcc-ts-bundler-imported-enum-{unique}"))
            .join("node_modules/demo");
        let dep_file = root.join("flags.ts");
        let entry_file = root.join("index.ts");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &dep_file,
            "export const enum ReactiveFlags { None = 0, Dirty = 16 }\n",
        )
        .unwrap();
        fs::write(
            &entry_file,
            "import { ReactiveFlags } from './flags';\nexport const value = ReactiveFlags.None | ReactiveFlags.Dirty;\n",
        )
        .unwrap();

        let transformed = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(&entry_file, &empty_context())
            })
            .unwrap();

        assert!(
            transformed.contains("const value = 0 | 16;"),
            "{transformed}"
        );
    }

    #[test]
    fn renders_named_enum_externs() {
        let externs = render_externs(
            &BTreeSet::new(),
            &BTreeMap::from([(
                "ReactiveFlags".to_string(),
                BTreeSet::from([
                    "None".to_string(),
                    "Mutable".to_string(),
                    "Watching".to_string(),
                ]),
            )]),
        );

        assert!(externs.contains("Object.prototype.None;"), "{externs}");
        assert!(externs.contains("Object.prototype.Mutable;"), "{externs}");
        assert!(externs.contains("Object.prototype.Watching;"), "{externs}");
    }

    #[test]
    fn bundler_runtime_rewrites_namespace_member_reads_to_numeric_slots() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-abi-{unique}"));
        let src_dir = root.join("src");
        let feature_file = src_dir.join("feature.ts");
        let main_file = src_dir.join("main.ts");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(
            &feature_file,
            "export const marker = 'x';\nexport function renderMessage() { return marker; }\n",
        )
        .unwrap();
        fs::write(
            &main_file,
            "import * as feature from './feature';\nexport default feature.renderMessage();\n",
        )
        .unwrap();

        let feature_module_id = to_goog_module_id(&feature_file, &root);
        let main_module_id = to_goog_module_id(&main_file, &root);
        let transformed = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &main_file,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::from([
                            (
                                feature_module_id.clone(),
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                    "marker".to_string(),
                                    "renderMessage".to_string(),
                                ])),
                            ),
                            (
                                main_module_id.clone(),
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                    "default".to_string(),
                                ])),
                            ),
                        ]),
                        chunk_mode: super::ChunkMode::BundlerRuntime,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: Vec::new(),
                        static_property_names: HashSet::new(),
                        workspace_dir: root.clone(),
                    },
                )
            })
            .unwrap();

        assert!(transformed.contains("feature[1]()"), "{transformed}");
        assert!(!transformed.contains("renderMessage"), "{transformed}");
        assert!(transformed.contains("__exports[0]"), "{transformed}");
        assert!(!transformed.contains("__exports[\"default\"]"), "{transformed}");
    }

    #[test]
    fn bundler_runtime_rejects_reflective_namespace_usage() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-diagnostics-{unique}"));
        let src_dir = root.join("src");
        let feature_file = src_dir.join("feature.ts");
        let main_file = src_dir.join("main.ts");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(&feature_file, "export const marker = 'x';\n").unwrap();
        fs::write(
            &main_file,
            "import * as feature from './feature';\nconsole.log(Object.keys(feature));\n",
        )
        .unwrap();

        let feature_module_id = to_goog_module_id(&feature_file, &root);
        let main_module_id = to_goog_module_id(&main_file, &root);
        let error = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &main_file,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::from([
                            (
                                feature_module_id.clone(),
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                    "marker".to_string(),
                                ])),
                            ),
                            (
                                main_module_id.clone(),
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                            ),
                        ]),
                        chunk_mode: super::ChunkMode::BundlerRuntime,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: Vec::new(),
                        static_property_names: HashSet::new(),
                        workspace_dir: root.clone(),
                    },
                )
            })
            .unwrap_err();

        assert!(
            error.contains("reflective Object.* operations on module namespace values"),
            "{error}"
        );
    }

    #[test]
    fn bundler_runtime_rewrites_promise_consumer_callback_params_to_slots() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-callback-{unique}"));
        let src_dir = root.join("src");
        let feature_file = src_dir.join("feature.ts");
        let main_file = src_dir.join("main.ts");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(&feature_file, "export default function feature() { return 'ok'; }\n").unwrap();
        fs::write(
            &main_file,
            [
                "const loaders = { panel: () => __dynamicImport('gcc.src.feature') };",
                "const selected = state(null);",
                "setState(selected, loaders.panel());",
                "awaitLike(() => readState(selected), null, (anchor, module) => module.default(anchor));",
                "",
            ]
            .join("\n"),
        )
        .unwrap();

        let feature_module_id = to_goog_module_id(&feature_file, &root);
        let main_module_id = to_goog_module_id(&main_file, &root);
        let transformed = GLOBALS
            .set(&Globals::new(), || {
                transform_source_file(
                    &main_file,
                    &super::TranspileContext {
                        bundler_module_slots: HashMap::from([
                            (
                                feature_module_id.clone(),
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                    "default".to_string(),
                                ])),
                            ),
                            (
                                main_module_id,
                                super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                            ),
                        ]),
                        chunk_mode: super::ChunkMode::BundlerRuntime,
                        commonjs_specifiers: HashSet::new(),
                        file_metadata: HashMap::new(),
                        global_property_names: HashSet::new(),
                        instance_method_names: HashSet::new(),
                        lazy_imports_by_file: HashMap::new(),
                        package_aliases: Vec::new(),
                        static_property_names: HashSet::new(),
                        workspace_dir: root.clone(),
                    },
                )
            })
            .unwrap();

        assert!(transformed.contains("module[0](anchor)"), "{transformed}");
        assert!(!transformed.contains(".default"), "{transformed}");
    }
}
