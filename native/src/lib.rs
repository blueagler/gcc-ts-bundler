use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use napi::Result;
use napi_derive::napi;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use swc_core::common::{sync::Lrc, FileName, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::ast::Pass;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_typescript::strip;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveGraphInput {
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveGraphOutput {
    entries: Vec<EntryExportMetadata>,
    file_hashes: BTreeMap<String, String>,
    file_paths: Vec<String>,
    graph: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryExportMetadata {
    export_names: Vec<String>,
    has_default_export: bool,
    source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteShimsInput {
    entries: Vec<ShimEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShimEntry {
    export_names: Vec<String>,
    has_default_export: bool,
    import_path: String,
    shim_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranspileInput {
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    workspace_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranspileOutput {
    emitted_files: Vec<String>,
    externs_path: String,
}

#[derive(Clone)]
struct CachedModule {
    file_len: u64,
    modified_at_millis: u128,
    module: Module,
}

static MODULE_CACHE: OnceLock<Mutex<HashMap<String, CachedModule>>> = OnceLock::new();

#[napi]
pub fn resolve_graph_json(input: String) -> Result<String> {
    with_globals(|| {
        let input: ResolveGraphInput = serde_json::from_str(&input)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;

        let src_dir = PathBuf::from(&input.src_dir);
        let workspace_dir = PathBuf::from(&input.workspace_dir);
        let entries: Vec<PathBuf> = input.entries.iter().map(PathBuf::from).collect();

        let mut visited = BTreeSet::new();
        let mut graph = BTreeMap::new();
        let mut file_hashes = BTreeMap::new();
        let mut module_cache = HashMap::new();
        let mut pending = entries.clone();

        while let Some(current_file) = pending.pop() {
            if visited.contains(&current_file) {
                continue;
            }

            visited.insert(current_file.clone());
            let contents = fs::read_to_string(&current_file)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            let relative = path_relative_to(&current_file, &workspace_dir);
            file_hashes.insert(relative, hash_content(&contents));

            let module = parse_and_cache_module(&current_file, &contents)
                .map_err(|error| napi::Error::from_reason(error))?;
            let dependencies = extract_dependencies(&module)
                .into_iter()
                .filter_map(|specifier| resolve_relative_module(&specifier, &current_file, &src_dir))
                .collect::<BTreeSet<_>>();

            graph.insert(
                current_file.to_string_lossy().to_string(),
                dependencies
                    .iter()
                    .map(|dependency| dependency.to_string_lossy().to_string())
                    .collect(),
            );

            module_cache.insert(current_file.clone(), module);
            pending.extend(dependencies.into_iter());
        }

        let file_paths = visited
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        let mut export_cache = HashMap::<PathBuf, EntryExportMetadata>::new();
        let entries_metadata = entries
            .iter()
            .map(|entry| collect_exports(entry, &mut module_cache, &mut export_cache, &src_dir))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| napi::Error::from_reason(error))?;

        serde_json::to_string(&ResolveGraphOutput {
            entries: entries_metadata,
            file_hashes,
            file_paths,
            graph,
        })
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    })
}

#[napi]
pub fn write_entry_shims_json(input: String) -> Result<String> {
    let input: WriteShimsInput = serde_json::from_str(&input)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let mut written_files = Vec::new();

    for entry in input.entries {
        let mut lines = Vec::new();
        lines.push(format!("import * as __entry from {:?};", entry.import_path));
        lines.push(String::new());
        lines.push("((globalThis as Record<string, unknown>)[\"GCC\"] =".to_string());
        lines.push(
            "  (globalThis as Record<string, unknown>)[\"GCC\"] || {});".to_string(),
        );

        for export_name in entry.export_names {
            lines.push(format!(
                "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[{:?}] = __entry.{};",
                export_name, export_name
            ));
        }

        if entry.has_default_export {
            lines.push(
                "(((globalThis as Record<string, unknown>)[\"GCC\"]) as Record<string, unknown>)[\"__DEFAULT_EXPORT__\"] = __entry.default;".to_string(),
            );
        }

        let shim_path = PathBuf::from(&entry.shim_path);
        if let Some(parent) = shim_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        }
        fs::write(&shim_path, format!("{}\n", lines.join("\n")))
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        written_files.push(entry.shim_path);
    }

    serde_json::to_string(&written_files)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn transpile_sources_json(input: String) -> Result<String> {
    with_globals(|| {
        let input: TranspileInput = serde_json::from_str(&input)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        fs::create_dir_all(&input.out_dir)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        if let Some(parent) = Path::new(&input.externs_path).parent() {
            fs::create_dir_all(parent)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        }
        fs::write(&input.externs_path, "")
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;

        let workspace_dir = PathBuf::from(&input.workspace_dir);
        let out_dir = PathBuf::from(&input.out_dir);
        let emitted_outputs = input
            .file_names
            .par_iter()
            .filter(|file_name| !file_name.ends_with(".d.ts"))
            .map(|file_name| {
                let file_path = PathBuf::from(file_name);
                let relative_path = file_path
                    .strip_prefix(&workspace_dir)
                    .unwrap_or(&file_path);
                let output_path = out_dir.join(relative_path).with_extension("js");

                let code = GLOBALS.set(&Globals::new(), || {
                    let module = get_or_parse_cached_module(&file_path)?;
                    let program = transform_program(module)?;
                    print_program(&program)
                })?;

                Ok::<_, String>((output_path, code))
            })
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(napi::Error::from_reason)?;

        let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
        for (output_path, code) in emitted_outputs {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            }
            fs::write(&output_path, code)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            emitted_files.push(output_path.to_string_lossy().to_string());
        }

        emitted_files.sort();
        serde_json::to_string(&TranspileOutput {
            emitted_files,
            externs_path: input.externs_path,
        })
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    })
}

#[napi]
pub fn rewrite_gcc_exports(code: String) -> Result<String> {
    with_globals(|| {
        if !code.contains("globalThis.GCC") && !code.contains("globalThis[\"GCC\"]") {
            return Ok(code);
        }

        if let Some(rewritten) = rewrite_gcc_exports_fast(&code) {
            return Ok(rewritten);
        }

        let mut module = parse_module(&PathBuf::from("bundle.js"), &code)
            .map_err(|error| napi::Error::from_reason(error))?;
        let mut body = Vec::new();
        let mut exports_map = BTreeMap::<String, String>::new();
        let mut processed_exports = HashSet::<String>::new();
        let mut existing_export_names = HashSet::<String>::new();
        let mut has_default_export = false;

        for item in &module.body {
            match item {
                ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                    for specifier in &named.specifiers {
                        if let ExportSpecifier::Named(named_specifier) = specifier {
                            existing_export_names.insert(
                                export_name_from_module_export_name(named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig))
                            );
                        }
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
                | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                    has_default_export = true;
                }
                _ => {}
            }
        }

        for item in module.body.into_iter() {
            if let Some((export_name, right)) = get_gcc_export_assignment(&item) {
                if processed_exports.insert(export_name.clone()) {
                    let local_name = if export_name == "__DEFAULT_EXPORT__" {
                        "__gcc_default_export__".to_string()
                    } else {
                        format!("__gcc_export_{}", sanitize_identifier(&export_name))
                    };
                    exports_map.insert(export_name, local_name.clone());
                    body.push(
                        create_const_declaration(&local_name, right)
                            .map_err(|error| napi::Error::from_reason(error))?,
                    );
                }
            } else {
                body.push(item);
            }
        }

        for (export_name, local_name) in exports_map {
            if export_name == "__DEFAULT_EXPORT__" {
                if !has_default_export {
                    body.push(
                        parse_first_item(&format!("export default {};", local_name))
                            .map_err(|error| napi::Error::from_reason(error))?,
                    );
                }
            } else if !existing_export_names.contains(&export_name) {
                let exported_name = if is_valid_identifier(&export_name) {
                    export_name
                } else {
                    serde_json::to_string(&export_name).unwrap_or_else(|_| "\"\"".to_string())
                };
                body.push(
                    parse_first_item(&format!("export {{ {} as {} }};", local_name, exported_name))
                        .map_err(|error| napi::Error::from_reason(error))?,
                );
            }
        }

        module.body = body;
        print_module_minified(&module).map_err(|error| napi::Error::from_reason(error))
    })
}

fn collect_exports(
    file_path: &PathBuf,
    module_cache: &mut HashMap<PathBuf, Module>,
    export_cache: &mut HashMap<PathBuf, EntryExportMetadata>,
    src_dir: &Path,
) -> std::result::Result<EntryExportMetadata, String> {
    if let Some(existing) = export_cache.get(file_path) {
        return Ok(existing.clone());
    }

    let module = if let Some(existing) = module_cache.get(file_path) {
        existing.clone()
    } else {
        let parsed = get_or_parse_cached_module(file_path)?;
        module_cache.insert(file_path.clone(), parsed.clone());
        parsed
    };

    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for item in module.body.iter() {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => match &export_decl.decl {
                Decl::Class(class_decl) => {
                    export_names.insert(class_decl.ident.sym.to_string());
                }
                Decl::Fn(fn_decl) => {
                    export_names.insert(fn_decl.ident.sym.to_string());
                }
                Decl::Var(var_decl) => {
                    for declarator in &var_decl.decls {
                        collect_pattern_idents(&declarator.name, &mut export_names);
                    }
                }
                Decl::TsEnum(enum_decl) => {
                    export_names.insert(enum_decl.id.sym.to_string());
                }
                _ => {}
            },
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
            | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                has_default_export = true;
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if let Some(src) = &named.src {
                    if let Some(resolved) =
                        resolve_relative_module(&src.value.to_string_lossy(), file_path, src_dir)
                    {
                        let target_exports =
                            collect_exports(&resolved, module_cache, export_cache, src_dir)?;
                        for specifier in &named.specifiers {
                            if let ExportSpecifier::Named(named_specifier) = specifier {
                                let exported_name = export_name_from_module_export_name(
                                    named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig),
                                );
                                if exported_name != "default" {
                                    export_names.insert(exported_name);
                                }
                            }
                        }
                        if target_exports.has_default_export
                            && named.specifiers.iter().any(|specifier| match specifier {
                                ExportSpecifier::Named(named_specifier) => {
                                    export_name_from_module_export_name(
                                        named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig),
                                    ) == "default"
                                }
                                _ => false,
                            })
                        {
                            has_default_export = true;
                        }
                    }
                } else {
                    for specifier in &named.specifiers {
                        if let ExportSpecifier::Named(named_specifier) = specifier {
                            let exported_name = export_name_from_module_export_name(
                                named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig),
                            );
                            if exported_name == "default" {
                                has_default_export = true;
                            } else {
                                export_names.insert(exported_name);
                            }
                        }
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                if let Some(resolved) =
                    resolve_relative_module(&export_all.src.value.to_string_lossy(), file_path, src_dir)
                {
                    let target_exports =
                        collect_exports(&resolved, module_cache, export_cache, src_dir)?;
                    for export_name in target_exports.export_names {
                        export_names.insert(export_name);
                    }
                }
            }
            _ => {}
        }
    }

    let metadata = EntryExportMetadata {
        export_names: export_names.into_iter().collect(),
        has_default_export,
        source_path: file_path.to_string_lossy().to_string(),
    };
    export_cache.insert(file_path.clone(), metadata.clone());
    Ok(metadata)
}

fn collect_pattern_idents(pattern: &Pat, out: &mut BTreeSet<String>) {
    match pattern {
        Pat::Ident(ident) => {
            out.insert(ident.id.sym.to_string());
        }
        Pat::Array(array) => {
            for element in &array.elems {
                if let Some(pattern) = element {
                    collect_pattern_idents(pattern, out);
                }
            }
        }
        Pat::Object(object) => {
            for property in &object.props {
                match property {
                    ObjectPatProp::Assign(assign) => {
                        out.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_pattern_idents(&key_value.value, out);
                    }
                    ObjectPatProp::Rest(rest) => {
                        collect_pattern_idents(&rest.arg, out);
                    }
                }
            }
        }
        Pat::Rest(rest) => collect_pattern_idents(&rest.arg, out),
        Pat::Assign(assign) => collect_pattern_idents(&assign.left, out),
        _ => {}
    }
}

fn extract_dependencies(module: &Module) -> Vec<String> {
    let mut dependencies = Vec::new();

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) => {
                dependencies.push(import_decl.src.value.to_string_lossy().to_string());
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if let Some(src) = &named.src {
                    dependencies.push(src.value.to_string_lossy().to_string());
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportAll(export_all)) => {
                dependencies.push(export_all.src.value.to_string_lossy().to_string());
            }
            _ => {}
        }
    }

    dependencies
}

