use super::package_resolver::is_external_boundary_specifier;
use super::*;
use crate::closure_capabilities::CLOSURE_COMPILER_CAPABILITIES;
use oxc_allocator::Allocator;

pub(crate) fn resolve_graph_impl(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
    external_specifiers: Vec<String>,
    preserved_file_paths: Vec<String>,
) -> std::result::Result<ResolveGraphOutput, String> {
    let src_dir = PathBuf::from(src_dir);
    let workspace_dir = PathBuf::from(workspace_dir);
    let entries: Vec<PathBuf> = entries.into_iter().map(PathBuf::from).collect();
    let external_specifiers = external_specifiers.into_iter().collect::<BTreeSet<_>>();
    let authored_preserved_file_paths = preserved_file_paths
        .into_iter()
        .map(|file_path| {
            normalize_path(Path::new(&file_path))
                .to_string_lossy()
                .to_string()
        })
        .collect::<BTreeSet<_>>();
    let (package_mode, target) = PackageMode::parse(&package_mode)?;
    let context = ResolveContext {
        external_specifiers: &external_specifiers,
        package_mode,
        preserved_file_paths: &authored_preserved_file_paths,
        target,
        src_dir: &src_dir,
        workspace_dir: &workspace_dir,
    };

    let mut consulted_package_jsons = BTreeSet::new();
    let mut commonjs_cache = HashMap::<PathBuf, CommonJsAnalysis>::new();
    let mut external_boundaries = BTreeMap::<String, ExternalBoundaryEntry>::new();
    let mut file_hashes = BTreeMap::new();
    let mut graph = BTreeMap::new();
    let mut lazy_imports = BTreeMap::<String, LazyImportEntry>::new();
    let mut package_aliases = BTreeMap::<String, PackageAliasEntry>::new();
    let mut resolved_imports = BTreeMap::<String, ResolvedImportEntry>::new();
    let mut top_level_await_modules = BTreeSet::<String>::new();
    let mut pending = entries.clone();
    let mut visited = BTreeSet::new();

    while let Some(current_file) = pending.pop() {
        if visited.contains(&current_file) {
            continue;
        }

        visited.insert(current_file.clone());
        let contents = fs::read_to_string(&current_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(&current_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));

        let normalized_current = normalize_path(&current_file).to_string_lossy().to_string();
        let authored_preserved = context.preserved_file_paths.contains(&normalized_current);
        let commonjs_analysis = analyze_commonjs_source(&current_file, &contents)?;
        commonjs_cache.insert(current_file.clone(), commonjs_analysis.clone());

        // Preserved classification happens after the complete static graph is
        // known. Scan ESM edges even when a createRequire() binding looks like
        // CommonJS so a preserved seed can promote its dependency closure
        // before CommonJS validation is applied to the remaining modules.
        let scan_allocator = Allocator::default();
        let scanned = parse_scanned_module(&scan_allocator, &current_file, &contents)?;
        // Closure's pinned syntax table rejects top-level await, so retain its
        // ESM edge for Oxc to emit rather than handing the module to Closure.
        if authored_preserved
            || (!CLOSURE_COMPILER_CAPABILITIES.top_level_await && has_top_level_await(&scanned))
        {
            top_level_await_modules.insert(current_file.to_string_lossy().to_string());
        }
        for specifier in collect_export_source_specifiers(&scanned) {
            if is_external_boundary_specifier(&specifier, &context) {
                return Err(format!(
                    "Export-from external module {specifier:?} is unsupported in this phase ({})",
                    current_file.display()
                ));
            }
        }
        let mut specifiers = extract_dependencies(&scanned);
        specifiers.extend(commonjs_analysis.dependencies.clone());
        specifiers.sort();
        specifiers.dedup();
        let lazy_specifiers = if authored_preserved {
            Vec::new()
        } else {
            collect_dynamic_import_specifiers(&scanned)?
        };

        let mut dependencies = BTreeSet::new();
        for specifier in specifiers {
            if is_external_boundary_specifier(&specifier, &context) {
                let importer_file_path =
                    normalize_path(&current_file).to_string_lossy().to_string();
                external_boundaries.insert(
                    format!("{importer_file_path}\0{specifier}"),
                    ExternalBoundaryEntry {
                        importerFilePath: importer_file_path,
                        specifier,
                    },
                );
                continue;
            }
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                let target_path = resolved.path;
                let importer_file_path =
                    normalize_path(&current_file).to_string_lossy().to_string();
                let key = format!("{importer_file_path}\0{specifier}");
                resolved_imports.insert(
                    key,
                    ResolvedImportEntry {
                        importerFilePath: importer_file_path,
                        moduleId: to_goog_module_id(&target_path, context.workspace_dir),
                        specifier,
                        targetPath: target_path.to_string_lossy().to_string(),
                    },
                );
                dependencies.insert(target_path);
            }
        }
        for specifier in lazy_specifiers {
            if is_external_boundary_specifier(&specifier, &context) {
                return Err(format!(
                    "Dynamic import of external module {specifier:?} is unsupported in this phase ({})",
                    current_file.display()
                ));
            }
            if let Some(resolved) = resolve_module_specifier(&specifier, &current_file, &context)? {
                consulted_package_jsons.extend(resolved.package_json_files.iter().cloned());
                if let Some(package_alias) = resolved.package_alias.clone() {
                    package_aliases.insert(
                        format!("{}\0{}", package_alias.packageName, package_alias.subpath),
                        package_alias,
                    );
                }
                pending.push(resolved.path.clone());
                let key = format!("{}\0{}", current_file.to_string_lossy(), specifier);
                lazy_imports.insert(
                    key,
                    LazyImportEntry {
                        importerFilePath: current_file.to_string_lossy().to_string(),
                        moduleId: to_goog_module_id(&resolved.path, context.workspace_dir),
                        specifier,
                        targetPath: resolved.path.to_string_lossy().to_string(),
                    },
                );
            }
        }

        graph.insert(
            current_file.to_string_lossy().to_string(),
            dependencies
                .iter()
                .map(|dependency| dependency.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
        );

        pending.extend(dependencies);
    }

    for package_json_file in &consulted_package_jsons {
        let contents = fs::read_to_string(package_json_file).map_err(|error| error.to_string())?;
        let relative = path_relative_to(package_json_file, context.workspace_dir);
        file_hashes.insert(relative, hash_content(&contents));
    }

    let missing_preserved = authored_preserved_file_paths
        .difference(
            &visited
                .iter()
                .map(|path| normalize_path(path).to_string_lossy().to_string())
                .collect(),
        )
        .cloned()
        .collect::<Vec<_>>();
    if !missing_preserved.is_empty() {
        return Err(format!(
            "Configured preserveModules paths are not reachable from an entry: {}",
            missing_preserved.join(", ")
        ));
    }

    let preserved_file_paths = classify_preserved_modules(&graph, &top_level_await_modules)?;
    for (file_path, analysis) in &commonjs_cache {
        if analysis.has_commonjs
            && !preserved_file_paths.contains(&file_path.to_string_lossy().to_string())
        {
            validate_commonjs_usage(file_path, analysis, &context)?;
        }
    }
    for file_path in &preserved_file_paths {
        commonjs_cache.insert(PathBuf::from(file_path), CommonJsAnalysis::default());
    }
    if let Some(lazy_import) = lazy_imports
        .values()
        .find(|lazy_import| preserved_file_paths.contains(&lazy_import.targetPath))
    {
        return Err(format!(
            "Dynamic import of preserved module {} is unsupported in phase 1; use a static ESM import.",
            lazy_import.targetPath
        ));
    }
    validate_preserved_export_sources(&preserved_file_paths, &context)?;
    let mut export_cache = HashMap::<PathBuf, EntryExportMetadata>::new();
    let preserved_modules = preserved_file_paths
        .iter()
        .map(|file_path| {
            let path = PathBuf::from(file_path);
            let exports = collect_exports(&path, &mut commonjs_cache, &mut export_cache, &context)?;
            Ok(PreservedModuleEntry {
                exportNames: exports.exportNames,
                filePath: file_path.clone(),
                hasDefaultExport: exports.hasDefaultExport,
                moduleId: to_goog_module_id(&path, context.workspace_dir),
            })
        })
        .collect::<std::result::Result<Vec<_>, String>>()?;
    let entries_metadata = entries
        .iter()
        .map(|entry| collect_exports(entry, &mut commonjs_cache, &mut export_cache, &context))
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let package_json_files = consulted_package_jsons
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let source_files = visited
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let tracked_files = source_files
        .iter()
        .cloned()
        .chain(package_json_files.iter().cloned())
        .collect::<Vec<_>>();

    Ok(ResolveGraphOutput {
        entries: entries_metadata,
        externalBoundaries: external_boundaries.into_values().collect(),
        fileHashes: file_hashes
            .into_iter()
            .map(|(file_path, hash)| FileHashEntry {
                filePath: file_path,
                hash,
            })
            .collect(),
        graph: graph
            .iter()
            .map(|(file_path, dependencies)| DependencyGraphEntry {
                dependencies: dependencies.clone(),
                filePath: file_path.clone(),
            })
            .collect(),
        lazyImports: lazy_imports.into_values().collect(),
        packageAliases: package_aliases.into_values().collect(),
        resolvedImports: resolved_imports.into_values().collect(),
        packageJsonFiles: package_json_files,
        preservedModules: preserved_modules,
        sourceFiles: source_files,
        trackedFiles: tracked_files,
    })
}

