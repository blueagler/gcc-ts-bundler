use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use super::super::{assign_chunk_names, ChunkPlanChunkOutput, ChunkPlanEntryInput};
use super::{to_relative_files, topological_sort, walk_reachable_files};

pub(crate) fn build_off_chunk_plan(
    entry_files: &[ChunkPlanEntryInput],
    graph: &HashMap<String, Vec<String>>,
    workspace_dir: &Path,
) -> Result<Vec<ChunkPlanChunkOutput>, String> {
    let mut reachability = HashMap::<String, BTreeSet<String>>::new();
    for entry in entry_files {
        reachability.insert(
            entry.shim_path.clone(),
            walk_reachable_files(&entry.shim_path, graph),
        );
    }

    if entry_files.len() == 1 {
        let only_entry = &entry_files[0];
        return Ok(vec![ChunkPlanChunkOutput {
            dependencies: Vec::new(),
            entry_files: Some(to_relative_files(
                std::slice::from_ref(&only_entry.source_path),
                workspace_dir,
            )),
            files: to_relative_files(
                &topological_sort(
                    reachability
                        .get(&only_entry.shim_path)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .collect(),
                    graph,
                ),
                workspace_dir,
            ),
            kind: None,
            lazy_module_ids: None,
            name: strip_extension(&only_entry.output_name),
            output_name: Some(only_entry.output_name.clone()),
        }]);
    }

    let entry_chunk_names = assign_chunk_names(
        entry_files
            .iter()
            .map(|entry| strip_extension(&entry.output_name))
            .collect(),
        entry_files
            .iter()
            .map(|entry| entry.output_name.clone())
            .collect(),
    )?;
    let entry_count = entry_files.len();
    let mut parent = (0..entry_count).collect::<Vec<_>>();
    for left in 0..entry_count {
        for right in (left + 1)..entry_count {
            let left_reachable = reachability
                .get(&entry_files[left].shim_path)
                .cloned()
                .unwrap_or_default();
            let right_reachable = reachability
                .get(&entry_files[right].shim_path)
                .cloned()
                .unwrap_or_default();
            if reachable_sets_intersect(&left_reachable, &right_reachable) {
                union_component_roots(&mut parent, left, right);
            }
        }
    }

    let mut component_order = Vec::new();
    let mut members = HashMap::<usize, Vec<usize>>::new();
    for index in 0..entry_count {
        let root = find_component_root(&mut parent, index);
        if !members.contains_key(&root) {
            component_order.push(root);
        }
        members.entry(root).or_default().push(index);
    }

    let mut used_names = entry_chunk_names.iter().cloned().collect::<BTreeSet<_>>();
    let mut chunks = Vec::new();
    for root in component_order {
        let indices = members.get(&root).cloned().unwrap_or_default();
        let shared_files = shared_files_for_component(&indices, entry_files, &reachability);
        let shared_name = if indices.len() > 1 && !shared_files.is_empty() {
            let name = next_shared_chunk_name(&used_names);
            used_names.insert(name.clone());
            chunks.push(ChunkPlanChunkOutput {
                dependencies: Vec::new(),
                entry_files: None,
                files: to_relative_files(
                    &topological_sort(shared_files.iter().cloned().collect(), graph),
                    workspace_dir,
                ),
                kind: None,
                lazy_module_ids: None,
                name: name.clone(),
                output_name: None,
            });
            Some(name)
        } else {
            None
        };

        for index in indices {
            let unique_files = reachability
                .get(&entry_files[index].shim_path)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|file_path| !shared_files.contains(file_path))
                .collect::<Vec<_>>();
            chunks.push(ChunkPlanChunkOutput {
                dependencies: shared_name
                    .clone()
                    .map(|name| vec![name])
                    .unwrap_or_default(),
                entry_files: Some(to_relative_files(
                    &[entry_files[index].source_path.clone()],
                    workspace_dir,
                )),
                files: to_relative_files(&topological_sort(unique_files, graph), workspace_dir),
                kind: None,
                lazy_module_ids: None,
                name: entry_chunk_names[index].clone(),
                output_name: Some(entry_files[index].output_name.clone()),
            });
        }
    }

    Ok(chunks)
}

fn reachable_sets_intersect(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    let (smaller, larger) = if left.len() <= right.len() {
        (left, right)
    } else {
        (right, left)
    };
    smaller.iter().any(|item| larger.contains(item))
}

fn find_component_root(parent: &mut [usize], mut index: usize) -> usize {
    while parent[index] != index {
        parent[index] = parent[parent[index]];
        index = parent[index];
    }
    index
}

fn union_component_roots(parent: &mut [usize], left: usize, right: usize) {
    let left_root = find_component_root(parent, left);
    let right_root = find_component_root(parent, right);
    if left_root != right_root {
        parent[right_root] = left_root;
    }
}

fn next_shared_chunk_name(used_names: &BTreeSet<String>) -> String {
    if !used_names.contains("shared") {
        return "shared".to_string();
    }
    let mut index = 2usize;
    loop {
        let candidate = format!("shared{index}");
        if !used_names.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn shared_files_for_component(
    indices: &[usize],
    entry_files: &[ChunkPlanEntryInput],
    reachability: &HashMap<String, BTreeSet<String>>,
) -> BTreeSet<String> {
    let mut counts = HashMap::<String, usize>::new();
    for &index in indices {
        if let Some(reachable) = reachability.get(&entry_files[index].shim_path) {
            for file_path in reachable {
                *counts.entry(file_path.clone()).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .filter_map(|(file_path, count)| (count > 1).then_some(file_path))
        .collect()
}

fn strip_extension(file_path: &str) -> String {
    Path::new(file_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_path)
        .to_string()
}