fn resolve_relative_module(specifier: &str, importer: &Path, src_dir: &Path) -> Option<PathBuf> {
    if !specifier.starts_with('.') {
        return None;
    }

    let importer_dir = importer.parent()?;
    let base = importer_dir.join(specifier);
    let candidates = module_candidates(&base);

    for candidate in candidates {
        if candidate.starts_with(src_dir) && candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn module_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if base.extension().is_some() {
        candidates.push(base.to_path_buf());
    } else {
        candidates.push(base.to_path_buf());
        for extension in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".d.ts"] {
            candidates.push(PathBuf::from(format!("{}{}", base.to_string_lossy(), extension)));
        }
        for extension in ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.d.ts"] {
            candidates.push(base.join(extension));
        }
    }
    candidates
}

fn parse_module(file_path: &PathBuf, source: &str) -> std::result::Result<Module, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        FileName::Real(file_path.clone()).into(),
        source.to_string(),
    );
    let syntax = match file_path.extension().and_then(|ext| ext.to_str()) {
        Some("ts") | Some("mts") | Some("d.ts") => Syntax::Typescript(TsSyntax {
            tsx: false,
            decorators: true,
            dts: file_path.to_string_lossy().ends_with(".d.ts"),
            ..Default::default()
        }),
        Some("tsx") => Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            ..Default::default()
        }),
        _ => Syntax::Es(EsSyntax {
            jsx: matches!(file_path.extension().and_then(|ext| ext.to_str()), Some("jsx")),
            ..Default::default()
        }),
    };

    let lexer = Lexer::new(syntax, Default::default(), StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|error| format!("{}: {}", file_path.to_string_lossy(), error.kind().msg()))
}

