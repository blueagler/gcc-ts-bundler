use super::super::*;
use super::{
    dedupe_lazy_imports, sanitize_chunk_name, to_relative_files, topological_sort,
    walk_reachable_files,
};

/// Path segments that mark a file as dependency-originated rather than app
/// code. `node_modules/` is the direct case; `__dep-bundles/` and
/// `__virtual__/` are the Vite pre-bundle and virtual-module staging
/// directories.
const VENDOR_PATH_SEGMENTS: [&str; 3] = ["node_modules", "__dep-bundles", "__virtual__"];

/// Selects the eagerly reachable files that belong in the vendor chunk.
///
/// Path origin only nominates candidates. The final set is dependency-closed:
/// anything that reaches an authored/base file is removed, and that removal
/// propagates to vendor candidates that depend on it. This preserves the only
/// legal direction for the split: base may depend on vendor, never vice versa.
/// Entry files remain app code by definition however they are pathed.
fn partition_vendor_files(
    base_reachable: &BTreeSet<String>,
    entry_files: &[ChunkPlanEntryInput],
    graph: &HashMap<String, Vec<String>>,
    workspace_dir: &Path,
) -> BTreeSet<String> {
    let entry_paths = entry_files
        .iter()
        .map(|entry| entry.sourcePath.clone())
        .collect::<BTreeSet<_>>();
    let mut vendor_files = base_reachable
        .iter()
        .filter(|file_path| {
            !entry_paths.contains(*file_path)
                && is_vendor_path(&path_relative_to(Path::new(file_path), workspace_dir))
        })
        .cloned()
        .collect::<BTreeSet<_>>();

    loop {
        let unsafe_files = vendor_files
            .iter()
            .filter(|file_path| {
                graph.get(*file_path).is_some_and(|dependencies| {
                    dependencies.iter().any(|dependency| {
                        base_reachable.contains(dependency) && !vendor_files.contains(dependency)
                    })
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if unsafe_files.is_empty() {
            break;
        }
        for file_path in unsafe_files {
            vendor_files.remove(&file_path);
        }
    }

    vendor_files
}

fn is_vendor_path(relative_path: &str) -> bool {
    relative_path
        .split(['/', '\\'])
        .any(|segment| VENDOR_PATH_SEGMENTS.contains(&segment))
}

pub(crate) fn build_bundler_chunk_plan(
    base_chunk_name: &str,
    entry_files: &[ChunkPlanEntryInput],
    graph: &HashMap<String, Vec<String>>,
    lazy_imports: &[LazyImportEntry],
    workspace_dir: &Path,
    vendor_chunk: bool,
) -> Vec<ChunkPlanChunkOutput> {
    let mut base_reachable = BTreeSet::new();
    for entry in entry_files {
        base_reachable.extend(walk_reachable_files(&entry.sourcePath, graph));
    }

    let vendor_files = if vendor_chunk {
        partition_vendor_files(&base_reachable, entry_files, graph, workspace_dir)
    } else {
        BTreeSet::new()
    };
    // An empty vendor set leaves the plan exactly as it was: an empty chunk
    // would still cost a request and a manifest row.
    let vendor_chunk_name =
        (!vendor_files.is_empty()).then(|| crate::pathing::vendor_chunk_name(base_chunk_name));
    let base_files = base_reachable
        .iter()
        .filter(|file_path| !vendor_files.contains(*file_path))
        .cloned()
        .collect::<Vec<_>>();
    let base_dependencies = || {
        vendor_chunk_name
            .clone()
            .map(|name| vec![name])
            .unwrap_or_default()
    };
    // Vendor leads the plan, so it is also the first Closure chunk spec. That
    // ordering is what lets base's generated `import "./<vendor>.js"` edge
    // execute it at startup, and it is why vendor carries the runtime core
    // (see `prepare_bundler_runtime_jobs`).
    let vendor_chunks = || {
        vendor_chunk_name
            .iter()
            .map(|name| ChunkPlanChunkOutput {
                dependencies: Vec::new(),
                entryFiles: None,
                files: to_relative_files(
                    &topological_sort(vendor_files.iter().cloned().collect(), graph),
                    workspace_dir,
                ),
                kind: Some("vendor".to_string()),
                lazyModuleIds: None,
                name: name.clone(),
                outputName: None,
            })
            .collect::<Vec<_>>()
    };

    let unique_lazy_imports = dedupe_lazy_imports(lazy_imports);
    if unique_lazy_imports.is_empty() {
        let mut chunks = vendor_chunks();
        chunks.push(ChunkPlanChunkOutput {
            dependencies: base_dependencies(),
            entryFiles: Some(
                entry_files
                    .iter()
                    .map(|entry| path_relative_to(Path::new(&entry.sourcePath), workspace_dir))
                    .collect(),
            ),
            files: to_relative_files(&topological_sort(base_files, graph), workspace_dir),
            kind: Some("base".to_string()),
            lazyModuleIds: None,
            name: base_chunk_name.to_string(),
            outputName: None,
        });
        return chunks;
    }

    let lazy_root_targets = unique_lazy_imports
        .iter()
        .map(|item| item.targetPath.clone())
        .collect::<BTreeSet<_>>();
    let lazy_closures = unique_lazy_imports
        .iter()
        .map(|lazy_import| {
            let reachable = walk_reachable_files(&lazy_import.targetPath, graph)
                .into_iter()
                .filter(|file_path| !base_reachable.contains(file_path))
                .collect::<BTreeSet<_>>();
            (lazy_import.clone(), reachable)
        })
        .collect::<Vec<_>>();

    let mut shared_counts = HashMap::<String, usize>::new();
    for (_, reachable) in &lazy_closures {
        for file_path in reachable {
            if lazy_root_targets.contains(file_path) {
                continue;
            }
            *shared_counts.entry(file_path.clone()).or_insert(0) += 1;
        }
    }
    let shared_lazy_files = shared_counts
        .into_iter()
        .filter_map(|(file_path, count)| (count > 1).then_some(file_path))
        .collect::<BTreeSet<_>>();

    let mut chunks = vendor_chunks();
    chunks.push(ChunkPlanChunkOutput {
        dependencies: base_dependencies(),
        entryFiles: Some(
            entry_files
                .iter()
                .map(|entry| path_relative_to(Path::new(&entry.sourcePath), workspace_dir))
                .collect(),
        ),
        files: to_relative_files(&topological_sort(base_files, graph), workspace_dir),
        kind: Some("base".to_string()),
        lazyModuleIds: Some(
            unique_lazy_imports
                .iter()
                .filter_map(|item| {
                    base_reachable
                        .contains(&item.targetPath)
                        .then_some(item.moduleId.clone())
                })
                .collect(),
        ),
        name: base_chunk_name.to_string(),
        outputName: None,
    });

    let shared_chunk_name = format!("{base_chunk_name}-shared");
    if !shared_lazy_files.is_empty() {
        chunks.push(ChunkPlanChunkOutput {
            dependencies: vec![base_chunk_name.to_string()],
            entryFiles: None,
            files: to_relative_files(
                &topological_sort(shared_lazy_files.iter().cloned().collect(), graph),
                workspace_dir,
            ),
            kind: Some("shared".to_string()),
            lazyModuleIds: None,
            name: shared_chunk_name.clone(),
            outputName: None,
        });
    }

    for (lazy_import, reachable) in lazy_closures {
        if base_reachable.contains(&lazy_import.targetPath) {
            continue;
        }
        let chunk_files = reachable
            .into_iter()
            .filter(|file_path| !shared_lazy_files.contains(file_path))
            .collect::<Vec<_>>();
        chunks.push(ChunkPlanChunkOutput {
            dependencies: {
                let mut deps = vec![base_chunk_name.to_string()];
                if !shared_lazy_files.is_empty() {
                    deps.push(shared_chunk_name.clone());
                }
                deps
            },
            entryFiles: None,
            files: to_relative_files(&topological_sort(chunk_files, graph), workspace_dir),
            kind: Some("lazy".to_string()),
            lazyModuleIds: Some(vec![lazy_import.moduleId.clone()]),
            name: sanitize_chunk_name(&format!(
                "{}-lazy",
                path_relative_to(Path::new(&lazy_import.targetPath), workspace_dir)
                    .replace(['\\', '/'], "-")
                    .rsplit_once('.')
                    .map(|(head, _)| head.to_string())
                    .unwrap_or_else(|| {
                        path_relative_to(Path::new(&lazy_import.targetPath), workspace_dir)
                            .replace(['\\', '/'], "-")
                    })
            )),
            outputName: None,
        });
    }

    chunks
}
