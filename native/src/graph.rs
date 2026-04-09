#![allow(non_snake_case)]

mod chunk_plan;
mod deps;
mod package_resolver;
mod path_utils;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

use napi_derive::napi;
use serde_json::Value;
use sha2::{Digest, Sha256};
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::commonjs::{analyze_commonjs_module, CommonJsAnalysis};
use crate::module_cache::{get_or_parse_cached_module, parse_and_cache_module};
use crate::pathing::to_goog_module_id;

use self::chunk_plan::*;
use self::deps::*;
use self::package_resolver::*;
use self::path_utils::*;

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct EntryExportMetadata {
    pub exportNames: Vec<String>,
    pub hasDefaultExport: bool,
    pub sourcePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct FileHashEntry {
    pub filePath: String,
    pub hash: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct DependencyGraphEntry {
    pub dependencies: Vec<String>,
    pub filePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasEntry {
    pub packageName: String,
    pub subpath: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LazyImportEntry {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChunkPlanEntryInput {
    pub chunkName: String,
    pub outputName: String,
    pub sourcePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChunkPlanChunkOutput {
    pub dependencies: Vec<String>,
    pub entryFiles: Option<Vec<String>>,
    pub files: Vec<String>,
    pub kind: Option<String>,
    pub lazyModuleIds: Option<Vec<String>>,
    pub name: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    pub fileHashes: Vec<FileHashEntry>,
    pub graph: Vec<DependencyGraphEntry>,
    pub lazyImports: Vec<LazyImportEntry>,
    pub packageAliases: Vec<PackageAliasEntry>,
    pub packageJsonFiles: Vec<String>,
    pub sourceFiles: Vec<String>,
    pub trackedFiles: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PackageMode {
    EsmOnly,
    Off,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ChunkMode {
    BundlerRuntime,
    Off,
}

struct ResolveContext<'a> {
    package_mode: PackageMode,
    src_dir: &'a Path,
    workspace_dir: &'a Path,
}

struct ResolvedModule {
    package_alias: Option<PackageAliasEntry>,
    package_json_files: Vec<PathBuf>,
    path: PathBuf,
}

struct PackageImport {
    package_name: String,
    subpath: String,
}

pub fn resolve_graph(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
) -> std::result::Result<ResolveGraphOutput, String> {
    let src_dir = PathBuf::from(src_dir);
    let workspace_dir = PathBuf::from(workspace_dir);
    let entries: Vec<PathBuf> = entries.into_iter().map(PathBuf::from).collect();
    let context = ResolveContext {
        package_mode: PackageMode::parse(&package_mode)?,
        src_dir: &src_dir,
        workspace_dir: &workspace_dir,
    };

    let mut consulted_package_jsons = BTreeSet::new();
    let mut commonjs_cache = HashMap::<PathBuf, CommonJsAnalysis>::new();
    let mut file_hashes = BTreeMap::new();
    let mut graph = BTreeMap::new();
    let mut lazy_imports = BTreeMap::<String, LazyImportEntry>::new();
    let mut module_cache = HashMap::new();
    let mut package_aliases = BTreeMap::<String, PackageAliasEntry>::new();
    let mut pending = entries.clone();
    let mut visited = BTreeSet::new();

    while let Some(current_file) = pending.pop() {
        if visited.contains(&current_file) {
            continue;
        }

        visited.insert(current_file.clone());
        let contents = fs::read_to_string(&current_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(&current_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));

        let module = parse_and_cache_module(&current_file, &contents)?;
        let commonjs_analysis = analyze_commonjs_module(&module);
        if commonjs_analysis.has_commonjs {
            validate_commonjs_usage(&current_file, &commonjs_analysis, &context)?;
        }
        commonjs_cache.insert(current_file.clone(), commonjs_analysis.clone());

        let specifiers = if commonjs_analysis.has_commonjs {
            commonjs_analysis.dependencies.clone()
        } else {
            extract_dependencies(&module)
        };
        let lazy_specifiers = if commonjs_analysis.has_commonjs {
            Vec::new()
        } else {
            collect_dynamic_import_specifiers(&module)?
        };

        let mut dependencies = BTreeSet::new();
        for specifier in specifiers {
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                dependencies.insert(resolved.path);
            }
        }
        for specifier in lazy_specifiers {
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias.clone() {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                pending.push(resolved.path.clone());
                let key = format!("{}\0{}", current_file.to_string_lossy(), specifier);
                lazy_imports.insert(
                    key,
                    LazyImportEntry {
                        importerFilePath: current_file.to_string_lossy().to_string(),
                        moduleId: to_goog_module_id(&resolved.path, context.workspace_dir),
                        specifier,
                        targetPath: resolved.path.to_string_lossy().to_string(),
                    },
                );
            }
        }

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

    for package_json_file in &consulted_package_jsons {
        let contents = fs::read_to_string(package_json_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(package_json_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));
    }

    let mut export_cache = HashMap::<PathBuf, EntryExportMetadata>::new();
    let entries_metadata = entries
        .iter()
        .map(|entry| {
            collect_exports(
                entry,
                &mut commonjs_cache,
                &mut module_cache,
                &mut export_cache,
                &context,
            )
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let package_json_files = consulted_package_jsons
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let source_files = visited
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let tracked_files = source_files
        .iter()
        .cloned()
        .chain(package_json_files.iter().cloned())
        .collect::<Vec<_>>();

    Ok(ResolveGraphOutput {
        entries: entries_metadata,
        fileHashes: file_hashes
            .into_iter()
            .map(|(file_path, hash)| FileHashEntry {
                filePath: file_path,
                hash,
            })
            .collect(),
        graph: graph
            .into_iter()
            .map(|(file_path, dependencies)| DependencyGraphEntry {
                dependencies,
                filePath: file_path,
            })
            .collect(),
        lazyImports: lazy_imports.into_values().collect(),
        packageAliases: package_aliases.into_values().collect(),
        packageJsonFiles: package_json_files,
        sourceFiles: source_files,
        trackedFiles: tracked_files,
    })
}

impl PackageMode {
    fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "esm-only" => Ok(Self::EsmOnly),
            "off" => Ok(Self::Off),
            _ => Err(format!("Unsupported package mode: {value}")),
        }
    }
}

impl ChunkMode {
    fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "bundler-runtime" => Ok(Self::BundlerRuntime),
            "off" => Ok(Self::Off),
            _ => Err(format!("Unsupported chunk mode: {value}")),
        }
    }
}

pub fn plan_chunks(
    chunk_mode: String,
    base_chunk_name: String,
    workspace_dir: String,
    entry_files: Vec<ChunkPlanEntryInput>,
    graph_entries: Vec<DependencyGraphEntry>,
    lazy_imports: Vec<LazyImportEntry>,
    shim_files: Vec<String>,
) -> std::result::Result<Vec<ChunkPlanChunkOutput>, String> {
    let chunk_mode = ChunkMode::parse(&chunk_mode)?;
    let workspace_dir = PathBuf::from(workspace_dir);
    let graph = graph_entries
        .into_iter()
        .map(|entry| (entry.filePath, entry.dependencies))
        .collect::<HashMap<_, _>>();

    Ok(match chunk_mode {
        ChunkMode::BundlerRuntime => build_bundler_chunk_plan(
            &sanitize_chunk_name(&base_chunk_name),
            &entry_files,
            &graph,
            &lazy_imports,
            &workspace_dir,
        ),
        ChunkMode::Off => build_off_chunk_plan(&entry_files, &graph, &shim_files, &workspace_dir),
    })
}

fn collect_exports(
    file_path: &PathBuf,
    commonjs_cache: &mut HashMap<PathBuf, CommonJsAnalysis>,
    module_cache: &mut HashMap<PathBuf, Module>,
    export_cache: &mut HashMap<PathBuf, EntryExportMetadata>,
    context: &ResolveContext,
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

    let commonjs_analysis = commonjs_cache
        .get(file_path)
        .cloned()
        .unwrap_or_else(|| analyze_commonjs_module(&module));
    commonjs_cache.insert(file_path.clone(), commonjs_analysis.clone());
    if commonjs_analysis.has_commonjs {
        if let Some(specifier) = commonjs_analysis.proxy_export {
            if let Some(resolved) = resolve_module_specifier(&specifier, file_path, context)? {
                let metadata = collect_exports(
                    &resolved.path,
                    commonjs_cache,
                    module_cache,
                    export_cache,
                    context,
                )?;
                export_cache.insert(file_path.clone(), metadata.clone());
                return Ok(metadata);
            }
        }

        let metadata = EntryExportMetadata {
            exportNames: commonjs_analysis.export_names,
            hasDefaultExport: commonjs_analysis.has_default_export,
            sourcePath: file_path.to_string_lossy().to_string(),
        };
        export_cache.insert(file_path.clone(), metadata.clone());
        return Ok(metadata);
    }

    let mut export_names = BTreeSet::new();
    let mut has_default_export = false;

    for item in module.body.iter() {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
                match &export_decl.decl {
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
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
            | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                has_default_export = true;
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                if named.type_only {
                    continue;
                }

                if let Some(src) = &named.src {
                    if let Some(resolved) =
                        resolve_module_specifier(&src.value.to_string_lossy(), file_path, context)?
                    {
                        let target_exports = collect_exports(
                            &resolved.path,
                            commonjs_cache,
                            module_cache,
                            export_cache,
                            context,
                        )?;
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
                                named_specifier
                                    .exported
                                    .as_ref()
                                    .unwrap_or(&named_specifier.orig),
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
                if export_all.type_only {
                    continue;
                }

                if let Some(resolved) = resolve_module_specifier(
                    &export_all.src.value.to_string_lossy(),
                    file_path,
                    context,
                )? {
                    let target_exports = collect_exports(
                        &resolved.path,
                        commonjs_cache,
                        module_cache,
                        export_cache,
                        context,
                    )?;
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

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests;