fn parse_and_cache_module(
    file_path: &PathBuf,
    source: &str,
) -> std::result::Result<Module, String> {
    let module = parse_module(file_path, source)?;
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let cache = MODULE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .map_err(|_| "module cache mutex poisoned".to_string())?
        .insert(
            file_path.to_string_lossy().to_string(),
            CachedModule {
                file_len: metadata.len(),
                modified_at_millis: modified_at,
                module: module.clone(),
            },
        );
    Ok(module)
}

fn get_or_parse_cached_module(file_path: &PathBuf) -> std::result::Result<Module, String> {
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let key = file_path.to_string_lossy().to_string();
    if let Some(cache) = MODULE_CACHE.get() {
        if let Ok(cache_guard) = cache.lock() {
            if let Some(cached) = cache_guard.get(&key) {
                if cached.file_len == metadata.len()
                    && cached.modified_at_millis == modified_at
                {
                    return Ok(cached.module.clone());
                }
            }
        }
    }

    let source = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    parse_and_cache_module(file_path, &source)
}

fn transform_program(module: Module) -> std::result::Result<Program, String> {
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    let mut program = Program::Module(module);
    resolver(unresolved_mark, top_level_mark, true).process(&mut program);
    strip(unresolved_mark, top_level_mark).process(&mut program);
    Ok(program)
}