fn validate_preserved_export_sources(
    preserved_files: &BTreeSet<String>,
    context: &ResolveContext<'_>,
) -> std::result::Result<(), String> {
    for file_path in preserved_files {
        let path = PathBuf::from(file_path);
        let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let allocator = Allocator::default();
        let program = parse_scanned_module(&allocator, &path, &source)?;
        for statement in &program.body {
            let source = match statement {
                oxc_ast::ast::Statement::ExportAllDeclaration(export) => {
                    Some(export.source.value.as_str())
                }
                oxc_ast::ast::Statement::ExportNamedDeclaration(export) => {
                    export.source.as_ref().map(|source| source.value.as_str())
                }
                _ => None,
            };
            let Some(specifier) = source else {
                continue;
            };
            let Some(resolved) = resolve_module_specifier(specifier, &path, context)? else {
                return Err(format!(
                    "Unable to analyze preserved module export shape in {}: export source {specifier:?} is not a captured static module",
                    path.display()
                ));
            };
            let target = resolved.path.to_string_lossy().to_string();
            if !preserved_files.contains(&target) {
                return Err(format!(
                    "Unable to analyze preserved module export shape in {}: export source {specifier:?} crosses into compiled code",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn classify_preserved_modules(
    graph: &BTreeMap<String, Vec<String>>,
    seeds: &BTreeSet<String>,
) -> std::result::Result<BTreeSet<String>, String> {
    for seed in seeds {
        if let Some(cycle) = find_cycle_from_seed(seed, graph) {
            let mixed = cycle.iter().any(|file_path| !seeds.contains(file_path));
            if mixed {
                return Err(format!(
                    "Preserved/compiled module cycle is unsupported in phase 1: {}",
                    cycle.join(" -> ")
                ));
            }
        }
    }

    let mut preserved = seeds.clone();
    let mut pending = seeds.iter().cloned().collect::<Vec<_>>();
    while let Some(file_path) = pending.pop() {
        for dependency in graph.get(&file_path).into_iter().flatten() {
            if preserved.insert(dependency.clone()) {
                pending.push(dependency.clone());
            }
        }
    }
    Ok(preserved)
}

fn find_cycle_from_seed(seed: &str, graph: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    fn visit(
        current: &str,
        seed: &str,
        graph: &BTreeMap<String, Vec<String>>,
        path: &mut Vec<String>,
        visiting: &mut BTreeSet<String>,
    ) -> Option<Vec<String>> {
        path.push(current.to_string());
        visiting.insert(current.to_string());
        for dependency in graph.get(current).into_iter().flatten() {
            if dependency == seed {
                let mut cycle = path.clone();
                cycle.push(seed.to_string());
                return Some(cycle);
            }
            if visiting.contains(dependency) {
                continue;
            }
            if let Some(cycle) = visit(dependency, seed, graph, path, visiting) {
                return Some(cycle);
            }
        }
        visiting.remove(current);
        path.pop();
        None
    }

    visit(seed, seed, graph, &mut Vec::new(), &mut BTreeSet::new())
}

impl PackageMode {
    pub(super) fn parse(value: &str) -> std::result::Result<(Self, TargetDescriptor), String> {
        let (mode, target) = value.split_once(':').unwrap_or((value, "browser"));
        let package_mode = match mode {
            "esm-only" => Self::EsmOnly,
            "off" => Self::Off,
            _ => return Err(format!("Unsupported package mode: {mode}")),
        };
        Ok((package_mode, target_descriptor(target)?))
    }
}
