use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct MirrorChunk {
    pub(crate) dependencies: BTreeSet<usize>,
    pub(crate) files: BTreeSet<String>,
    pub(crate) is_entry: bool,
    pub(crate) lazy_module_ids: BTreeSet<String>,
    pub(crate) name: String,
}

/// Collapses every dependency cycle into its first chunk and reports, for each
/// chunk, the chunk that now owns it.
pub(crate) fn merge_cycles(chunks: &mut [MirrorChunk], entry_index: usize) -> Vec<usize> {
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
            for target in &mut representative {
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

/// Every chunk that is guaranteed to have executed by the time this one does,
/// including the chunk itself.
pub(crate) fn collect_ancestors(chunks: &[MirrorChunk], order: &[usize]) -> Vec<BTreeSet<usize>> {
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
pub(crate) fn single_root_order(
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
