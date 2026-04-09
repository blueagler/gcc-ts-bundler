use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = if path.is_absolute() {
        PathBuf::from(std::path::MAIN_SEPARATOR.to_string())
    } else {
        PathBuf::new()
    };

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::Normal(segment) => normalized.push(segment),
        }
    }

    normalized
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
        short_runtime_id('m', logical_module_id)
    }
}

pub fn to_bundler_runtime_chunk_id(logical_chunk_id: &str) -> String {
    if bundler_runtime_ids_are_readable() {
        logical_chunk_id.to_string()
    } else {
        short_runtime_id('c', logical_chunk_id)
    }
}

fn short_runtime_id(prefix: char, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update([prefix as u8]);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}{hex}")
}
