use std::path::Path;

pub use crate::utils::normalize_path;
use crate::utils::short_stable_id;

/// Suffix the chunk planner appends to the base chunk name to name the
/// vendor chunk.
///
/// It is a shared constant because two crates-worth of code recognise a
/// vendor chunk by it: the planner mints the name, and hoisted emission has
/// to know which modules land there so it can pin their mutable state
/// (`transpile::assigners`). Only the chunk name and file list cross the napi
/// boundary into the transpiler, so the name *is* the channel.
pub const VENDOR_CHUNK_NAME_SUFFIX: &str = "-vendor";

pub fn vendor_chunk_name(base_chunk_name: &str) -> String {
    format!("{base_chunk_name}{VENDOR_CHUNK_NAME_SUFFIX}")
}

pub fn to_goog_module_id(file_path: &Path, root_dir: &Path) -> String {
    let normalized_path = normalize_path(file_path);
    let relative_path = normalized_path
        .strip_prefix(root_dir)
        .unwrap_or(&normalized_path)
        .to_string_lossy()
        .replace('\\', "/");
    let without_extension = relative_path
        .rsplit_once('.')
        .map(|(prefix, _)| prefix)
        .unwrap_or(relative_path.as_ref());
    format!(
        "gcc.{}",
        without_extension
            .split('/')
            .map(|segment| {
                segment.replace(
                    |char: char| !(char.is_ascii_alphanumeric() || char == '_' || char == '$'),
                    "_",
                )
            })
            .collect::<Vec<_>>()
            .join(".")
    )
}

pub fn bundler_runtime_ids_are_readable() -> bool {
    matches!(std::env::var("GCC_CLOSURE_DEBUG").as_deref(), Ok("1"))
}

pub fn to_bundler_runtime_module_id(logical_module_id: &str) -> String {
    if bundler_runtime_ids_are_readable() {
        logical_module_id.to_string()
    } else {
        short_stable_id('m', logical_module_id)
    }
}

pub fn to_bundler_runtime_chunk_id(logical_chunk_id: &str) -> String {
    if bundler_runtime_ids_are_readable() {
        logical_chunk_id.to_string()
    } else {
        short_stable_id('c', logical_chunk_id)
    }
}
