use super::input::RollupChunkInput;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Assigns every materialized file to exactly one chunk.
///
/// A file claimed by one Rollup chunk stays there - that is the mirror. A file
/// claimed by several (dependency bundles fuse modules Rollup kept apart) and a
/// file Rollup never placed (prebundle atoms, the virtual runtime) go to the
/// deepest chunk every consumer depends on, which is where Closure would have
/// been free to sink it anyway. A file nothing consumes is dead: Rollup already
/// dropped it, and the entry shims are only ever importers.
pub(crate) fn place_files(
    rollup_chunks: &[RollupChunkInput],
    ancestors: &[BTreeSet<usize>],
    order: &[usize],
    graph: &HashMap<String, Vec<String>>,
    root_index: usize,
) -> BTreeMap<String, usize> {
    // A Rollup module the resolver never walked was never emitted either, so
    // it cannot be in a chunk: the graph is the authority on what exists.
    let mut owners = BTreeMap::<String, BTreeSet<usize>>::new();
    for (index, chunk) in rollup_chunks.iter().enumerate() {
        for file_path in chunk
            .module_files
            .iter()
            .filter(|file_path| graph.contains_key(*file_path))
        {
            owners.entry(file_path.clone()).or_default().insert(index);
        }
    }

    let mut importers = HashMap::<&str, Vec<&str>>::new();
    for (file_path, dependencies) in graph {
        for dependency in dependencies {
            importers
                .entry(dependency.as_str())
                .or_default()
                .push(file_path.as_str());
        }
    }

    let unassigned = graph
        .keys()
        .filter(|file_path| !owners.contains_key(*file_path))
        .cloned()
        .collect::<BTreeSet<_>>();
    for file_path in unassigned {
        let consumers = reachable_owner_chunks(&file_path, &importers, &owners);
        if consumers.is_empty() {
            continue;
        }
        owners.insert(file_path, consumers);
    }

    let depth_by_index = order
        .iter()
        .enumerate()
        .map(|(depth, &index)| (index, depth))
        .collect::<HashMap<_, _>>();
    owners
        .into_iter()
        .map(|(file_path, claiming)| {
            let index = if claiming.len() == 1 {
                claiming.into_iter().next().unwrap_or(root_index)
            } else {
                deepest_common_ancestor(&claiming, ancestors, &depth_by_index).unwrap_or(root_index)
            };
            (file_path, index)
        })
        .collect()
}

/// Walks importers upward until it reaches files a Rollup chunk already owns.
fn reachable_owner_chunks(
    file_path: &str,
    importers: &HashMap<&str, Vec<&str>>,
    owners: &BTreeMap<String, BTreeSet<usize>>,
) -> BTreeSet<usize> {
    let mut chunk_indices = BTreeSet::new();
    let mut visited = BTreeSet::from([file_path.to_string()]);
    let mut pending = vec![file_path.to_string()];
    while let Some(current) = pending.pop() {
        for importer in importers.get(current.as_str()).into_iter().flatten() {
            if !visited.insert((*importer).to_string()) {
                continue;
            }
            match owners.get(*importer) {
                Some(indices) => chunk_indices.extend(indices.iter().copied()),
                None => pending.push((*importer).to_string()),
            }
        }
    }
    chunk_indices
}

fn deepest_common_ancestor(
    claiming: &BTreeSet<usize>,
    ancestors: &[BTreeSet<usize>],
    depth_by_index: &HashMap<usize, usize>,
) -> Option<usize> {
    let mut common: Option<BTreeSet<usize>> = None;
    for &index in claiming {
        let candidate = ancestors.get(index).cloned().unwrap_or_default();
        common = Some(match common {
            None => candidate,
            Some(current) => current.intersection(&candidate).copied().collect(),
        });
    }
    common?
        .into_iter()
        .max_by_key(|index| depth_by_index.get(index).copied().unwrap_or(0))
}
