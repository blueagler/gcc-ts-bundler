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
    let context = ResolveContext {
        package_mode: PackageMode::parse(&package_mode)?,
        src_dir: &src_dir,
        workspace_dir: &workspace_dir,
    };

    let mut consulted_package_jsons = BTreeSet::new();
    let mut commonjs_cache = HashMap::<PathBuf, CommonJsAnalysis>::new();
    let mut file_hashes = BTreeMap::new();
    let mut graph = BTreeMap::new();
    let mut lazy_imports = BTreeMap::<String, LazyImportEntry>::new();
    let mut package_aliases = BTreeMap::<String, PackageAliasEntry>::new();
    let mut resolved_imports = BTreeMap::<String, ResolvedImportEntry>::new();
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
            (
                extract_dependencies(&scanned),
                collect_dynamic_import_specifiers(&scanned)?,
            )
        };

        let mut dependencies = BTreeSet::new();
        for specifier in specifiers {
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

    let mut export_cache = HashMap::<PathBuf, EntryExportMetadata>::new();
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
        fileHashes: file_hashes
            .into_iter()
            .map(|(file_path, hash)| FileHashEntry {
                filePath: file_path,
                hash,
            })
            .collect(),
        graph: graph
            .into_iter()
            .map(|(file_path, dependencies)| DependencyGraphEntry {
                dependencies,
                filePath: file_path,
            })
            .collect(),
        lazyImports: lazy_imports.into_values().collect(),
        packageAliases: package_aliases.into_values().collect(),
        resolvedImports: resolved_imports.into_values().collect(),
        packageJsonFiles: package_json_files,
        sourceFiles: source_files,
        trackedFiles: tracked_files,
    })
}

impl PackageMode {
    pub(super) fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "esm-only" => Ok(Self::EsmOnly),
            "off" => Ok(Self::Off),
            _ => Err(format!("Unsupported package mode: {value}")),
        }
    }
}
