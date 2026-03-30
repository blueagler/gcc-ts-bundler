use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use napi::Result;
use napi_derive::napi;
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

            let module = parse_module(&current_file, &contents)
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

        let mut emitted_files = Vec::new();
        for file_name in input.file_names {
            let file_path = PathBuf::from(&file_name);
            if file_path.to_string_lossy().ends_with(".d.ts") {
                continue;
            }

            let source = fs::read_to_string(&file_path)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            let module = parse_module(&file_path, &source)
                .map_err(|error| napi::Error::from_reason(error))?;
            let relative_path = file_path
                .strip_prefix(Path::new(&input.workspace_dir))
                .unwrap_or(&file_path);
            let output_path = Path::new(&input.out_dir).join(relative_path).with_extension("js");
            let program = transform_program(module)
                .map_err(|error| napi::Error::from_reason(error))?;
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            }
            fs::write(&output_path, print_program(&program).map_err(napi::Error::from_reason)?)
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

    let contents = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let module = if let Some(existing) = module_cache.get(file_path) {
        existing.clone()
    } else {
        let parsed = parse_module(file_path, &contents)?;
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
