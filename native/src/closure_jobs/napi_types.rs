use napi_derive::napi;

use crate::closure_metadata::{EmittedTypeMetadata, TypeMetadataCounts};

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureJobChunkPlanChunkInput {
    pub dependencies: Vec<String>,
    pub entryFiles: Option<Vec<String>>,
    pub files: Vec<String>,
    pub kind: Option<String>,
    pub lazyModuleIds: Option<Vec<String>>,
    pub name: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsInput {
    pub chunkMode: String,
    pub chunkLoader: String,
    /// Resolved chunk output shape: `"script"` or `"esm"`, never `"auto"`.
    pub chunkOutputType: String,
    pub chunkPlan: Vec<ClosureJobChunkPlanChunkInput>,
    pub compilationLevel: String,
    pub diagnosticsVerbose: bool,
    pub emittedOutDir: String,
    pub explicitExternPaths: Vec<String>,
    pub explicitJsInputs: Vec<String>,
    pub finalCacheDir: String,
    pub generatedExternPaths: Vec<String>,
    pub languageOut: String,
    pub manifestFile: String,
    /// Preserved ESM boundaries are intentionally conservative: they retain the
    /// runtime even when their compiled side is otherwise a one-chunk graph.
    pub hasPreservedModules: bool,
    pub nativeExternPath: String,
    /// Whether the consumer can attach CSS rows to the runtime manifest after
    /// the compile. Standalone builds never do; the Vite plugin does, and
    /// answers from its pre-compile CSS-ownership scan. Gates the `<link>`
    /// loader and the per-chunk CSS fan-out out of the runtime preamble.
    pub needsCssRuntime: bool,
    pub outDir: String,
    pub packageRoot: String,
    pub publicPath: String,
    pub supportFiles: Vec<String>,
    pub typeMetadata: Vec<EmittedTypeMetadata>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct GeneratedAsset {
    pub path: String,
    pub text: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureCompileJob {
    pub assumeFunctionWrapper: bool,
    pub chunk: Option<Vec<String>>,
    pub chunkOutputPathPrefix: Option<String>,
    /// Closure `--chunk_output_type`. `None` leaves the compiler default
    /// (`GLOBAL_NAMESPACE`) in place, so script-mode jobs stay unchanged.
    pub chunkOutputType: Option<String>,
    pub compilationLevel: String,
    pub dependencyMode: Option<String>,
    pub entryPoint: Option<Vec<String>>,
    pub externs: Vec<String>,
    pub js: Vec<String>,
    pub jsOutputFile: Option<String>,
    pub languageIn: String,
    pub languageOut: String,
    pub propertyRenamingReportPath: Option<String>,
    pub renamePrefixNamespace: Option<String>,
    pub rewritePolyfills: bool,
    pub warningLevel: String,
    pub hasTypeMetadata: bool,
    pub typeMetadataCounts: TypeMetadataCounts,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PostprocessAction {
    pub inputPath: String,
    pub kind: String,
    pub outputPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsOutput {
    pub bundlerRuntimeBaseInputPath: Option<String>,
    pub compileJobs: Vec<ClosureCompileJob>,
    pub generatedAssets: Vec<GeneratedAsset>,
    pub postprocessActions: Vec<PostprocessAction>,
    pub publishedOutputs: Vec<String>,
}
