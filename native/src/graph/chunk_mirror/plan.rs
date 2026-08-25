use super::super::*;
use super::input::RollupChunkInput;
use super::order::{collect_ancestors, merge_cycles, single_root_order, MirrorChunk};
use super::place::place_files;

/// Mirrors Rollup's own chunk graph into a Closure chunk plan.
///
/// Closure optimizes *inside* the splitting Rollup already proved, instead of
/// re-deriving boundaries from the flat dependency graph and collapsing the app
/// into one eager chunk. Two shapes have to be reconciled:
///
/// * Rollup's entry chunk *imports* its shared chunks, so it is a sink in the
///   chunk DAG, never the first chunk. `kind = "base"` marks it wherever the
///   topological order puts it; the first chunk carries the runtime core.
/// * `JSChunkGraph.getRootChunk` requires exactly one dependency-free chunk,
///   and Rollup routinely produces several. Every root but the chosen one gets
///   a synthetic edge to it, which is also what makes "deepest common ancestor"
///   total for file placement.
pub(crate) fn build_mirror_chunk_plan(
    entry_files: &[ChunkPlanEntryInput],
    graph: &HashMap<String, Vec<String>>,
    lazy_imports: &[LazyImportEntry],
    rollup_chunks: &[RollupChunkInput],
    workspace_dir: &Path,
) -> std::result::Result<Vec<ChunkPlanChunkOutput>, String> {
    let index_by_file_name = rollup_chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| (chunk.fileName.clone(), index))
        .collect::<HashMap<_, _>>();
    if index_by_file_name.len() != rollup_chunks.len() {
        return Err("Rollup chunk file names are not unique.".to_string());
    }
    let chunk_names = assign_chunk_names(
        rollup_chunks
            .iter()
            .map(|chunk| sanitize_chunk_name(&chunk.name))
            .collect(),
        rollup_chunks
            .iter()
            .map(|chunk| chunk.fileName.clone())
            .collect(),
    )?;

    let mut chunks = rollup_chunks
        .iter()
        .zip(chunk_names)
        .map(|(chunk, name)| {
            Ok(MirrorChunk {
                dependencies: chunk
                    .importedChunkFileNames
                    .iter()
                    .map(|file_name| {
                        index_by_file_name.get(file_name).copied().ok_or_else(|| {
                            format!("Rollup chunk import {file_name} is not a known chunk.")
                        })
                    })
                    .collect::<std::result::Result<BTreeSet<_>, String>>()?,
                files: BTreeSet::new(),
                is_entry: chunk.isEntry,
                lazy_module_ids: BTreeSet::new(),
                name,
            })
        })
        .collect::<std::result::Result<Vec<_>, String>>()?;
    for (index, chunk) in chunks.iter_mut().enumerate() {
        chunk.dependencies.remove(&index);
    }

    let entry_index = chunks
        .iter()
        .position(|chunk| chunk.is_entry)
        .ok_or_else(|| "Rollup chunk graph has no entry chunk.".to_string())?;
    let (order, root_index) = single_root_order(&mut chunks, entry_index)?;
    let ancestors = collect_ancestors(&chunks, &order);

    let chunk_by_file = place_files(rollup_chunks, &ancestors, &order, graph, root_index);
    // Rollup's chunk imports cover Rollup's module graph, not ours: prebundling
    // fuses dependency modules into files Rollup never had and mints atoms, so
    // this graph carries edges the chunk DAG does not. Every edge still has to
    // be loadable, and the honest repair is to give the DAG the edge rather
    // than to move code out of the chunk Rollup chose for it.
    for (file_path, dependencies) in graph {
        let Some(&importer) = chunk_by_file.get(file_path) else {
            continue;
        };
        for dependency in dependencies {
            if let Some(&target) = chunk_by_file.get(dependency) {
                if target != importer {
                    chunks[importer].dependencies.insert(target);
                }
            }
        }
    }
    // Those edges can close a loop that Rollup's own imports never had, and a
    // Closure chunk graph has to be acyclic. Chunks in a cycle always load
    // together anyway, so merging them is the only shape that keeps every
    // module reachable.
    let representative = merge_cycles(&mut chunks, entry_index);
    for (file_path, index) in chunk_by_file {
        chunks[representative[index]].files.insert(file_path);
    }
    for lazy_import in dedupe_lazy_imports(lazy_imports) {
        if let Some(chunk) = chunks
            .iter_mut()
            .find(|chunk| chunk.files.contains(&lazy_import.targetPath))
        {
            chunk.lazy_module_ids.insert(lazy_import.moduleId.clone());
        }
    }

    // A Rollup chunk whose every module is CSS, an asset, code Rollup itself
    // dropped, or code a cycle merged elsewhere has nothing left to compile.
    // Keeping it would cost a file, a manifest row and a request for an empty
    // body, and an empty leading chunk would leave the pooled lowering helpers
    // nowhere to live. Its dependents inherit its dependencies, so the load
    // order they see is unchanged.
    let dropped = (0..chunks.len())
        .filter(|index| *index != entry_index && chunks[*index].files.is_empty())
        .collect::<BTreeSet<_>>();
    for index in 0..chunks.len() {
        let mut dependencies = BTreeSet::new();
        let mut pending = chunks[index]
            .dependencies
            .iter()
            .copied()
            .collect::<Vec<_>>();
        while let Some(dependency) = pending.pop() {
            if dropped.contains(&dependency) {
                pending.extend(chunks[dependency].dependencies.iter().copied());
                continue;
            }
            dependencies.insert(dependency);
        }
        chunks[index].dependencies = dependencies;
    }
    let (order, _) = single_root_order(&mut chunks, entry_index)?;
    let order = order
        .into_iter()
        .filter(|index| !dropped.contains(index))
        .collect::<Vec<_>>();

    let entry_paths = entry_files
        .iter()
        .map(|entry| path_relative_to(Path::new(&entry.sourcePath), workspace_dir))
        .collect::<Vec<_>>();
    Ok(order
        .iter()
        .map(|&index| {
            let chunk = &chunks[index];
            ChunkPlanChunkOutput {
                dependencies: chunk
                    .dependencies
                    .iter()
                    .map(|&dependency| chunks[dependency].name.clone())
                    .collect(),
                entryFiles: (index == entry_index).then(|| entry_paths.clone()),
                files: to_relative_files(
                    &topological_sort(chunk.files.iter().cloned().collect(), graph),
                    workspace_dir,
                ),
                // Only the two kinds downstream reads: "base" picks the chunk
                // that owns the runtime manifest and the entry points, "lazy"
                // marks a chunk `import()` has to resolve to even after Closure
                // empties it. A plain shared chunk keeps neither, so
                // `pruneEmptyChunks` may still delete it.
                kind: if index == entry_index {
                    Some("base".to_string())
                } else {
                    (!chunk.lazy_module_ids.is_empty()).then(|| "lazy".to_string())
                },
                lazyModuleIds: (!chunk.lazy_module_ids.is_empty())
                    .then(|| chunk.lazy_module_ids.iter().cloned().collect()),
                name: chunk.name.clone(),
                outputName: None,
            }
        })
        .collect())
}
