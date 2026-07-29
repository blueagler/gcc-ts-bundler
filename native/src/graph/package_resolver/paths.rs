use std::path::{Path, PathBuf};

use super::super::ResolveContext;
use crate::commonjs::CommonJsAnalysis;
use crate::pathing::normalize_path;

pub(super) fn resolve_package_target(
    target: &str,
    package_dir: &Path,
    importer: &Path,
    package_name: &str,
    _context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    if is_package_relative_target(target) {
        let normalized_target = target.strip_prefix("./").unwrap_or(target);
        let base = normalize_path(&package_dir.join(normalized_target));
        return resolve_module_base(
            &base,
            true,
            package_dir,
            &format!("package \"{package_name}\" target \"{target}\""),
            importer,
        );
    }

    Err(format!(
        "Unsupported export target \"{target}\" in package \"{package_name}\""
    ))
}

pub(super) fn resolve_package_local_path(
    package_dir: &Path,
    subpath: &str,
    importer: &Path,
    package_name: &str,
    _context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    let base = if subpath == "." {
        package_dir.to_path_buf()
    } else {
        normalize_path(&package_dir.join(subpath.trim_start_matches("./")))
    };

    resolve_module_base(
        &base,
        true,
        package_dir,
        &format!("package \"{package_name}\""),
        importer,
    )
}

pub(super) fn resolve_module_base(
    base: &Path,
    allow_commonjs: bool,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
) -> std::result::Result<Option<PathBuf>, String> {
    for candidate in super::super::module_candidates(base) {
        if !candidate.exists() {
            continue;
        }
        if candidate.is_dir() {
            continue;
        }

        validate_candidate(
            &candidate,
            allow_commonjs,
            allowed_root,
            description,
            importer,
        )?;
        return Ok(Some(candidate));
    }

    Ok(None)
}

pub(crate) fn validate_commonjs_usage(
    file_path: &Path,
    analysis: &CommonJsAnalysis,
    context: &ResolveContext,
) -> std::result::Result<(), String> {
    if !is_package_source_file(file_path, context) {
        return Err(format!(
            "CommonJS is only supported for package sources under node_modules: {}",
            file_path.to_string_lossy()
        ));
    }

    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!(
            "Unsupported CommonJS pattern in {}: {}",
            file_path.to_string_lossy(),
            reason,
        ));
    }

    Ok(())
}

fn is_package_relative_target(target: &str) -> bool {
    !target.is_empty()
        && !target.starts_with('/')
        && !target.starts_with("../")
        && !target.contains(':')
}

fn validate_candidate(
    candidate: &Path,
    allow_commonjs: bool,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
) -> std::result::Result<(), String> {
    if !candidate.starts_with(allowed_root) {
        return Err(format!(
            "{} escapes the allowed root from {}",
            description,
            importer.to_string_lossy()
        ));
    }

    let Some(extension) = candidate.extension().and_then(|value| value.to_str()) else {
        return Ok(());
    };
    match extension {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" => Ok(()),
        "cjs" | "cts" if allow_commonjs => Ok(()),
        "cjs" | "cts" => Err(format!(
            "Unsupported CommonJS module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        "json" => Err(format!(
            "Unsupported JSON module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        "node" => Err(format!(
            "Unsupported native addon {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
        _ => Err(format!(
            "Unsupported module {} referenced by {}",
            candidate.to_string_lossy(),
            importer.to_string_lossy()
        )),
    }
}

pub(super) fn is_package_source_file(file_path: &Path, context: &ResolveContext) -> bool {
    file_path.starts_with(context.workspace_dir.join("node_modules"))
        || file_path.starts_with(context.src_dir.join("node_modules"))
}