fn parse_first_item(code: &str) -> std::result::Result<ModuleItem, String> {
    let module = parse_module(&PathBuf::from("snippet.js"), code)?;
    module
        .body
        .into_iter()
        .next()
        .ok_or_else(|| format!("failed to parse module item from {}", code))
}

fn create_const_declaration(
    local_name: &str,
    right: Box<Expr>,
) -> std::result::Result<ModuleItem, String> {
    let item = parse_first_item(&format!("const {} = null;", local_name))?;
    match item {
        ModuleItem::Stmt(Stmt::Decl(Decl::Var(mut variable_decl))) => {
            if let Some(declarator) = variable_decl.decls.first_mut() {
                declarator.init = Some(right);
            }
            Ok(ModuleItem::Stmt(Stmt::Decl(Decl::Var(variable_decl))))
        }
        _ => Err("failed to create const declaration".to_string()),
    }
}

fn get_gcc_export_assignment(item: &ModuleItem) -> Option<(String, Box<Expr>)> {
    let statement = match item {
        ModuleItem::Stmt(Stmt::Expr(statement)) => statement,
        _ => return None,
    };

    let assignment = match &*statement.expr {
        Expr::Assign(assignment) => assignment,
        _ => return None,
    };

    let left = match &assignment.left {
        AssignTarget::Simple(SimpleAssignTarget::Member(member)) => member,
        _ => return None,
    };

    let object = match &*left.obj {
        Expr::Member(member) => member,
        _ => return None,
    };

    let object_name = member_prop_name(&object.prop)?;
    let global_name = match &*object.obj {
        Expr::Ident(ident) => ident.sym.to_string(),
        _ => return None,
    };

    if global_name != "globalThis" || object_name != "GCC" {
        return None;
    }

    let export_name = member_prop_name(&left.prop)?;
    Some((export_name, assignment.right.clone()))
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
}

