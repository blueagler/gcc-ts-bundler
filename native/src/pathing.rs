use std::path::{Component, Path, PathBuf};

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
                segment.replace(|char: char| !(char.is_ascii_alphanumeric() || char == '_' || char == '$'), "_")
            })
            .collect::<Vec<_>>()
            .join(".")
    )
}
