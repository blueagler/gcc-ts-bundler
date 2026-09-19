use napi_derive::napi;

use crate::closure_metadata::EmittedTypeMetadata;

#[napi(object)]
pub struct TranspileSourcesInput {
    #[napi(js_name = "fileNames")]
    pub file_names: Vec<String>,
    #[napi(js_name = "explicitExternPaths")]
    pub explicit_extern_paths: Vec<String>,
    #[napi(js_name = "outDir")]
    pub out_dir: String,
    #[napi(js_name = "externsPath")]
    pub externs_path: String,
    #[napi(js_name = "metadataPath")]
    pub metadata_path: String,
    #[napi(js_name = "chunkMode")]
    pub chunk_mode: String,
    pub target: String,
    #[napi(js_name = "runtimeModuleSourceMapFile")]
    pub runtime_module_source_map_file: Option<String>,
    #[napi(js_name = "workspaceDir")]
    pub workspace_dir: String,
    #[napi(js_name = "packageAliases")]
    pub package_aliases: Vec<PackageAliasInput>,
    #[napi(js_name = "resolvedImports")]
    pub resolved_imports: Vec<ResolvedImportInput>,
    #[napi(js_name = "externalBoundaries")]
    pub external_boundaries: Vec<ExternalBoundaryInput>,
    #[napi(js_name = "opaqueExternalSpecifiers")]
    pub opaque_external_specifiers: Vec<String>,
    #[napi(js_name = "packageJsonFiles")]
    pub package_json_files: Vec<String>,
    #[napi(js_name = "preservedModules")]
    pub preserved_modules: Vec<PreservedModuleInput>,
    #[napi(js_name = "lazyImports")]
    pub lazy_imports: Vec<LazyImportInput>,
    #[napi(js_name = "chunkGraph")]
    pub chunk_graph: Vec<TranspileChunkInput>,
    #[napi(js_name = "classMapCalls")]
    pub class_map_calls: Vec<ClassMapCallInput>,
    #[napi(js_name = "pureCallees")]
    pub pure_callees: Vec<String>,
    #[napi(js_name = "typeInferenceDisabled")]
    pub type_inference_disabled: bool,
}

#[napi(object)]
pub struct TranspileOutput {
    #[napi(js_name = "emittedFiles")]
    pub emitted_files: Vec<String>,
    #[napi(js_name = "explicitExternPropertyCount")]
    pub explicit_extern_property_count: u32,
    #[napi(js_name = "externsPath")]
    pub externs_path: String,
    #[napi(js_name = "preservedImports")]
    pub preserved_imports: Vec<PreservedImportOutput>,
    #[napi(js_name = "supportFiles")]
    pub support_files: Vec<String>,
    #[napi(js_name = "typeMetadata")]
    pub type_metadata: Vec<EmittedTypeMetadata>,
    pub warnings: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasInput {
    #[napi(js_name = "packageName")]
    pub package_name: String,
    pub subpath: String,
    #[napi(js_name = "targetPath")]
    pub target_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedModuleInput {
    #[napi(js_name = "exportNames")]
    pub export_names: Vec<String>,
    #[napi(js_name = "filePath")]
    pub file_path: String,
    #[napi(js_name = "hasDefaultExport")]
    pub has_default_export: bool,
    #[napi(js_name = "moduleId")]
    pub module_id: String,
    #[napi(js_name = "outputRelativePath")]
    pub output_relative_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedImportOutput {
    #[napi(js_name = "boundaryExports")]
    pub boundary_exports: Vec<String>,
    #[napi(js_name = "boundaryNames")]
    pub boundary_names: Vec<String>,
    #[napi(js_name = "externalSpecifier")]
    pub external_specifier: Option<String>,
    #[napi(js_name = "importClause")]
    pub import_clause: String,
    #[napi(js_name = "importerFilePath")]
    pub importer_file_path: String,
    #[napi(js_name = "targetModuleId")]
    pub target_module_id: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ExternalBoundaryInput {
    #[napi(js_name = "importerFilePath")]
    pub importer_file_path: String,
    pub specifier: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResolvedImportInput {
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
pub struct LazyImportInput {
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
pub struct TranspileChunkInput {
    /// Names of the chunks the loader guarantees have executed before this
    /// one. Read by `build_hoist_plan` to decide whether a cross-chunk direct
    /// binding is legal.
    pub dependencies: Vec<String>,
    pub files: Vec<String>,
    pub name: String,
}

/// A runtime call whose object-literal argument keys must survive property
/// renaming (framework class-map/vnode helpers). Supplied by framework
/// presets. When `keyPattern` is set, only matching keys are quoted.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClassMapCallInput {
    #[napi(js_name = "argIndex")]
    pub arg_index: u32,
    pub callee: String,
    /// Keys matching this regex are left alone even when `keyPattern`
    /// admits them.
    #[napi(js_name = "keyExcludePattern")]
    pub key_exclude_pattern: Option<String>,
    #[napi(js_name = "keyPattern")]
    pub key_pattern: Option<String>,
    /// When set, the rule applies only if the argument at this index is a
    /// string literal or an immutable value produced by another matching
    /// literal-gated call. This lets element transforms such as cloneElement
    /// inherit proven host-element provenance without freezing component props.
    #[napi(js_name = "stringLiteralArgIndex")]
    pub string_literal_arg_index: Option<u32>,
    /// When set, the rule matches only when the callee binding was imported
    /// from a module whose specifier matches this regex. Callee spelling is
    /// local and meaningless for default imports and compiler-generated
    /// aliases, so import identity is what a rule can rely on.
    #[napi(js_name = "calleeModulePattern")]
    pub callee_module_pattern: Option<String>,
    /// Where the keys of the pinned map live in the matched argument:
    ///
    /// * `"objectLiteral"` (default) - keys of an object literal argument;
    /// * `"pairArray"` - first elements of the entries of an array-literal
    ///   argument, the `[["render", fn], ["__scopeId", id]]` shape helper
    ///   functions splat onto a target with `target[key] = value`.
    #[napi(js_name = "keySource")]
    pub key_source: Option<String>,
}
