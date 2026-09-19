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
        .map_or(relative_path.as_ref(), |(prefix, _)| prefix);
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

/// Validate the identities shared by graph planning and emission before either
/// stage can replace a module's facts or write a colliding JavaScript artifact.
pub(crate) fn validate_module_paths<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    workspace_dir: &Path,
) -> Result<(), String> {
    let workspace_dir = normalize_path(workspace_dir);
    let mut module_owners = std::collections::BTreeMap::new();
    let mut output_owners = std::collections::BTreeMap::new();
    for source in paths {
        let path = normalize_path(Path::new(source));
        let relative = path.strip_prefix(&workspace_dir).map_err(|_| {
            format!(
                "Source {} is outside workspace {}",
                path.display(),
                workspace_dir.display()
            )
        })?;
        let output = relative.with_extension("js");
        let module_id = to_goog_module_id(&path, &workspace_dir);
        for (kind, key, owners) in [
            (
                "emitted path",
                output.to_string_lossy().to_string(),
                &mut output_owners,
            ),
            ("module ID", module_id, &mut module_owners),
        ] {
            if let Some(previous) = owners.insert(key.clone(), path.clone()) {
                if previous != path {
                    return Err(format!(
                        "Conflicting {kind} {key:?}: {} and {}",
                        previous.display(),
                        path.display()
                    ));
                }
            }
        }
    }
    Ok(())
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
