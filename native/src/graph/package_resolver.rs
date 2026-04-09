use super::*;

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

pub(super) fn select_package_export_target(
    exports: &Value,
    subpath: &str,
    package_name: &str,
    prefer_debug_exports: bool,
) -> std::result::Result<Option<String>, String> {
    let production_target = resolve_package_exports_with_conditions(
        exports,
        subpath,
        package_name,
        &["browser", "production", "import", "default"],
    )?;
    let default_target = resolve_package_exports_with_conditions(
        exports,
        subpath,
        package_name,
        &["browser", "import", "default"],
    )?;
    let development_target = resolve_package_exports_with_conditions(
        exports,
        subpath,
        package_name,
        &["browser", "development", "import", "default"],
    )?;

    if prefer_debug_exports {
        Ok(development_target.or(default_target).or(production_target))
    } else {
        Ok(production_target.or(default_target).or(development_target))
    }
}

fn package_resolution_prefers_debug() -> bool {
    matches!(std::env::var("GCC_CLOSURE_DEBUG").as_deref(), Ok("1"))
}

fn resolve_package_exports_with_conditions(
    exports: &Value,
    subpath: &str,
    package_name: &str,
    preferred_conditions: &[&str],
) -> std::result::Result<Option<String>, String> {
    match exports {
        Value::String(_) | Value::Array(_) => {
            if subpath == "." {
                resolve_export_target_value(exports, package_name, preferred_conditions)
            } else {
                Ok(None)
            }
        }
        Value::Object(object) => {
            if object.keys().any(|key| key.starts_with('.')) {
                if let Some(value) = object.get(subpath) {
                    return resolve_export_target_value(value, package_name, preferred_conditions);
                }

                if let Some((pattern, value)) = match_exports_pattern(object, subpath) {
                    if let Some(target) =
                        resolve_export_target_value(value, package_name, preferred_conditions)?
                    {
                        let capture = extract_pattern_capture(pattern, subpath);
                        return Ok(Some(target.replace('*', &capture)));
                    }
                }

                Ok(None)
            } else if subpath == "." {
                resolve_export_target_value(exports, package_name, preferred_conditions)
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

fn resolve_export_target_value(
    value: &Value,
    package_name: &str,
    preferred_conditions: &[&str],
) -> std::result::Result<Option<String>, String> {
    match value {
        Value::String(target) => Ok(Some(target.clone())),
        Value::Array(values) => {
            for value in values {
                if let Some(target) =
                    resolve_export_target_value(value, package_name, preferred_conditions)?
                {
                    return Ok(Some(target));
                }
            }
            Ok(None)
        }
        Value::Object(object) => {
            for condition in preferred_conditions {
                if let Some(value) = object.get(*condition) {
                    return resolve_export_target_value(value, package_name, preferred_conditions);
                }
            }
            Ok(None)
        }
        Value::Bool(false) | Value::Null => Err(format!(
            "Package \"{package_name}\" disables this export for browser-safe ESM bundling"
        )),
        _ => Ok(None),
    }
}

fn resolve_browser_subpath(
    package_json: &Value,
    subpath: &str,
) -> std::result::Result<Option<String>, String> {
    let Some(browser_field) = package_json.get("browser") else {
        return Ok(None);
    };

    let Value::Object(object) = browser_field else {
        return Ok(None);
    };

    for key in [subpath.to_string(), format!("{subpath}.js")] {
        if let Some(value) = object.get(&key) {
            return match value {
                Value::String(target) => Ok(Some(target.clone())),
                Value::Bool(false) | Value::Null => Err(format!(
                    "Package subpath \"{subpath}\" is disabled by the browser field"
                )),
                _ => Ok(None),
            };
        }
    }

    Ok(None)
}

fn resolve_package_target(
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

fn is_package_relative_target(target: &str) -> bool {
    !target.is_empty()
        && !target.starts_with('/')
        && !target.starts_with("../")
        && !target.contains(':')
}

fn resolve_package_local_path(
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

fn resolve_module_base(
    base: &Path,
    allow_commonjs: bool,
    allowed_root: &Path,
    description: &str,
    importer: &Path,
) -> std::result::Result<Option<PathBuf>, String> {
    for candidate in module_candidates(base) {
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

pub(super) fn validate_commonjs_usage(
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

fn parse_package_import(specifier: &str) -> std::result::Result<PackageImport, String> {
    if specifier.starts_with('@') {
        let mut segments = specifier.split('/');
        let scope = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?;
        let package_name = format!("{scope}/{name}");
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    } else {
        let mut segments = specifier.split('/');
        let package_name = segments
            .next()
            .ok_or_else(|| format!("Invalid package specifier \"{specifier}\""))?
            .to_string();
        let remainder = segments.collect::<Vec<_>>().join("/");
        Ok(PackageImport {
            package_name,
            subpath: if remainder.is_empty() {
                ".".to_string()
            } else {
                format!("./{remainder}")
            },
        })
    }
}

fn find_package_dir(importer: &Path, package_name: &str) -> Option<PathBuf> {
    let mut current = importer.parent();

    while let Some(directory) = current {
        let candidate = directory.join("node_modules").join(package_name);
        if candidate.exists() {
            return Some(candidate);
        }
        current = directory.parent();
    }

    None
}

fn read_package_json(path: &Path) -> std::result::Result<Value, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| format!("{}: {error}", path.to_string_lossy()))
}

fn match_exports_pattern<'a>(
    object: &'a serde_json::Map<String, Value>,
    subpath: &str,
) -> Option<(&'a str, &'a Value)> {
    object
        .iter()
        .filter_map(|(pattern, value)| {
            if !pattern.contains('*') || !subpath.starts_with("./") {
                return None;
            }
            let prefix = pattern.split('*').next()?;
            let suffix = pattern.split('*').nth(1)?;
            if subpath.starts_with(prefix) && subpath.ends_with(suffix) {
                Some((pattern.as_str(), value))
            } else {
                None
            }
        })
        .max_by_key(|(pattern, _)| pattern.len())
}

fn extract_pattern_capture(pattern: &str, subpath: &str) -> String {
    let prefix = pattern.split('*').next().unwrap_or_default();
    let suffix = pattern.split('*').nth(1).unwrap_or_default();
    subpath
        .trim_start_matches(prefix)
        .trim_end_matches(suffix)
        .to_string()
}

fn format_package_specifier(package_import: &PackageImport) -> String {
    if package_import.subpath == "." {
        package_import.package_name.clone()
    } else {
        format!(
            "{}/{}",
            package_import.package_name,
            package_import.subpath.trim_start_matches("./")
        )
    }
}

fn is_bare_package_specifier(specifier: &str) -> bool {
    !specifier.starts_with('/') && !specifier.contains(':')
}

fn is_node_builtin(specifier: &str) -> bool {
    if specifier.starts_with("node:") {
        return true;
    }
    if specifier.starts_with('@') {
        return false;
    }

    let root = specifier.split('/').next().unwrap_or(specifier);
    matches!(
        root,
        "_http_agent"
            | "_http_client"
            | "_http_common"
            | "_http_incoming"
            | "_http_outgoing"
            | "_http_server"
            | "_stream_duplex"
            | "_stream_passthrough"
            | "_stream_readable"
            | "_stream_transform"
            | "_stream_wrap"
            | "_stream_writable"
            | "_tls_common"
            | "_tls_wrap"
            | "assert"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "domain"
            | "events"
            | "fs"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "module"
            | "net"
            | "os"
            | "path"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "repl"
            | "stream"
            | "string_decoder"
            | "sys"
            | "timers"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "v8"
            | "vm"
            | "worker_threads"
            | "zlib"
    )
}

fn is_package_source_file(file_path: &Path, context: &ResolveContext) -> bool {
    file_path.starts_with(context.workspace_dir.join("node_modules"))
}
