use super::*;
use crate::utils::unique_strings;

pub(super) fn collect_effective_extern_paths(
    package_root: &str,
    explicit_extern_paths: &[String],
    generated_extern_paths: &[String],
    native_extern_path: Option<&str>,
    runtime_extern_path: Option<&str>,
) -> std::result::Result<Vec<String>, String> {
    let mut ordered_paths = explicit_extern_paths.to_vec();
    ordered_paths.extend(collect_bundled_externs(package_root)?);
    ordered_paths.extend(generated_extern_paths.iter().cloned());
    if let Some(path) = native_extern_path {
        ordered_paths.push(path.to_string());
    }
    if let Some(path) = runtime_extern_path {
        ordered_paths.push(path.to_string());
    }

    let mut effective_paths = Vec::new();
    for file_path in unique_paths(ordered_paths) {
        if extern_file_has_declarations(&file_path)? {
            effective_paths.push(file_path);
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
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

pub(super) fn extern_file_has_declarations(file_path: &str) -> std::result::Result<bool, String> {
    let source_text = match fs::read_to_string(file_path) {
        Ok(source_text) => source_text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };

    Ok(source_text.lines().map(|line| line.trim()).any(|line| {
        !line.is_empty()
            && line != "/** @externs */"
            && line != "*/"
            && !line.starts_with('*')
            && !line.starts_with("//")
    }))
}

pub(super) fn select_closure_lib_files(
    package_root: &str,
    candidate_files: &[String],
) -> std::result::Result<Vec<String>, String> {
    let contents = read_candidate_contents(candidate_files)?;
    let closure_lib_dir = Path::new(package_root).join("closure-lib");
    let mut required = Vec::new();

    let needs_goog_base = contents.contains("goog.module(")
        || contents.contains("goog.require(")
        || contents.contains("goog.requireType(")
        || contents.contains("goog.provide(")
        || contents.contains("goog.reflect.");
    if needs_goog_base {
        required.push(
            closure_lib_dir
                .join("base.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if contents.contains("goog.reflect.") {
        required.push(
            closure_lib_dir
                .join("reflect.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if contents.contains("tslib") {
        let base_path = closure_lib_dir
            .join("base.js")
            .to_string_lossy()
            .to_string();
        if !required.contains(&base_path) {
            required.push(base_path);
        }
        required.push(
            closure_lib_dir
                .join("tslib.js")
                .to_string_lossy()
                .to_string(),
        );
    }

    Ok(unique_paths(required))
}

pub(super) fn select_bundler_runtime_closure_lib_files(
    package_root: &str,
    candidate_files: &[String],
) -> std::result::Result<Vec<String>, String> {
    let contents = read_candidate_contents(candidate_files)?;
    if !contents.contains("goog.reflect.") {
        return Ok(Vec::new());
    }

    let closure_lib_dir = Path::new(package_root).join("closure-lib");
    Ok(vec![
        closure_lib_dir
            .join("base.js")
            .to_string_lossy()
            .to_string(),
        closure_lib_dir
            .join("reflect.js")
            .to_string_lossy()
            .to_string(),
    ])
}

pub(super) fn read_candidate_contents(
    candidate_files: &[String],
) -> std::result::Result<String, String> {
    let mut contents = String::new();
    for file_path in unique_paths(candidate_files.to_vec()) {
        match fs::read_to_string(&file_path) {
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
