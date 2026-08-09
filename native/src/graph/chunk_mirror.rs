use super::*;

/// A Rollup output chunk, serialized by the Vite plugin at `generateBundle`.
///
/// `fileName` is the identity: Rollup chunk `name`s are not unique, file names
/// are. Import edges therefore travel as file names too. `moduleFiles` are
/// materialized source files relative to the build source root, already joined
/// from Rollup module ids by the plugin; modules with no materialized file
/// (CSS, assets, anything Rollup dropped) are absent.
#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RollupChunkInput {
    pub dynamicImportedChunkFileNames: Vec<String>,
    pub fileName: String,
    pub importedChunkFileNames: Vec<String>,
    pub isEntry: bool,
    pub moduleFiles: Vec<String>,
    pub name: String,
}

struct MirrorChunk {
    dependencies: BTreeSet<usize>,
    files: BTreeSet<String>,
    is_entry: bool,
    lazy_module_ids: BTreeSet<String>,
    name: String,
}

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
pub(super) fn build_mirror_chunk_plan(
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

/// Assigns every materialized file to exactly one chunk.
///
/// A file claimed by one Rollup chunk stays there - that is the mirror. A file
/// claimed by several (dependency bundles fuse modules Rollup kept apart) and a
/// file Rollup never placed (prebundle atoms, the virtual runtime) go to the
/// deepest chunk every consumer depends on, which is where Closure would have
/// been free to sink it anyway. A file nothing consumes is dead: Rollup already
/// dropped it, and the entry shims are only ever importers.
fn place_files(
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
            .moduleFiles
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

/// Collapses every dependency cycle into its first chunk and reports, for each
/// chunk, the chunk that now owns it.
fn merge_cycles(chunks: &mut [MirrorChunk], entry_index: usize) -> Vec<usize> {
    let mut representative = (0..chunks.len()).collect::<Vec<_>>();
    while let Some(cycle) = find_cycle(chunks, &representative) {
        let owner = if cycle.contains(&entry_index) {
            entry_index
        } else {
            cycle.iter().copied().min().unwrap_or(entry_index)
        };
        for member in cycle {
            if member == owner {
                continue;
            }
            let absorbed = std::mem::take(&mut chunks[member].dependencies);
            chunks[owner].dependencies.extend(absorbed);
            let lazy = std::mem::take(&mut chunks[member].lazy_module_ids);
            chunks[owner].lazy_module_ids.extend(lazy);
            for target in representative.iter_mut() {
                if *target == member {
                    *target = owner;
                }
            }
        }
        for index in 0..chunks.len() {
            let redirected = chunks[index]
                .dependencies
                .iter()
                .map(|dependency| representative[*dependency])
                .filter(|dependency| *dependency != representative[index])
                .collect();
            chunks[index].dependencies = redirected;
        }
    }
    representative
}

/// One cycle of the chunk graph, as the set of chunks on it.
fn find_cycle(chunks: &[MirrorChunk], representative: &[usize]) -> Option<Vec<usize>> {
    let live = (0..chunks.len())
        .filter(|index| representative[*index] == *index)
        .collect::<BTreeSet<_>>();
    let mut remaining = live
        .iter()
        .map(|index| {
            (
                *index,
                chunks[*index]
                    .dependencies
                    .iter()
                    .map(|dependency| representative[*dependency])
                    .filter(|dependency| live.contains(dependency) && dependency != index)
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    loop {
        let ready = remaining
            .iter()
            .filter(|(_, dependencies)| dependencies.is_empty())
            .map(|(index, _)| *index)
            .collect::<Vec<_>>();
        if ready.is_empty() {
            break;
        }
        for index in ready {
            remaining.remove(&index);
            for dependencies in remaining.values_mut() {
                dependencies.remove(&index);
            }
        }
    }
    if remaining.is_empty() {
        return None;
    }
    // Everything left is on or behind a cycle; walk one out of it.
    let start = *remaining.keys().next()?;
    let mut path = vec![start];
    let mut seen = BTreeSet::from([start]);
    loop {
        let next = *remaining.get(path.last()?)?.iter().next()?;
        if seen.contains(&next) {
            let cut = path.iter().position(|index| *index == next)?;
            return Some(path.split_off(cut));
        }
        seen.insert(next);
        path.push(next);
    }
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

/// Every chunk that is guaranteed to have executed by the time this one does,
/// including the chunk itself.
fn collect_ancestors(chunks: &[MirrorChunk], order: &[usize]) -> Vec<BTreeSet<usize>> {
    let mut ancestors = vec![BTreeSet::new(); chunks.len()];
    for &index in order {
        let mut reachable = BTreeSet::from([index]);
        for &dependency in &chunks[index].dependencies {
            reachable.insert(dependency);
            let inherited = ancestors[dependency].clone();
            reachable.extend(inherited);
        }
        ancestors[index] = reachable;
    }
    ancestors
}

/// Orders the chunk DAG and gives it the single dependency-free chunk Closure
/// requires (`JSChunkGraph.getRootChunk` accepts exactly one, and Rollup
/// routinely produces several). Returns the order and that leading chunk.
fn single_root_order(
    chunks: &mut [MirrorChunk],
    entry_index: usize,
) -> std::result::Result<(Vec<usize>, usize), String> {
    let order = topological_chunk_order(chunks)?;
    let root_index = pick_root_chunk(chunks, entry_index, &order);
    for (index, chunk) in chunks.iter_mut().enumerate() {
        if index != root_index && chunk.dependencies.is_empty() {
            chunk.dependencies.insert(root_index);
        }
    }
    Ok((topological_chunk_order(chunks)?, root_index))
}

/// The chunk that leads the plan: it carries the runtime core and Closure's
/// leading inputs, so it has to execute before every other chunk. Roots inside
/// the entry chunk's static closure are the only ones the initial page load
/// guarantees to run, so the entry closure decides it.
fn pick_root_chunk(chunks: &[MirrorChunk], entry_index: usize, order: &[usize]) -> usize {
    let mut closure = BTreeSet::from([entry_index]);
    for &index in order.iter().rev() {
        if closure.contains(&index) {
            closure.extend(chunks[index].dependencies.iter().copied());
        }
    }
    order
        .iter()
        .copied()
        .find(|index| closure.contains(index) && chunks[*index].dependencies.is_empty())
        .unwrap_or(entry_index)
}

/// Kahn order with a deterministic tie-break on chunk name, so a chunk always
/// follows the chunks it imports.
fn topological_chunk_order(chunks: &[MirrorChunk]) -> std::result::Result<Vec<usize>, String> {
    let mut remaining = chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| (index, chunk.dependencies.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut order = Vec::with_capacity(chunks.len());
    while !remaining.is_empty() {
        let ready = remaining
            .iter()
            .filter(|(_, dependencies)| dependencies.is_empty())
            .map(|(index, _)| *index)
            .min_by(|left, right| {
                chunks[*left]
                    .name
                    .cmp(&chunks[*right].name)
                    .then(left.cmp(right))
            })
            .ok_or_else(|| {
                format!(
                    "Rollup chunk graph has an import cycle across {}",
                    remaining
                        .keys()
                        .map(|index| chunks[*index].name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
        remaining.remove(&ready);
        for dependencies in remaining.values_mut() {
            dependencies.remove(&ready);
        }
        order.push(ready);
    }
    Ok(order)
}
