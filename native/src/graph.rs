#![allow(non_snake_case)]

mod chunk_plan;
mod deps;
mod exports;
mod package_resolver;
mod path_utils;
mod resolve;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde_json::Value;
use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::commonjs::{analyze_commonjs_module, CommonJsAnalysis};
use crate::module_cache::{get_or_parse_cached_module, parse_and_cache_module};
use crate::pathing::to_goog_module_id;

use self::chunk_plan::*;
use self::deps::*;
use self::exports::*;
#[cfg(test)]
pub(crate) use self::package_resolver::select_package_export_target;
use self::package_resolver::*;
use self::path_utils::*;
use self::resolve::resolve_graph_impl;

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
pub struct ResolvedImportEntry {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
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
    pub resolvedImports: Vec<ResolvedImportEntry>,
    pub packageJsonFiles: Vec<String>,
    pub sourceFiles: Vec<String>,
    pub trackedFiles: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PackageMode {
    EsmOnly,
    Off,
}

/// Emission shape for chunked output.
///
/// `split` is deliberately absent: it names the same emission shape as
/// `bundler-runtime` (shared chunk graph, graph-derived renameable module ids,
/// shared capability-gated runtime, envelope chosen by the output-type gate) and
/// is folded into it at the parse boundary. Keeping one variant per shape rather
/// than one per public mode name is what stops a shape decision from silently
/// applying to only one of the two.
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
    resolve_graph_impl(entries, src_dir, workspace_dir, package_mode)
}

impl ChunkMode {
    fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "bundler-runtime" | "split" => Ok(Self::BundlerRuntime),
            "off" => Ok(Self::Off),
            _ => Err(format!("Unsupported chunk mode: {value}")),
        }
    }
}

// napi positional contract: the TS side calls these by argument
// position, so the parameter list is the published signature.
#[allow(clippy::too_many_arguments)]
pub fn plan_chunks(
    chunk_mode: String,
    base_chunk_name: String,
    workspace_dir: String,
    entry_files: Vec<ChunkPlanEntryInput>,
    graph_entries: Vec<DependencyGraphEntry>,
    lazy_imports: Vec<LazyImportEntry>,
    shim_files: Vec<String>,
    vendor_chunk: bool,
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
            // Both chunked modes now ship real import edges, which is what a
            // vendor chunk needs to be ordered against the base.
            vendor_chunk,
        ),
        ChunkMode::Off => build_off_chunk_plan(&entry_files, &graph, &shim_files, &workspace_dir),
    })
}

#[cfg(test)]
mod tests;
