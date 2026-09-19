use napi_derive::napi;

use super::chunk_mirror::RollupChunkInput;

#[napi(object)]
pub struct PlanChunksInput {
    #[napi(js_name = "chunkMode")]
    pub chunk_mode: String,
    #[napi(js_name = "baseChunkName")]
    pub base_chunk_name: String,
    #[napi(js_name = "workspaceDir")]
    pub workspace_dir: String,
    #[napi(js_name = "entryFiles")]
    pub entry_files: Vec<ChunkPlanEntryInput>,
    #[napi(js_name = "graphEntries")]
    pub graph_entries: Vec<DependencyGraphEntry>,
    #[napi(js_name = "lazyImports")]
    pub lazy_imports: Vec<LazyImportEntry>,
    #[napi(js_name = "rollupChunks")]
    pub rollup_chunks: Vec<RollupChunkInput>,
    #[napi(js_name = "vendorChunk")]
    pub vendor_chunk: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct EntryExportMetadata {
    #[napi(js_name = "constEnumExportNames")]
    pub const_enum_export_names: Vec<String>,
    #[napi(js_name = "exportNames")]
    pub export_names: Vec<String>,
    #[napi(js_name = "hasDefaultExport")]
    pub has_default_export: bool,
    #[napi(js_name = "sourcePath")]
    pub source_path: String,
}

#[napi(object)]
#[derive(Debug)]
pub struct FileHashEntry {
    #[napi(js_name = "filePath")]
    pub file_path: String,
    pub hash: String,
}

#[napi(object)]
#[derive(Debug)]
pub struct DependencyGraphEntry {
    pub dependencies: Vec<String>,
    #[napi(js_name = "filePath")]
    pub file_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasEntry {
    #[napi(js_name = "packageName")]
    pub package_name: String,
    pub subpath: String,
    #[napi(js_name = "targetPath")]
    pub target_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResolvedImportEntry {
    #[napi(js_name = "importerFilePath")]
    pub importer_file_path: String,
    #[napi(js_name = "moduleId")]
    pub module_id: String,
    pub specifier: String,
    #[napi(js_name = "targetPath")]
    pub target_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct LazyImportEntry {
    #[napi(js_name = "importerFilePath")]
    pub importer_file_path: String,
    #[napi(js_name = "moduleId")]
    pub module_id: String,
    pub specifier: String,
    #[napi(js_name = "targetPath")]
    pub target_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChunkPlanEntryInput {
    #[napi(js_name = "outputName")]
    pub output_name: String,
    #[napi(js_name = "sourcePath")]
    pub source_path: String,
    #[napi(js_name = "shimPath")]
    pub shim_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ChunkPlanChunkOutput {
    pub dependencies: Vec<String>,
    #[napi(js_name = "entryFiles")]
    pub entry_files: Option<Vec<String>>,
    pub files: Vec<String>,
    pub kind: Option<String>,
    #[napi(js_name = "lazyModuleIds")]
    pub lazy_module_ids: Option<Vec<String>>,
    pub name: String,
    #[napi(js_name = "outputName")]
    pub output_name: Option<String>,
}

#[napi(object)]
#[derive(Debug)]
pub struct ExternalBoundaryEntry {
    #[napi(js_name = "importerFilePath")]
    pub importer_file_path: String,
    pub specifier: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedModuleEntry {
    #[napi(js_name = "constEnumExportNames")]
    pub const_enum_export_names: Vec<String>,
    #[napi(js_name = "exportNames")]
    pub export_names: Vec<String>,
    #[napi(js_name = "filePath")]
    pub file_path: String,
    #[napi(js_name = "hasDefaultExport")]
    pub has_default_export: bool,
    #[napi(js_name = "moduleId")]
    pub module_id: String,
}

#[napi(object)]
#[derive(Debug)]
pub struct ResolveGraphOutput {
    pub entries: Vec<EntryExportMetadata>,
    #[napi(js_name = "externalBoundaries")]
    pub external_boundaries: Vec<ExternalBoundaryEntry>,
    #[napi(js_name = "fileHashes")]
    pub file_hashes: Vec<FileHashEntry>,
    pub graph: Vec<DependencyGraphEntry>,
    #[napi(js_name = "lazyImports")]
    pub lazy_imports: Vec<LazyImportEntry>,
    #[napi(js_name = "packageAliases")]
    pub package_aliases: Vec<PackageAliasEntry>,
    #[napi(js_name = "resolvedImports")]
    pub resolved_imports: Vec<ResolvedImportEntry>,
    #[napi(js_name = "packageJsonFiles")]
    pub package_json_files: Vec<String>,
    #[napi(js_name = "preservedModules")]
    pub preserved_modules: Vec<PreservedModuleEntry>,
    #[napi(js_name = "sourceFiles")]
    pub source_files: Vec<String>,
    #[napi(js_name = "trackedFiles")]
    pub tracked_files: Vec<String>,
}
