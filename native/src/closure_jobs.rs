#![allow(non_snake_case)]

mod chunk_plan;
mod externs;
mod jobs;
mod napi_types;
mod runtime;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::pathing::{
    bundler_runtime_ids_are_readable, to_bundler_runtime_chunk_id, to_bundler_runtime_module_id,
    to_goog_module_id,
};

use self::chunk_plan::*;
use self::externs::*;
use self::jobs::*;
use self::runtime::*;

pub use napi_types::*;

const BUNDLER_RUNTIME_GLOBAL: &str = "__g";
pub(crate) const BUNDLER_RUNTIME_PREFIX_NAMESPACE: &str = "$gcc";

/// Emission shape for chunked output.
///
/// `split` is deliberately absent: it names the same emission shape as
/// `bundler-runtime` (shared chunk graph, graph-derived renameable module ids,
/// shared capability-gated runtime, envelope chosen by the output-type gate) and
/// is folded into it at the parse boundary. Keeping one variant per shape rather
/// than one per public mode name is what stops a shape decision from silently
/// applying to only one of the two.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChunkMode {
    BundlerRuntime,
    Off,
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
        ChunkMode::Off => prepare_off_mode_jobs(
            &input,
            &resolved_chunks,
            &raw_dir,
            &warning_level,
            chunk_output_type,
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
        "split" | "bundler-runtime" => Ok(ChunkMode::BundlerRuntime),
        "off" => Ok(ChunkMode::Off),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

#[cfg(test)]
mod tests;
