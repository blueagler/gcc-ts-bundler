use super::*;

pub(super) fn build_off_chunk_plan(
    entry_files: &[ChunkPlanEntryInput],
    graph: &HashMap<String, Vec<String>>,
    shim_files: &[String],
    workspace_dir: &Path,
) -> Vec<ChunkPlanChunkOutput> {
    let shim_to_entry = shim_files
        .iter()
        .cloned()
        .zip(entry_files.iter().cloned())
        .collect::<HashMap<_, _>>();
    let mut reachability = HashMap::<String, BTreeSet<String>>::new();
    let mut counts = HashMap::<String, usize>::new();

    for shim_file in shim_files {
        let reachable = walk_reachable_files(shim_file, graph);
        for file_path in &reachable {
            *counts.entry(file_path.clone()).or_insert(0) += 1;
        }
        reachability.insert(shim_file.clone(), reachable);
    }

    let shared_files = counts
        .into_iter()
        .filter_map(|(file_path, count)| (count > 1).then_some(file_path))
        .collect::<BTreeSet<_>>();

    if entry_files.len() == 1 {
        let only_entry = &entry_files[0];
        let only_shim = &shim_files[0];
        return vec![ChunkPlanChunkOutput {
            dependencies: Vec::new(),
            entryFiles: None,
            files: to_relative_files(
                &topological_sort(
                    reachability
                        .get(only_shim)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .collect(),
                    graph,
                ),
                workspace_dir,
            ),
            kind: None,
            lazyModuleIds: None,
            name: strip_extension(&only_entry.outputName),
        }];
    }

    let mut chunks = Vec::new();
    if !shared_files.is_empty() {
        chunks.push(ChunkPlanChunkOutput {
            dependencies: Vec::new(),
            entryFiles: None,
            files: to_relative_files(
                &topological_sort(shared_files.iter().cloned().collect(), graph),
                workspace_dir,
            ),
            kind: None,
            lazyModuleIds: None,
            name: "shared".to_string(),
        });
    }

    for shim_file in shim_files {
        let entry = shim_to_entry
            .get(shim_file)
            .expect("missing shim to entry mapping");
        let unique_files = reachability
            .get(shim_file)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|file_path| !shared_files.contains(file_path))
            .collect::<Vec<_>>();
        chunks.push(ChunkPlanChunkOutput {
            dependencies: (!shared_files.is_empty())
                .then_some(vec!["shared".to_string()])
                .unwrap_or_default(),
            entryFiles: None,
            files: to_relative_files(&topological_sort(unique_files, graph), workspace_dir),
            kind: None,
            lazyModuleIds: None,
            name: strip_extension(&entry.outputName),
        });
    }

    chunks
}

/// Path segments that mark a file as dependency-originated rather than app
/// code. `node_modules/` is the direct case; `__dep-bundles/` and
/// `__virtual__/` are the Vite pre-bundle and virtual-module staging
/// directories, whose contents are likewise not authored by the app.
const VENDOR_PATH_SEGMENTS: [&str; 3] = ["node_modules", "__dep-bundles", "__virtual__"];

/// Selects the eagerly reachable files that belong in the vendor chunk.
///
/// The point of the split is filename stability: an app-code edit must
/// re-hash only the entry chunk, leaving vendor and the lazy panels byte- and
/// name-identical (docs/research/es-modules-output.md §7, byte-stability
/// finding). So the vendor set must contain nothing an app edit can change,
/// and entry files are app code by definition however they are pathed.
fn partition_vendor_files(
    base_reachable: &BTreeSet<String>,
    entry_files: &[ChunkPlanEntryInput],
    workspace_dir: &Path,
) -> BTreeSet<String> {
    let entry_paths = entry_files
        .iter()
        .map(|entry| entry.sourcePath.clone())
        .collect::<BTreeSet<_>>();
    base_reachable
        .iter()
        .filter(|file_path| {
            !entry_paths.contains(*file_path)
                && is_vendor_path(&path_relative_to(Path::new(file_path), workspace_dir))
        })
        .cloned()
        .collect()
}

fn is_vendor_path(relative_path: &str) -> bool {
    relative_path
        .split(['/', '\\'])
        .any(|segment| VENDOR_PATH_SEGMENTS.contains(&segment))
}

pub(super) fn build_bundler_chunk_plan(
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
        partition_vendor_files(&base_reachable, entry_files, workspace_dir)
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
                    .replace('\\', "-")
                    .replace('/', "-")
                    .rsplit_once('.')
                    .map(|(head, _)| head.to_string())
                    .unwrap_or_else(|| {
                        path_relative_to(Path::new(&lazy_import.targetPath), workspace_dir)
                            .replace('\\', "-")
                            .replace('/', "-")
                    })
            )),
        });
    }

    chunks
}

fn dedupe_lazy_imports(lazy_imports: &[LazyImportEntry]) -> Vec<LazyImportEntry> {
    let mut positions = HashMap::<String, usize>::new();
    let mut deduped = Vec::new();
    for lazy_import in lazy_imports {
        if let Some(position) = positions.get(&lazy_import.moduleId).copied() {
            deduped[position] = lazy_import.clone();
        } else {
            positions.insert(lazy_import.moduleId.clone(), deduped.len());
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

fn topological_sort(files: Vec<String>, graph: &HashMap<String, Vec<String>>) -> Vec<String> {
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

fn to_relative_files(files: &[String], workspace_dir: &Path) -> Vec<String> {
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

fn strip_extension(file_path: &str) -> String {
    Path::new(file_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_path)
        .to_string()
}

pub(super) fn sanitize_chunk_name(value: &str) -> String {
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
