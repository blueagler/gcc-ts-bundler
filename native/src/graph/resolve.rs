use super::package_resolver::is_external_boundary_specifier;
use super::*;
use oxc_allocator::Allocator;

pub(super) fn resolve_graph_impl(
    entries: Vec<String>,
    src_dir: String,
    workspace_dir: String,
    package_mode: String,
) -> std::result::Result<ResolveGraphOutput, String> {
    let src_dir = PathBuf::from(src_dir);
    let workspace_dir = PathBuf::from(workspace_dir);
    let entries: Vec<PathBuf> = entries.into_iter().map(PathBuf::from).collect();
    let (package_mode, target) = PackageMode::parse(&package_mode)?;
    let context = ResolveContext {
        package_mode,
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

        let commonjs_analysis = analyze_commonjs_source(&current_file, &contents)?;
        if commonjs_analysis.has_commonjs {
            validate_commonjs_usage(&current_file, &commonjs_analysis, &context)?;
        }
        commonjs_cache.insert(current_file.clone(), commonjs_analysis.clone());

        // The scanner owns this parse. Only the non-CommonJS path needs it, so
        // the extra parse is skipped exactly where its answers are unused.
        let scan_allocator = Allocator::default();
        let (specifiers, lazy_specifiers) = if commonjs_analysis.has_commonjs {
            (commonjs_analysis.dependencies.clone(), Vec::new())
        } else {
            let scanned = parse_scanned_module(&scan_allocator, &current_file, &contents)?;
            if has_top_level_await(&scanned) {
                top_level_await_modules.insert(current_file.to_string_lossy().to_string());
            }
            (
                extract_dependencies(&scanned),
                collect_dynamic_import_specifiers(&scanned)?,
            )
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

    let preserved_file_paths = classify_preserved_modules(&graph, &top_level_await_modules)?;
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
        moduleKinds: graph
            .keys()
            .map(|file_path| ModuleKindEntry {
                filePath: file_path.clone(),
                kind: if preserved_file_paths.contains(file_path) {
                    "preserved".to_string()
                } else {
                    "compiled".to_string()
                },
            })
            .collect(),
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
