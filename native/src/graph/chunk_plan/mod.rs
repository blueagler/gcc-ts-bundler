use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use super::LazyImportEntry;
use crate::utils::path_relative_to;

mod bundler;
mod off;

pub(crate) use bundler::build_bundler_chunk_plan;
pub(crate) use off::build_off_chunk_plan;

pub(crate) fn dedupe_lazy_imports(lazy_imports: &[LazyImportEntry]) -> Vec<LazyImportEntry> {
    let mut positions = HashMap::<String, usize>::new();
    let mut deduped = Vec::new();
    for lazy_import in lazy_imports {
        if let Some(position) = positions.get(&lazy_import.module_id).copied() {
            deduped[position] = lazy_import.clone();
        } else {
            positions.insert(lazy_import.module_id.clone(), deduped.len());
            deduped.push(lazy_import.clone());
        }
    }
    deduped
}

fn walk_reachable_files(
    entry_file: &str,
    graph: &HashMap<String, Vec<String>>,
) -> BTreeSet<String> {
    let mut reachable = BTreeSet::new();
    let mut pending = vec![entry_file.to_string()];

    while let Some(current) = pending.pop() {
        if !reachable.insert(current.clone()) {
            continue;
        }
        if let Some(dependencies) = graph.get(&current) {
            pending.extend(dependencies.iter().cloned());
        }
    }

    reachable
}

pub(crate) fn topological_sort(
    files: Vec<String>,
    graph: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let file_set = files.iter().cloned().collect::<BTreeSet<_>>();
    let mut visited = BTreeSet::new();
    let mut ordered = Vec::new();

    fn visit(
        file_path: &str,
        graph: &HashMap<String, Vec<String>>,
        file_set: &BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        ordered: &mut Vec<String>,
    ) {
        if !visited.insert(file_path.to_string()) {
            return;
        }
        if let Some(dependencies) = graph.get(file_path) {
            for dependency in dependencies {
                if file_set.contains(dependency) {
                    visit(dependency, graph, file_set, visited, ordered);
                }
            }
        }
        ordered.push(file_path.to_string());
    }

    let mut sorted_files = files;
    sorted_files.sort();
    for file_path in sorted_files {
        visit(&file_path, graph, &file_set, &mut visited, &mut ordered);
    }

    ordered
}

pub(crate) fn to_relative_files(files: &[String], workspace_dir: &Path) -> Vec<String> {
    let mut seen_emitted_paths = BTreeSet::new();
    let mut relative_files = Vec::new();

    for file_path in files {
        if file_path.ends_with(".d.ts") {
            continue;
        }

        let relative_file = path_relative_to(Path::new(file_path), workspace_dir);
        let emitted_relative = replace_extension_with_js(&relative_file);
        if !seen_emitted_paths.insert(emitted_relative) {
            continue;
        }
        relative_files.push(relative_file);
    }

    relative_files
}

fn replace_extension_with_js(file_path: &str) -> String {
    Path::new(file_path)
        .with_extension("js")
        .to_string_lossy()
        .to_string()
}

pub(crate) fn sanitize_chunk_name(value: &str) -> String {
    let without_js = value.strip_suffix(".js").unwrap_or(value);
    without_js
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect()
}
