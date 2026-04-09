mod exports;
mod parse;
mod paths;

use super::*;

pub(crate) use self::exports::select_package_export_target;
use self::exports::{package_resolution_prefers_debug, resolve_browser_subpath};
use self::parse::{
    find_package_dir, format_package_specifier, is_bare_package_specifier, is_node_builtin,
    parse_package_import, read_package_json,
};
pub(super) use self::paths::validate_commonjs_usage;
use self::paths::{resolve_module_base, resolve_package_local_path, resolve_package_target};

pub(super) fn resolve_module_specifier(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<Option<ResolvedModule>, String> {
    if is_node_builtin(specifier) {
        return Err(format!(
            "Unsupported Node builtin import \"{specifier}\" in {}",
            importer.to_string_lossy()
        ));
    }

    if specifier.starts_with('.') {
        return resolve_relative_module(specifier, importer, context).map(Some);
    }

    if !is_bare_package_specifier(specifier) {
        return Err(format!(
            "Unsupported non-relative import \"{specifier}\" in {}",
            importer.to_string_lossy()
        ));
    }

    match context.package_mode {
        PackageMode::Off => Err(format!(
            "Package import \"{specifier}\" is not allowed when packages.mode is off"
        )),
        PackageMode::EsmOnly => resolve_package_import(specifier, importer, context).map(Some),
    }
}

fn resolve_relative_module(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<ResolvedModule, String> {
    let importer_dir = importer.parent().ok_or_else(|| {
        format!(
            "Cannot resolve import \"{specifier}\" from {}",
            importer.to_string_lossy()
        )
    })?;
    let allowed_root = if importer.starts_with(context.src_dir) {
        context.src_dir
    } else {
        context.workspace_dir
    };
    let allow_commonjs = !importer.starts_with(context.src_dir);
    let base = normalize_path(&importer_dir.join(specifier));
    resolve_module_base(
        &base,
        allow_commonjs,
        allowed_root,
        &format!("import \"{specifier}\""),
        importer,
    )?
    .map(|path| ResolvedModule {
        package_alias: None,
        package_json_files: Vec::new(),
        path,
    })
    .ok_or_else(|| {
        format!(
            "Failed to resolve import \"{specifier}\" from {}",
            importer.to_string_lossy()
        )
    })
}

fn resolve_package_import(
    specifier: &str,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<ResolvedModule, String> {
    let package_import = parse_package_import(specifier)?;
    let package_dir =
        find_package_dir(importer, &package_import.package_name).ok_or_else(|| {
            format!(
                "Failed to resolve package \"{}\" from {}",
                package_import.package_name,
                importer.to_string_lossy()
            )
        })?;
    let package_json_path = package_dir.join("package.json");
    let mut package_json_files = Vec::new();
    let package_json = if package_json_path.exists() {
        package_json_files.push(package_json_path.clone());
        Some(read_package_json(&package_json_path)?)
    } else {
        None
    };

    let path = resolve_package_path(
        &package_import,
        &package_dir,
        package_json.as_ref(),
        importer,
        context,
    )?;
    Ok(ResolvedModule {
        package_alias: Some(PackageAliasEntry {
            packageName: package_import.package_name.clone(),
            subpath: package_import.subpath.clone(),
            targetPath: path.to_string_lossy().to_string(),
        }),
        package_json_files,
        path,
    })
}

fn resolve_package_path(
    package_import: &PackageImport,
    package_dir: &Path,
    package_json: Option<&Value>,
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<PathBuf, String> {
    if let Some(package_json) = package_json {
        let prefer_debug_exports = package_resolution_prefers_debug();
        if let Some(exports) = package_json.get("exports") {
            if let Some(target) = select_package_export_target(
                exports,
                &package_import.subpath,
                &package_import.package_name,
                prefer_debug_exports,
            )? {
                if let Some(path) = resolve_package_target(
                    &target,
                    package_dir,
                    importer,
                    &package_import.package_name,
                    context,
                )? {
                    return Ok(path);
                }
            }
        }

        if package_import.subpath == "." {
            for field_name in ["browser", "module", "main"] {
                if let Some(target) = package_json.get(field_name).and_then(Value::as_str) {
                    if let Some(path) = resolve_package_target(
                        target,
                        package_dir,
                        importer,
                        &package_import.package_name,
                        context,
                    )? {
                        return Ok(path);
                    }
                }
            }
        } else if let Some(target) = resolve_browser_subpath(package_json, &package_import.subpath)?
        {
            if let Some(path) = resolve_package_target(
                &target,
                package_dir,
                importer,
                &package_import.package_name,
                context,
            )? {
                return Ok(path);
            }
        }
    }

    resolve_package_local_path(
        package_dir,
        &package_import.subpath,
        importer,
        &package_import.package_name,
        context,
    )?
    .ok_or_else(|| {
        format!(
            "Failed to resolve package import \"{}\" from {}",
            format_package_specifier(package_import),
            importer.to_string_lossy()
        )
    })
}
