use std::path::{Path, PathBuf};

use crate::pathing::normalize_path;

use super::compat::validate_class_map_calls;
use super::napi::{TranspileOutput, TranspileSourcesInput};
use super::transpile_plan::append_extension;

mod context;
mod maps;
mod prelude;
mod preserved;
mod properties;

pub(crate) fn resolve_relative_module(file_path: &Path, specifier: &str) -> Option<PathBuf> {
    let base = normalize_path(&file_path.parent()?.join(specifier));
    let candidates = if base.extension().is_some() {
        match base
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
        {
            "js" => vec![
                base.clone(),
                base.with_extension("ts"),
                base.with_extension("tsx"),
                base.with_extension("mts"),
                base.with_extension("cjs"),
                base.with_extension("cts"),
                base.with_extension("jsx"),
                base.with_extension("mjs"),
            ],
            "cjs" => vec![
                base.clone(),
                base.with_extension("js"),
                base.with_extension("ts"),
                base.with_extension("cts"),
            ],
            _ => vec![
                base.clone(),
                append_extension(&base, "ts"),
                append_extension(&base, "tsx"),
                append_extension(&base, "js"),
                append_extension(&base, "jsx"),
            ],
        }
    } else {
        ["ts", "tsx", "mts", "js", "cjs", "cts", "jsx", "mjs"]
            .into_iter()
            .map(|extension| base.with_extension(extension))
            .chain(
                [
                    "index.ts",
                    "index.tsx",
                    "index.mts",
                    "index.js",
                    "index.cjs",
                    "index.cts",
                    "index.jsx",
                    "index.mjs",
                ]
                .into_iter()
                .map(|file| base.join(file)),
            )
            .collect()
    };
    candidates.into_iter().find(|candidate| candidate.exists())
}

pub(crate) fn transpile_sources(
    input: TranspileSourcesInput,
) -> std::result::Result<TranspileOutput, String> {
    validate_class_map_calls(&input.class_map_calls)?;
    crate::pathing::validate_module_paths(
        input
            .file_names
            .iter()
            .filter(|path| !path.ends_with(".d.ts"))
            .map(String::as_str),
        Path::new(&input.workspace_dir),
    )?;
    let input_paths = input
        .file_names
        .iter()
        .filter(|file| !file.ends_with(".d.ts"))
        .map(|file| normalize_path(Path::new(file)))
        .collect::<std::collections::BTreeSet<_>>();
    let workspace_path = normalize_path(Path::new(&input.workspace_dir));
    for input_path in &input_paths {
        let relative = input_path.strip_prefix(&workspace_path).map_err(|_| {
            format!(
                "Source {} is outside workspace {}",
                input_path.display(),
                workspace_path.display()
            )
        })?;
        let output = normalize_path(
            &Path::new(&input.out_dir)
                .join(relative)
                .with_extension("js"),
        );
        if input_paths.contains(&output) {
            return Err(format!(
                "Emitted path {} for {} would overwrite source input {}",
                output.display(),
                input_path.display(),
                output.display()
            ));
        }
    }
    context::transpile_validated_sources(input)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{transpile_sources, TranspileSourcesInput};

    #[test]
    fn conflicting_native_inputs_fail_before_any_write() -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "gcc-input-collisions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir_all(&root)?;
        for names in [["a-b.ts", "a_b.ts"], ["same.ts", "same.js"]] {
            let files = names.map(|name| root.join(name));
            for file in &files {
                fs::write(file, "export const value = 42;")?;
            }
            let output = root.join("output");
            let externs = root.join("generated").join("externs.js");
            let error = transpile_sources(TranspileSourcesInput {
                file_names: files
                    .iter()
                    .map(|file| file.to_string_lossy().to_string())
                    .collect(),
                explicit_extern_paths: Vec::new(),
                out_dir: output.to_string_lossy().to_string(),
                externs_path: externs.to_string_lossy().to_string(),
                metadata_path: String::new(),
                chunk_mode: "off".to_string(),
                target: "node".to_string(),
                runtime_module_source_map_file: None,
                workspace_dir: root.to_string_lossy().to_string(),
                package_aliases: Vec::new(),
                resolved_imports: Vec::new(),
                external_boundaries: Vec::new(),
                opaque_external_specifiers: Vec::new(),
                package_json_files: Vec::new(),
                preserved_modules: Vec::new(),
                lazy_imports: Vec::new(),
                chunk_graph: Vec::new(),
                class_map_calls: Vec::new(),
                pure_callees: Vec::new(),
                type_inference_disabled: true,
            })
            .err()
            .ok_or("colliding inputs must fail")?;
            for file in &files {
                assert!(
                    error.contains(file.to_str().ok_or("non-UTF-8 fixture path")?),
                    "{error}"
                );
                assert_eq!(fs::read_to_string(file)?, "export const value = 42;");
            }
            assert!(!output.exists());
            assert!(!externs
                .parent()
                .ok_or("extern path has no parent")?
                .exists());
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
