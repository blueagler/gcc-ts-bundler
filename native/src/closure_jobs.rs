#![allow(non_snake_case)]

mod chunk_plan;
mod externs;
mod jobs;
mod runtime;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;

use crate::pathing::{
    bundler_runtime_ids_are_readable, to_bundler_runtime_chunk_id, to_bundler_runtime_module_id,
    to_goog_module_id,
};

use self::chunk_plan::*;
use self::externs::*;
use self::jobs::*;
use self::runtime::*;

const BUNDLER_RUNTIME_GLOBAL: &str = "__g";
pub(crate) const BUNDLER_RUNTIME_PREFIX_NAMESPACE: &str = "$gcc";

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
    pub nativeExternPath: String,
    pub outDir: String,
    pub packageRoot: String,
    pub publicPath: String,
    pub supportFiles: Vec<String>,
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
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PostprocessAction {
    pub inputPath: String,
    pub kind: String,
    pub outputPath: String,
    pub propertyRenamingReportPath: Option<String>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChunkMode {
    BundlerRuntime,
    Off,
    Split,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChunkOutputType {
    Esm,
    Script,
}

impl ChunkOutputType {
    pub(crate) fn is_esm(self) -> bool {
        matches!(self, ChunkOutputType::Esm)
    }
}

pub fn prepare_closure_jobs(
    input: PrepareClosureJobsInput,
) -> std::result::Result<PrepareClosureJobsOutput, String> {
    let chunk_mode = parse_chunk_mode(&input.chunkMode)?;
    let chunk_output_type = parse_chunk_output_type(&input.chunkOutputType)?;
    if chunk_output_type.is_esm() && chunk_mode != ChunkMode::BundlerRuntime {
        return Err(format!(
            "chunks.outputType \"esm\" requires chunks.mode \"bundler-runtime\", got {:?}.",
            input.chunkMode
        ));
    }
    let emitted_out_dir = PathBuf::from(&input.emittedOutDir);
    let final_cache_dir = PathBuf::from(&input.finalCacheDir);
    let raw_dir = final_cache_dir.join("raw");
    let runtime_asset_dir = final_cache_dir.join("bundler-runtime");
    let warning_level = if input.diagnosticsVerbose {
        "VERBOSE".to_string()
    } else {
        "QUIET".to_string()
    };
    let resolved_chunks = resolve_chunk_plan(&input.chunkPlan, &emitted_out_dir);

    match chunk_mode {
        ChunkMode::BundlerRuntime => prepare_bundler_runtime_jobs(
            &input,
            &resolved_chunks,
            &raw_dir,
            &runtime_asset_dir,
            &warning_level,
            chunk_output_type,
        ),
        // Split confines globals to one namespace object so plain-script
        // chunks cannot collide with renamed globalThis.* properties; the
        // split prelude declares the namespace before any chunk runs.
        ChunkMode::Off => {
            prepare_off_mode_jobs(&input, &resolved_chunks, &raw_dir, &warning_level, None)
        }
        ChunkMode::Split => prepare_off_mode_jobs(
            &input,
            &resolved_chunks,
            &raw_dir,
            &warning_level,
            Some("$gcc".to_string()),
        ),
    }
}

fn parse_chunk_output_type(value: &str) -> std::result::Result<ChunkOutputType, String> {
    match value {
        "esm" => Ok(ChunkOutputType::Esm),
        "script" => Ok(ChunkOutputType::Script),
        _ => Err(format!("Unsupported chunk output type: {value}")),
    }
}

fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "split" => Ok(ChunkMode::Split),
        "bundler-runtime" => Ok(ChunkMode::BundlerRuntime),
        "off" => Ok(ChunkMode::Off),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

#[cfg(test)]
mod tests;
