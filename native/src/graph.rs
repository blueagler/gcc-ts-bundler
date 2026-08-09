#![allow(non_snake_case)]

mod chunk_mirror;
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
use sha2::{Digest, Sha256};

use crate::commonjs::{analyze_commonjs_source, CommonJsAnalysis};
use crate::pathing::to_goog_module_id;

pub use self::chunk_mirror::RollupChunkInput;
use self::chunk_mirror::*;
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
    pub outputName: Option<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct ExternalBoundaryEntry {
    pub importerFilePath: String,
    pub specifier: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ModuleKindEntry {
    pub filePath: String,
    pub kind: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedModuleEntry {
    pub exportNames: Vec<String>,
    pub filePath: String,
    pub hasDefaultExport: bool,
    pub moduleId: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Debug)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    pub externalBoundaries: Vec<ExternalBoundaryEntry>,
    pub fileHashes: Vec<FileHashEntry>,
    pub graph: Vec<DependencyGraphEntry>,
    pub lazyImports: Vec<LazyImportEntry>,
    pub moduleKinds: Vec<ModuleKindEntry>,
    pub packageAliases: Vec<PackageAliasEntry>,
    pub resolvedImports: Vec<ResolvedImportEntry>,
    pub packageJsonFiles: Vec<String>,
    pub preservedModules: Vec<PreservedModuleEntry>,
    pub sourceFiles: Vec<String>,
    pub trackedFiles: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PackageMode {
    EsmOnly,
    Off,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum BuiltinPolicy {
    ExternalBoundary,
    Reject,
}

#[derive(Clone, Copy)]
pub(super) struct TargetDescriptor {
    pub builtin_policy: BuiltinPolicy,
    pub export_conditions: &'static [&'static str],
}

const BROWSER_TARGET: TargetDescriptor = TargetDescriptor {
    builtin_policy: BuiltinPolicy::Reject,
    export_conditions: &["browser", "production", "import", "default"],
};
const NODE_TARGET: TargetDescriptor = TargetDescriptor {
    builtin_policy: BuiltinPolicy::ExternalBoundary,
    export_conditions: &["node", "production", "import", "require", "default"],
};
const BUN_TARGET: TargetDescriptor = TargetDescriptor {
    builtin_policy: BuiltinPolicy::ExternalBoundary,
    export_conditions: &["bun", "node", "production", "import", "require", "default"],
};
const WORKERD_TARGET: TargetDescriptor = TargetDescriptor {
    builtin_policy: BuiltinPolicy::Reject,
    export_conditions: &[
        "workerd",
        "worker",
        "browser",
        "production",
        "import",
        "default",
    ],
};
const WEBWORKER_TARGET: TargetDescriptor = TargetDescriptor {
    builtin_policy: BuiltinPolicy::Reject,
    export_conditions: &["worker", "browser", "production", "import", "default"],
};

pub(super) fn target_descriptor(name: &str) -> std::result::Result<TargetDescriptor, String> {
    match name {
        "browser" => Ok(BROWSER_TARGET),
        "node" => Ok(NODE_TARGET),
        "bun" => Ok(BUN_TARGET),
        "workerd" => Ok(WORKERD_TARGET),
        "webworker" => Ok(WEBWORKER_TARGET),
        _ => Err(format!("Unsupported target: {name}")),
    }
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
    external_specifiers: &'a BTreeSet<String>,
    package_mode: PackageMode,
    preserved_file_paths: &'a BTreeSet<String>,
    target: TargetDescriptor,
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

#[cfg(test)]
pub fn resolve_graph(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
) -> std::result::Result<ResolveGraphOutput, String> {
    resolve_graph_with_options(
        entries,
        src_dir,
        workspace_dir,
        package_mode,
        Vec::new(),
        Vec::new(),
    )
}

pub fn resolve_graph_with_options(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
    external_specifiers: Vec<String>,
    preserved_file_paths: Vec<String>,
) -> std::result::Result<ResolveGraphOutput, String> {
    resolve_graph_impl(
        entries,
        src_dir,
        workspace_dir,
        package_mode,
        external_specifiers,
        preserved_file_paths,
    )
}

pub fn assign_chunk_names(
    base_names: Vec<String>,
    entry_identities: Vec<String>,
) -> std::result::Result<Vec<String>, String> {
    if base_names.len() != entry_identities.len() {
        return Err(format!(
            "Chunk-name inputs differ in length: {} base names, {} entry identities",
            base_names.len(),
            entry_identities.len()
        ));
    }
    let counts = base_names.iter().fold(BTreeMap::new(), |mut counts, name| {
        *counts.entry(name.clone()).or_insert(0_usize) += 1;
        counts
    });
    let mut assigned = BTreeSet::new();
    base_names
        .into_iter()
        .zip(entry_identities)
        .map(|(base_name, identity)| {
            let name = if counts.get(base_name.as_str()).copied().unwrap_or(0) > 1 {
                let normalized_identity = identity.replace('\\', "/");
                let suffix = Sha256::digest(normalized_identity.as_bytes())
                    .iter()
                    .take(5)
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                format!("{base_name}-{suffix}")
            } else {
                base_name
            };
            if !assigned.insert(name.clone()) {
                return Err(format!(
                    "Entry identities did not produce unique Closure chunk names: {name}"
                ));
            }
            Ok(name)
        })
        .collect()
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
    rollup_chunks: Vec<RollupChunkInput>,
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
        // Rollup chunk data means the host bundler already split this graph and
        // proved the split ships; mirroring it lets Closure optimize inside
        // those boundaries instead of re-deriving its own. Only the Vite plugin
        // has that data - the standalone chunked build derives boundaries from
        // its lazy imports, which is a different product, not a fallback.
        ChunkMode::BundlerRuntime if !rollup_chunks.is_empty() => build_mirror_chunk_plan(
            &entry_files,
            &graph,
            &lazy_imports,
            &rollup_chunks,
            &workspace_dir,
        )?,
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
        ChunkMode::Off => build_off_chunk_plan(&entry_files, &graph, &shim_files, &workspace_dir)?,
    })
}

#[cfg(test)]
mod tests;
