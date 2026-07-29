use super::*;

pub(super) use crate::utils::{hash_content, normalize_path, path_relative_to};

/// Extensions that actually denote a module file. Anything else after the last
/// dot is part of the name, not an extension.
const MODULE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "mts", "cjs", "cts", "json", "node",
];

/// `Path::extension` reports the text after the last dot, so a file named
/// `enum.untyped.ts` imported as `./enum.untyped` looked like it already had an
/// extension (`untyped`) and the `.ts` candidates were never tried. Dots are
/// legal in module names, so the trailing segment only suppresses extension
/// probing when it is an extension we would actually load.
fn has_module_extension(base: &Path) -> bool {
    base.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| MODULE_EXTENSIONS.contains(&extension))
}

pub(super) fn module_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if has_module_extension(base) {
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
