use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::utils::unique_strings;

use super::{GeneratedExternInput, PrepareClosureJobsInput};

pub(super) struct EffectiveExtern {
    path: String,
    entry_files: Vec<String>,
}

pub(super) fn validate_generated_extern_scopes(
    input: &PrepareClosureJobsInput,
) -> std::result::Result<(), String> {
    if input
        .generated_externs
        .iter()
        .all(|extern_input| extern_input.entry_files.is_empty())
    {
        return Ok(());
    }
    let entries = input
        .chunk_plan
        .iter()
        .filter_map(|chunk| chunk.entry_files.as_ref())
        .flatten()
        .collect::<HashSet<_>>();
    for extern_input in &input.generated_externs {
        for entry in &extern_input.entry_files {
            if entry.is_empty() || !entries.contains(entry) {
                return Err(format!(
                    "Required typed extern {} has no chunk entry ownership for {}",
                    extern_input.path, entry,
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn select_effective_extern_paths(
    externs: &[EffectiveExtern],
    entry_files: Option<&HashSet<&String>>,
) -> Vec<String> {
    externs
        .iter()
        .filter(|extern_input| {
            extern_input.entry_files.is_empty()
                || entry_files.is_none_or(|entries| {
                    extern_input
                        .entry_files
                        .iter()
                        .any(|entry| entries.contains(entry))
                })
        })
        .map(|extern_input| extern_input.path.clone())
        .collect()
}

pub(super) fn collect_effective_extern_paths(
    package_root: &str,
    explicit_extern_paths: &[String],
    generated_externs: &[GeneratedExternInput],
    native_extern_path: Option<&str>,
    runtime_extern_path: Option<&str>,
) -> std::result::Result<Vec<EffectiveExtern>, String> {
    let mut ordered_paths = explicit_extern_paths.to_vec();
    ordered_paths.extend(collect_bundled_externs(package_root)?);
    let mut global_paths = ordered_paths.iter().cloned().collect::<HashSet<_>>();
    ordered_paths.extend(
        generated_externs
            .iter()
            .map(|extern_input| extern_input.path.clone()),
    );
    if let Some(path) = native_extern_path {
        global_paths.insert(path.to_string());
        ordered_paths.push(path.to_string());
    }
    if let Some(path) = runtime_extern_path {
        global_paths.insert(path.to_string());
        ordered_paths.push(path.to_string());
    }
    let mut scopes = HashMap::<&str, Vec<String>>::new();
    for extern_input in generated_externs {
        if extern_input.entry_files.is_empty() {
            global_paths.insert(extern_input.path.clone());
        } else {
            scopes
                .entry(&extern_input.path)
                .or_default()
                .extend(extern_input.entry_files.iter().cloned());
        }
    }

    let mut effective_paths = Vec::new();
    for file_path in unique_paths(ordered_paths) {
        if extern_file_has_declarations(&file_path)? {
            let entry_files = if global_paths.contains(&file_path) {
                Vec::new()
            } else {
                scopes.remove(file_path.as_str()).unwrap_or_default()
            };
            effective_paths.push(EffectiveExtern {
                path: file_path,
                entry_files,
            });
        }
    }
    Ok(effective_paths)
}

pub(super) fn collect_bundled_externs(
    package_root: &str,
) -> std::result::Result<Vec<String>, String> {
    let externs_dir = Path::new(package_root).join("closure-externs");
    let entries = match fs::read_dir(&externs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let mut files = entries
        .map(|entry| {
            entry
                .map(|entry| entry.path().to_string_lossy().to_string())
                .map_err(|error| format!("Unable to read {}: {error}", externs_dir.display()))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    files.sort();
    Ok(files)
}

pub(super) fn extern_file_has_declarations(file_path: &str) -> std::result::Result<bool, String> {
    let source_text = fs::read_to_string(file_path)
        .map_err(|error| format!("Unable to read required extern {file_path}: {error}"))?;

    Ok(source_text.lines().map(|line| line.trim()).any(|line| {
        !line.is_empty()
            && line != "/** @externs */"
            && line != "*/"
            && !line.starts_with('*')
            && !line.starts_with("//")
    }))
}

#[derive(Clone, Copy, Default)]
pub(super) struct ClosureLibRequirements {
    base: bool,
    reflect: bool,
    tslib: bool,
}

impl ClosureLibRequirements {
    pub(super) fn observe(&mut self, contents: &str) {
        self.reflect = self.reflect || contents.contains("goog.reflect.");
        self.tslib = self.tslib || contents.contains("tslib");
        self.base = self.base
            || self.reflect
            || self.tslib
            || contents.contains("goog.module(")
            || contents.contains("goog.require(")
            || contents.contains("goog.requireType(")
            || contents.contains("goog.provide(");
    }

    pub(super) fn merge(&mut self, other: Self) {
        self.base |= other.base;
        self.reflect |= other.reflect;
        self.tslib |= other.tslib;
    }
}

/// Cache only per-file facts, never a union belonging to a different component.
#[derive(Default)]
pub(super) struct ClosureLibScanner<'a> {
    requirements_by_path: HashMap<&'a str, ClosureLibRequirements>,
}

impl<'a> ClosureLibScanner<'a> {
    pub(super) fn scan(
        &mut self,
        candidate_files: impl IntoIterator<Item = &'a String>,
    ) -> std::result::Result<ClosureLibRequirements, String> {
        let mut requirements = ClosureLibRequirements::default();
        for file_path in candidate_files {
            let file_requirements = match self.requirements_by_path.entry(file_path.as_str()) {
                std::collections::hash_map::Entry::Occupied(entry) => *entry.get(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let mut facts = ClosureLibRequirements::default();
                    match fs::read_to_string(file_path) {
                        Ok(source_text) => facts.observe(&source_text),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.to_string()),
                    }
                    *entry.insert(facts)
                }
            };
            requirements.merge(file_requirements);
        }
        Ok(requirements)
    }
}

pub(super) fn select_closure_lib_files(
    package_root: &str,
    requirements: ClosureLibRequirements,
) -> Vec<String> {
    let closure_lib_dir = Path::new(package_root).join("closure-lib");
    let mut required = Vec::new();
    if requirements.base {
        required.push(
            closure_lib_dir
                .join("base.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if requirements.reflect {
        required.push(
            closure_lib_dir
                .join("reflect.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if requirements.tslib {
        required.push(
            closure_lib_dir
                .join("tslib.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    required
}

pub(super) fn select_bundler_runtime_closure_lib_files(
    package_root: &str,
    requirements: ClosureLibRequirements,
) -> Vec<String> {
    // Registry-mode modules intentionally do not request Closure's module/tslib runtime.
    select_closure_lib_files(
        package_root,
        ClosureLibRequirements {
            base: requirements.reflect,
            reflect: requirements.reflect,
            tslib: false,
        },
    )
}

pub(super) fn read_candidate_contents<'a>(
    candidate_files: impl IntoIterator<Item = &'a String>,
) -> std::result::Result<String, String> {
    let mut contents = String::new();
    let mut seen = HashSet::new();
    for file_path in candidate_files {
        if !seen.insert(file_path) {
            continue;
        }
        match fs::read_to_string(file_path) {
            Ok(source_text) => {
                contents.push_str(&source_text);
                contents.push('\n');
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(contents)
}

pub(super) fn unique_paths(paths: Vec<String>) -> Vec<String> {
    unique_strings(paths)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::collect_effective_extern_paths;

    #[test]
    fn missing_generated_extern_is_not_an_empty_extern() -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "gcc-required-extern-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir_all(&root)?;
        let pins = root.join("native-pins.js");
        fs::write(&pins, "/** @externs */\n")?;
        let generated = vec![super::GeneratedExternInput {
            path: pins.to_string_lossy().to_string(),
            entry_files: Vec::new(),
        }];
        let root_path = root.to_str().ok_or("non-UTF-8 fixture path")?;
        let paths = collect_effective_extern_paths(root_path, &[], &generated, None, None)?;
        assert!(paths.is_empty());
        fs::remove_file(&pins)?;
        let error = collect_effective_extern_paths(root_path, &[], &generated, None, None)
            .err()
            .ok_or("operation unexpectedly succeeded")?;
        assert!(
            error.contains(pins.to_str().ok_or("non-UTF-8 fixture path")?),
            "{error}"
        );
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