fn sanitize_identifier(name: &str) -> String {
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '$' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn is_valid_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    match characters.next() {
        Some(character) if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters.all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default().with_minify(true),
            cm,
            comments: None,
            wr: writer,
        };
        emitter.emit_module(module).map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
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
        emitter.emit_program(program).map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn with_globals<F>(callback: F) -> Result<String>
where
    F: FnOnce() -> Result<String>,
{
    GLOBALS.set(&Globals::new(), callback)
}

fn rewrite_gcc_exports_fast(code: &str) -> Option<String> {
    let init_statements = [
        "globalThis.GCC=globalThis.GCC||{};",
        "globalThis[\"GCC\"]=globalThis[\"GCC\"]||{};",
    ];
    let (start_index, init_statement) = init_statements
        .iter()
        .filter_map(|candidate| code.rfind(candidate).map(|index| (index, *candidate)))
        .max_by_key(|(index, _)| *index)?;
    let tail = &code[start_index..];
    let statements = split_top_level_statements(tail)?;
    if statements.first().copied()? != init_statement {
        return None;
    }

    let mut rewritten = String::with_capacity(code.len() + 128);
    rewritten.push_str(&code[..start_index]);
    rewritten.push_str(init_statement);

    for statement in statements.iter().skip(1) {
        let (export_name, expression) = parse_gcc_assignment(statement)?;
        if export_name == "__DEFAULT_EXPORT__" {
            rewritten.push_str("const __gcc_default_export__=");
            rewritten.push_str(expression);
            rewritten.push_str(";export default __gcc_default_export__;");
            continue;
        }

        if !is_valid_identifier(export_name) {
            return None;
        }

        let local_name = format!("__gcc_export_{}", sanitize_identifier(export_name));
        rewritten.push_str("const ");
        rewritten.push_str(&local_name);
        rewritten.push('=');
        rewritten.push_str(expression);
        rewritten.push_str(";export{");
        rewritten.push_str(&local_name);
        rewritten.push_str(" as ");
        rewritten.push_str(export_name);
        rewritten.push_str("};");
    }

    Some(rewritten)
}

fn split_top_level_statements(input: &str) -> Option<Vec<&str>> {
    let mut statements = Vec::new();
    let mut start_index = 0usize;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;

    for (index, character) in input.char_indices() {
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
                continue;
            }

            if character == '\\' {
                escaped = true;
                continue;
            }

            if character == quote {
                in_string = None;
            }
            continue;
        }

        match character {
            '"' | '\'' => in_string = Some(character),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.checked_sub(1)?,
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.checked_sub(1)?,
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.checked_sub(1)?,
            ';' if brace_depth == 0 && bracket_depth == 0 && paren_depth == 0 => {
                let statement = input[start_index..=index].trim();
                if !statement.is_empty() {
                    statements.push(statement);
                }
                start_index = index + 1;
            }
            _ => {}
        }
    }

    if input[start_index..].trim().is_empty() {
        Some(statements)
    } else {
        None
    }
}

fn parse_gcc_assignment(statement: &str) -> Option<(&str, &str)> {
    const PREFIXES: [&str; 4] = [
        "globalThis.GCC.",
        "globalThis.GCC[\"",
        "globalThis[\"GCC\"].",
        "globalThis[\"GCC\"][\"",
    ];

    for prefix in PREFIXES {
        if let Some(rest) = statement.strip_prefix(prefix) {
            if prefix.ends_with(".") {
                let assignment_index = rest.find('=')?;
                let export_name = &rest[..assignment_index];
                let expression = rest[assignment_index + 1..].strip_suffix(';')?;
                return Some((export_name, expression));
            }

            let quote_end = rest.find("\"]=").or_else(|| rest.find("']="))?;
            let export_name = &rest[..quote_end];
            let expression = rest[quote_end + 3..].strip_suffix(';')?;
            return Some((export_name, expression));
        }
    }

    None
}

fn path_relative_to(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
