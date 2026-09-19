use napi_derive::napi;

use crate::closure_metadata::TypeMetadataCounts;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureJobChunkPlanChunkInput {
    pub dependencies: Vec<String>,
    #[napi(js_name = "entryFiles")]
    pub entry_files: Option<Vec<String>>,
    pub files: Vec<String>,
    pub kind: Option<String>,
    #[napi(js_name = "lazyModuleIds")]
    pub lazy_module_ids: Option<Vec<String>>,
    pub name: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureJobTypeMetadata {
    pub counts: TypeMetadataCounts,
    #[napi(js_name = "emittedFile")]
    pub emitted_file: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GeneratedExternInput {
    pub path: String,
    #[napi(js_name = "entryFiles")]
    pub entry_files: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsInput {
    #[napi(js_name = "chunkMode")]
    pub chunk_mode: String,
    #[napi(js_name = "chunkLoader")]
    pub chunk_loader: String,
    /// Resolved chunk output shape: `"script"` or `"esm"`, never `"auto"`.
    #[napi(js_name = "chunkOutputType")]
    pub chunk_output_type: String,
    #[napi(js_name = "chunkPlan")]
    pub chunk_plan: Vec<ClosureJobChunkPlanChunkInput>,
    #[napi(js_name = "compilationLevel")]
    pub compilation_level: String,
    #[napi(js_name = "diagnosticsVerbose")]
    pub diagnostics_verbose: bool,
    #[napi(js_name = "emittedOutDir")]
    pub emitted_out_dir: String,
    #[napi(js_name = "explicitExternPaths")]
    pub explicit_extern_paths: Vec<String>,
    #[napi(js_name = "explicitJsInputs")]
    pub explicit_js_inputs: Vec<String>,
    #[napi(js_name = "finalCacheDir")]
    pub final_cache_dir: String,
    #[napi(js_name = "generatedExterns")]
    pub generated_externs: Vec<GeneratedExternInput>,
    #[napi(js_name = "languageOut")]
    pub language_out: String,
    #[napi(js_name = "manifestFile")]
    pub manifest_file: String,
    /// Preserved ESM boundaries are intentionally conservative: they retain the
    /// runtime even when their compiled side is otherwise a one-chunk graph.
    #[napi(js_name = "hasPreservedModules")]
    pub has_preserved_modules: bool,
    #[napi(js_name = "nativeExternPath")]
    pub native_extern_path: String,
    /// Whether the consumer can attach CSS rows to the runtime manifest after
    /// the compile. Standalone builds never do; the Vite plugin does, and
    /// answers from its pre-compile CSS-ownership scan. Gates the `<link>`
    /// loader and the per-chunk CSS fan-out out of the runtime preamble.
    #[napi(js_name = "needsCssRuntime")]
    pub needs_css_runtime: bool,
    #[napi(js_name = "outDir")]
    pub out_dir: String,
    #[napi(js_name = "packageRoot")]
    pub package_root: String,
    #[napi(js_name = "publicPath")]
    pub public_path: String,
    #[napi(js_name = "supportFiles")]
    pub support_files: Vec<String>,
    #[napi(js_name = "typeMetadata")]
    pub type_metadata: Vec<ClosureJobTypeMetadata>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GeneratedAsset {
    pub path: String,
    pub text: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureCompileJob {
    #[napi(js_name = "assumeFunctionWrapper")]
    pub assume_function_wrapper: bool,
    pub chunk: Option<Vec<String>>,
    #[napi(js_name = "chunkOutputPathPrefix")]
    pub chunk_output_path_prefix: Option<String>,
    /// Closure `--chunk_output_type`. `None` leaves the compiler default
    /// (`GLOBAL_NAMESPACE`) in place, so script-mode jobs stay unchanged.
    #[napi(js_name = "chunkOutputType")]
    pub chunk_output_type: Option<String>,
    #[napi(js_name = "compilationLevel")]
    pub compilation_level: String,
    #[napi(js_name = "dependencyMode")]
    pub dependency_mode: Option<String>,
    #[napi(js_name = "entryPoint")]
    pub entry_point: Option<Vec<String>>,
    pub externs: Vec<String>,
    pub js: Vec<String>,
    #[napi(js_name = "jsOutputFile")]
    pub js_output_file: Option<String>,
    #[napi(js_name = "languageIn")]
    pub language_in: String,
    #[napi(js_name = "languageOut")]
    pub language_out: String,
    #[napi(js_name = "propertyRenamingReportPath")]
    pub property_renaming_report_path: Option<String>,
    #[napi(js_name = "renamePrefixNamespace")]
    pub rename_prefix_namespace: Option<String>,
    #[napi(js_name = "rewritePolyfills")]
    pub rewrite_polyfills: bool,
    #[napi(js_name = "warningLevel")]
    pub warning_level: String,
    #[napi(js_name = "hasTypeMetadata")]
    pub has_type_metadata: bool,
    #[napi(js_name = "typeMetadataCounts")]
    pub type_metadata_counts: TypeMetadataCounts,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PostprocessAction {
    #[napi(js_name = "inputPath")]
    pub input_path: String,
    pub kind: String,
    #[napi(js_name = "outputPath")]
    pub output_path: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsOutput {
    #[napi(js_name = "bundlerRuntimeBaseInputPath")]
    pub bundler_runtime_base_input_path: Option<String>,
    #[napi(js_name = "compileJobs")]
    pub compile_jobs: Vec<ClosureCompileJob>,
    #[napi(js_name = "generatedAssets")]
    pub generated_assets: Vec<GeneratedAsset>,
    #[napi(js_name = "postprocessActions")]
    pub postprocess_actions: Vec<PostprocessAction>,
    #[napi(js_name = "publishedOutputs")]
    pub published_outputs: Vec<String>,
}
