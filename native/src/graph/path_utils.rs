use super::*;

pub(super) fn module_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if base.extension().is_some() {
        candidates.push(base.to_path_buf());
        candidates.extend(rewrite_extension_candidates(base));
    } else {
        candidates.push(base.to_path_buf());
        for extension in [
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts", ".json", ".node",
        ] {
            candidates.push(PathBuf::from(format!(
                "{}{}",
                base.to_string_lossy(),
                extension
            )));
        }
        for extension in [
            "index.ts",
            "index.tsx",
            "index.js",
            "index.jsx",
            "index.mjs",
            "index.mts",
            "index.cjs",
            "index.cts",
            "index.json",
            "index.node",
        ] {
            candidates.push(base.join(extension));
        }
    }
    candidates
}

fn rewrite_extension_candidates(base: &Path) -> Vec<PathBuf> {
    let Some(extension) = base.extension().and_then(|value| value.to_str()) else {
        return Vec::new();
    };

    let alternates: &[&str] = match extension {
        "js" => &["ts", "tsx", "mts", "jsx", "mjs"],
        "jsx" => &["tsx", "ts", "js", "mjs"],
        "mjs" => &["mts", "ts", "js", "jsx"],
        _ => &[],
    };

    alternates
        .iter()
        .map(|alternate| base.with_extension(alternate))
        .collect()
}

pub(super) fn path_relative_to(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub(super) fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(_) | Component::Prefix(_) | Component::RootDir => {
                normalized.push(component.as_os_str());
            }
        }
    }

    normalized
}

pub(super) fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
