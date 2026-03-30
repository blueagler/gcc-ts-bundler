#![allow(non_snake_case)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use sha2::{Digest, Sha256};
use swc_core::ecma::ast::*;

use crate::module_cache::{get_or_parse_cached_module, parse_and_cache_module};

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone)]
pub struct EntryExportMetadata {
    pub exportNames: Vec<String>,
    pub hasDefaultExport: bool,
    pub sourcePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
pub struct FileHashEntry {
    pub filePath: String,
    pub hash: String,
}

#[allow(non_snake_case)]
#[napi(object)]
pub struct DependencyGraphEntry {
    pub dependencies: Vec<String>,
    pub filePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    pub fileHashes: Vec<FileHashEntry>,
    pub filePaths: Vec<String>,
    pub graph: Vec<DependencyGraphEntry>,
}

pub fn resolve_graph(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
) -> std::result::Result<ResolveGraphOutput, String> {
    let src_dir = PathBuf::from(src_dir);
    let workspace_dir = PathBuf::from(workspace_dir);
    let entries: Vec<PathBuf> = entries.into_iter().map(PathBuf::from).collect();

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
        let contents = fs::read_to_string(&current_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(&current_file, &workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));

        let module = parse_and_cache_module(&current_file, &contents)?;
        let dependencies = extract_dependencies(&module)
            .into_iter()
            .filter_map(|specifier| resolve_relative_module(&specifier, &current_file, &src_dir))
            .collect::<BTreeSet<_>>();

        graph.insert(
            current_file.to_string_lossy().to_string(),
            dependencies
                .iter()
                .map(|dependency| dependency.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
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
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(ResolveGraphOutput {
        entries: entries_metadata,
        fileHashes: file_hashes
            .into_iter()
            .map(|(file_path, hash)| FileHashEntry {
                filePath: file_path,
                hash,
            })
            .collect(),
        filePaths: file_paths,
        graph: graph
            .into_iter()
            .map(|(file_path, dependencies)| DependencyGraphEntry {
                dependencies,
                filePath: file_path,
            })
            .collect(),
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
                                    named_specifier
                                        .exported
                                        .as_ref()
                                        .unwrap_or(&named_specifier.orig),
                                );
                                if exported_name != "default" {
                                    export_names.insert(exported_name);
                                }
                            }
                        }
                        if target_exports.hasDefaultExport
                            && named.specifiers.iter().any(|specifier| match specifier {
                                ExportSpecifier::Named(named_specifier) => {
                                    export_name_from_module_export_name(
                                        named_specifier
                                            .exported
                                            .as_ref()
                                            .unwrap_or(&named_specifier.orig),
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
                    for export_name in target_exports.exportNames {
                        export_names.insert(export_name);
                    }
                }
            }
            _ => {}
        }
    }

    let metadata = EntryExportMetadata {
        exportNames: export_names.into_iter().collect(),
        hasDefaultExport: has_default_export,
        sourcePath: file_path.to_string_lossy().to_string(),
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
        for extension in [
            "index.ts",
            "index.tsx",
            "index.js",
            "index.jsx",
            "index.mjs",
            "index.d.ts",
        ] {
            candidates.push(base.join(extension));
        }
    }
    candidates
}

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
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
