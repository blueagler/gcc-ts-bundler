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
use self::paths::{
    is_package_source_file, resolve_module_base, resolve_package_local_path, resolve_package_target,
};

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
    let description = format!("import \"{specifier}\"");
    let mut package_json_files = Vec::new();
    let path = if let Some((package_dir, package_json_path, package_json)) =
        find_browser_package_scope(importer, context)?
    {
        package_json_files.push(package_json_path);
        let package_name = package_json
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("<anonymous package>");
        resolve_relative_package_path(
            &base,
            allow_commonjs,
            allowed_root,
            &description,
            importer,
            &package_dir,
            &package_json,
            package_name,
            context,
        )?
    } else {
        resolve_module_base(&base, allow_commonjs, allowed_root, &description, importer)?
    };

    path.map(|path| ResolvedModule {
        package_alias: None,
        package_json_files,
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
            if let Some(target) = package_json.get("browser").and_then(Value::as_str) {
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
            for field_name in ["module", "main"] {
                if let Some(target) = package_json.get(field_name).and_then(Value::as_str) {
                    if let Some(path) = resolve_package_target_with_browser(
                        target,
                        package_dir,
                        package_json,
                        importer,
                        &package_import.package_name,
                        context,
                    )? {
                        return Ok(path);
                    }
                }
            }
        }
    }

    let resolved = if let Some(package_json) = package_json {
        resolve_package_local_path_with_browser(
            package_dir,
            &package_import.subpath,
            package_json,
            importer,
            &package_import.package_name,
            context,
        )?
    } else {
        resolve_package_local_path(
            package_dir,
            &package_import.subpath,
            importer,
            &package_import.package_name,
            context,
        )?
    };
    resolved.ok_or_else(|| {
        format!(
            "Failed to resolve package import \"{}\" from {}",
            format_package_specifier(package_import),
            importer.to_string_lossy()
        )
    })
}

fn resolve_package_target_with_browser(
    target: &str,
    package_dir: &Path,
    package_json: &Value,
    importer: &Path,
    package_name: &str,
    context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    if let Some(browser_target) = resolve_browser_subpath(package_json, target)? {
        return resolve_package_target(
            &browser_target,
            package_dir,
            importer,
            package_name,
            context,
        );
    }
    let resolved = resolve_package_target(target, package_dir, importer, package_name, context)?;
    apply_browser_mapping_to_resolved_path(
        resolved,
        package_dir,
        package_json,
        importer,
        package_name,
        context,
    )
}

fn resolve_package_local_path_with_browser(
    package_dir: &Path,
    subpath: &str,
    package_json: &Value,
    importer: &Path,
    package_name: &str,
    context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    if subpath != "." {
        if let Some(browser_target) = resolve_browser_subpath(package_json, subpath)? {
            return resolve_package_target(
                &browser_target,
                package_dir,
                importer,
                package_name,
                context,
            );
        }
    }
    let resolved =
        resolve_package_local_path(package_dir, subpath, importer, package_name, context)?;
    apply_browser_mapping_to_resolved_path(
        resolved,
        package_dir,
        package_json,
        importer,
        package_name,
        context,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_relative_package_path(
    base: &Path,
    allow_commonjs: bool,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
    package_dir: &Path,
    package_json: &Value,
    package_name: &str,
    context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    if let Some(subpath) = package_subpath(base, package_dir) {
        if let Some(browser_target) = resolve_browser_subpath(package_json, &subpath)? {
            return resolve_package_target(
                &browser_target,
                package_dir,
                importer,
                package_name,
                context,
            );
        }
    }
    let resolved = resolve_module_base(base, allow_commonjs, allowed_root, description, importer)?;
    apply_browser_mapping_to_resolved_path(
        resolved,
        package_dir,
        package_json,
        importer,
        package_name,
        context,
    )
}

fn apply_browser_mapping_to_resolved_path(
    resolved: Option<PathBuf>,
    package_dir: &Path,
    package_json: &Value,
    importer: &Path,
    package_name: &str,
    context: &ResolveContext,
) -> std::result::Result<Option<PathBuf>, String> {
    let Some(path) = resolved else {
        return Ok(None);
    };
    let Some(subpath) = package_subpath(&path, package_dir) else {
        return Ok(Some(path));
    };
    let Some(browser_target) = resolve_browser_subpath(package_json, &subpath)? else {
        return Ok(Some(path));
    };
    resolve_package_target(
        &browser_target,
        package_dir,
        importer,
        package_name,
        context,
    )
}

fn package_subpath(path: &Path, package_dir: &Path) -> Option<String> {
    let relative = path.strip_prefix(package_dir).ok()?;
    Some(format!(
        "./{}",
        relative.to_string_lossy().replace('\\', "/")
    ))
}

fn find_browser_package_scope(
    importer: &Path,
    context: &ResolveContext,
) -> std::result::Result<Option<(PathBuf, PathBuf, Value)>, String> {
    if !is_package_source_file(importer, context) {
        return Ok(None);
    }
    let mut current = importer.parent();
    while let Some(directory) = current {
        if directory
            .file_name()
            .is_some_and(|name| name == "node_modules")
        {
            break;
        }
        let package_json_path = directory.join("package.json");
        if package_json_path.exists() {
            let package_json = read_package_json(&package_json_path)?;
            return if matches!(package_json.get("browser"), Some(Value::Object(_))) {
                Ok(Some((
                    directory.to_path_buf(),
                    package_json_path,
                    package_json,
                )))
            } else {
                Ok(None)
            };
        }
        current = directory.parent();
    }
    Ok(None)
}
