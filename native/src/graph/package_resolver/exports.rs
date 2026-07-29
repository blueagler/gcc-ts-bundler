use std::path::Path;

use serde_json::Value;

pub(crate) fn select_package_export_target(
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

pub(super) fn package_resolution_prefers_debug() -> bool {
    matches!(std::env::var("GCC_CLOSURE_DEBUG").as_deref(), Ok("1"))
}

pub(super) fn resolve_package_exports_with_conditions(
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

pub(super) fn resolve_browser_subpath(
    package_json: &Value,
    requested_path: &str,
) -> std::result::Result<Option<String>, String> {
    let Some(browser_field) = package_json.get("browser") else {
        return Ok(None);
    };

    let Value::Object(object) = browser_field else {
        return Ok(None);
    };

    let requested_path = requested_path.replace('\\', "/");
    let normalized_path = format!("./{}", requested_path.trim_start_matches("./"));
    let mut keys = vec![requested_path];
    if keys[0] != normalized_path {
        keys.push(normalized_path);
    }
    for extension in ["js", "json"] {
        for key in keys.clone() {
            if Path::new(&key).extension().is_none() {
                keys.push(format!("{key}.{extension}"));
            }
        }
    }

    for key in keys {
        if let Some(value) = object.get(&key) {
            return match value {
                Value::String(target) => Ok(Some(target.clone())),
                Value::Bool(false) | Value::Null => Err(format!(
                    "Package path \"{key}\" is disabled by the browser field"
                )),
                _ => Ok(None),
            };
        }
    }

    Ok(None)
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
