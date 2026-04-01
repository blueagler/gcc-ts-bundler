use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::pathing::{normalize_path, to_goog_module_id};
use crate::transpile::PackageAliasInput;

pub fn collect_commonjs_specifiers(
    package_aliases: &[PackageAliasInput],
) -> std::result::Result<BTreeSet<String>, String> {
    let mut specifiers = BTreeSet::new();
    for alias in package_aliases {
        if !is_commonjs_package_target(Path::new(&alias.targetPath))? {
            continue;
        }
        let specifier = if alias.subpath == "." {
            alias.packageName.clone()
        } else {
            format!("{}/{}", alias.packageName, alias.subpath.trim_start_matches("./"))
        };
        specifiers.insert(specifier);
    }
    Ok(specifiers)
}

pub fn emit_package_support_files(
    out_dir: &Path,
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    package_json_files: &[String],
) -> std::result::Result<Vec<String>, String> {
    let mut support_files = BTreeSet::new();
    let root_package_names = package_aliases
        .iter()
        .filter(|alias| alias.subpath == ".")
        .map(|alias| alias.packageName.clone())
        .collect::<BTreeSet<_>>();

    for package_json_file in package_json_files {
        let package_json_path = PathBuf::from(package_json_file);
        let package_dir = package_json_path
            .parent()
            .ok_or_else(|| format!("Invalid package.json path: {}", package_json_path.display()))?;
        let package_name = package_dir
            .strip_prefix(workspace_dir.join("node_modules"))
            .unwrap_or(package_dir)
            .to_string_lossy()
            .replace('\\', "/");
        if root_package_names.contains(&package_name) {
            continue;
        }

        let output_path = out_dir.join(
            package_json_path
                .strip_prefix(workspace_dir)
                .unwrap_or(&package_json_path),
        );
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&package_json_path, &output_path).map_err(|error| error.to_string())?;
        support_files.insert(output_path.to_string_lossy().to_string());
    }

    for alias in package_aliases {
        let target_path = to_emitted_path(Path::new(&alias.targetPath), out_dir, workspace_dir);
        let package_dir = out_dir.join("node_modules").join(&alias.packageName);
        if alias.subpath == "." {
            fs::create_dir_all(&package_dir).map_err(|error| error.to_string())?;
            let entry_file = package_dir.join("__gcc_entry__.js");
            let package_json_output = package_dir.join("package.json");
            let module_text = if is_commonjs_package_target(Path::new(&alias.targetPath))? {
                create_commonjs_reexport_module(&entry_file, &target_path, out_dir)
            } else {
                create_reexport_module(&entry_file, &target_path, out_dir)
            };
            fs::write(&entry_file, module_text).map_err(|error| error.to_string())?;
            fs::write(
                &package_json_output,
                serde_json::to_string_pretty(&serde_json::json!({
                    "browser": "./__gcc_entry__.js",
                    "main": "./__gcc_entry__.js",
                    "module": "./__gcc_entry__.js",
                    "name": alias.packageName,
                }))
                .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            support_files.insert(entry_file.to_string_lossy().to_string());
            support_files.insert(package_json_output.to_string_lossy().to_string());
            continue;
        }

        let alias_file = to_alias_file_path(&package_dir, &alias.subpath);
        if normalize_path(&alias_file) == normalize_path(&target_path) {
            continue;
        }
        if let Some(parent) = alias_file.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let module_text = if is_commonjs_package_target(Path::new(&alias.targetPath))? {
            create_commonjs_reexport_module(&alias_file, &target_path, out_dir)
        } else {
            create_reexport_module(&alias_file, &target_path, out_dir)
        };
        fs::write(&alias_file, module_text).map_err(|error| error.to_string())?;
        support_files.insert(alias_file.to_string_lossy().to_string());
    }

    Ok(support_files.into_iter().collect())
}

fn is_commonjs_package_target(target_path: &Path) -> std::result::Result<bool, String> {
    let source_text = fs::read_to_string(target_path).map_err(|error| error.to_string())?;
    Ok(
        target_path.extension().and_then(|value| value.to_str()) == Some("cjs")
            || source_text.contains("module.exports")
            || source_text.contains("exports.")
            || source_text.contains("exports[")
            || source_text.contains("require("),
    )
}

fn create_reexport_module(from_path: &Path, target_path: &Path, out_dir: &Path) -> String {
    let module_id = to_goog_module_id(target_path, out_dir);
    [
        format!("goog.module({:?});", to_goog_module_id(from_path, out_dir)),
        format!("const __module = goog.require({module_id:?});"),
        "for (const key in __module) {".to_string(),
        "  if (key !== \"default\") {".to_string(),
        "    exports[key] = __module[key];".to_string(),
        "  }".to_string(),
        "}".to_string(),
        "exports.default = __module.default;".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn create_commonjs_reexport_module(from_path: &Path, target_path: &Path, out_dir: &Path) -> String {
    let module_id = to_goog_module_id(target_path, out_dir);
    [
        format!("goog.module({:?});", to_goog_module_id(from_path, out_dir)),
        format!("const __module = goog.require({module_id:?});"),
        "exports.default = __module.default;".to_string(),
        "exports.__cjsExports = __module.__cjsExports;".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn to_alias_file_path(package_dir: &Path, subpath: &str) -> PathBuf {
    let relative_subpath = subpath.trim_start_matches("./");
    if Path::new(relative_subpath).extension().is_some() {
        package_dir.join(relative_subpath)
    } else {
        package_dir.join(format!("{relative_subpath}.js"))
    }
}

fn to_emitted_path(source_path: &Path, out_dir: &Path, workspace_dir: &Path) -> PathBuf {
    out_dir
        .join(source_path.strip_prefix(workspace_dir).unwrap_or(source_path))
        .with_extension("js")
}
