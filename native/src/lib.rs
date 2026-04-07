mod closure_metadata;
mod commonjs;
mod exports;
mod fs_state;
mod graph;
mod module_cache;
mod pathing;
mod shims;
mod support_files;
mod transpile;

use napi::{Error, Result};
use napi_derive::napi;
use swc_core::common::{Globals, GLOBALS};

fn into_napi<T>(result: std::result::Result<T, String>) -> Result<T> {
    result.map_err(Error::from_reason)
}

fn with_globals<T, F>(callback: F) -> Result<T>
where
    F: FnOnce() -> std::result::Result<T, String>,
{
    GLOBALS.set(&Globals::new(), || into_napi(callback()))
}

#[napi(js_name = "resolveGraph")]
pub fn resolve_graph(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
) -> Result<graph::ResolveGraphOutput> {
    with_globals(|| graph::resolve_graph(entries, src_dir, workspace_dir, package_mode))
}

#[napi(js_name = "writeEntryShims")]
pub fn write_entry_shims(entries: Vec<shims::ShimEntry>) -> Result<Vec<String>> {
    into_napi(shims::write_entry_shims(entries))
}

#[napi(js_name = "transpileSources")]
pub fn transpile_sources(
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    metadata_path: String,
    workspace_dir: String,
    package_aliases: Vec<transpile::PackageAliasInput>,
    package_json_files: Vec<String>,
    lazy_imports: Vec<transpile::LazyImportInput>,
) -> Result<transpile::TranspileOutput> {
    into_napi(transpile::transpile_sources(
        file_names,
        out_dir,
        externs_path,
        metadata_path,
        workspace_dir,
        package_aliases,
        package_json_files,
        lazy_imports,
    ))
}

#[napi(js_name = "rewriteGccExports")]
pub fn rewrite_gcc_exports(code: String) -> Result<String> {
    with_globals(|| exports::rewrite_gcc_exports(code))
}

#[napi(js_name = "collectFileStates")]
pub fn collect_file_states(file_paths: Vec<String>) -> Result<Vec<fs_state::FileStateEntry>> {
    Ok(fs_state::collect_file_states(file_paths))
}

#[napi(js_name = "matchFileStates")]
pub fn match_file_states(expected: Vec<fs_state::FileStateEntry>) -> Result<bool> {
    Ok(fs_state::match_file_states(expected))
}

#[napi(js_name = "collectPublishedOutputStats")]
pub fn collect_published_output_stats(
    file_paths: Vec<String>,
) -> Result<Vec<fs_state::PublishedOutputEntry>> {
    Ok(fs_state::collect_published_output_stats(file_paths))
}

#[napi(js_name = "publishedOutputsMatch")]
pub fn published_outputs_match(output_files: Vec<String>, out_dir: String) -> Result<bool> {
    Ok(fs_state::published_outputs_match(output_files, out_dir))
}

#[napi(js_name = "publishedOutputSnapshotMatches")]
pub fn published_output_snapshot_matches(
    published_outputs: Vec<fs_state::PublishedOutputEntry>,
    out_dir: String,
) -> Result<bool> {
    Ok(fs_state::published_output_snapshot_matches(published_outputs, out_dir))
}
