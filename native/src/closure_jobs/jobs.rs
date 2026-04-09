use super::*;

pub(super) fn prepare_bundler_runtime_jobs(
    input: &PrepareClosureJobsInput,
    resolved_chunks: &[ResolvedClosureChunk],
    raw_dir: &Path,
    runtime_asset_dir: &Path,
    warning_level: &str,
) -> std::result::Result<PrepareClosureJobsOutput, String> {
    let base_chunk = resolved_chunks
        .iter()
        .find(|chunk| chunk.kind.as_deref() == Some("base"))
        .or_else(|| resolved_chunks.first())
        .ok_or_else(|| "Chunk plan must contain at least one chunk.".to_string())?;

    let mut generated_assets = Vec::new();
    let mut compile_jobs = Vec::new();
    let mut postprocess_actions = Vec::new();
    let mut published_outputs = Vec::new();
    let runtime_debug = bundler_runtime_ids_are_readable();
    let mut module_map = BTreeMap::new();
    let mut runtime_module_map = BTreeMap::new();
    let mut manifest_chunks = BTreeMap::new();
    let mut module_text_by_chunk = BTreeMap::new();
    let chunk_index_by_name = resolved_chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| (chunk.name.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let runtime_chunk_id_by_name = resolved_chunks
        .iter()
        .map(|chunk| (chunk.name.clone(), to_bundler_runtime_chunk_id(&chunk.name)))
        .collect::<BTreeMap<_, _>>();

    for chunk in resolved_chunks {
        let mut module_sources = Vec::with_capacity(chunk.files.len());
        let mut manifest_modules = Vec::with_capacity(chunk.files.len());
        let chunk_index = *chunk_index_by_name
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing chunk index for {}", chunk.name))?;
        let runtime_chunk_id = runtime_chunk_id_by_name
            .get(&chunk.name)
            .cloned()
            .ok_or_else(|| format!("Missing runtime chunk id for {}", chunk.name))?;
        for file_path in &chunk.files {
            let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
            module_sources.push(source_text);
            let module_id =
                to_goog_module_id(Path::new(file_path), Path::new(&input.emittedOutDir));
            let runtime_module_id = to_bundler_runtime_module_id(&module_id);
            manifest_modules.push(runtime_module_id.clone());
            module_map.insert(runtime_module_id.clone(), runtime_chunk_id.clone());
            runtime_module_map.insert(runtime_module_id, chunk_index);
        }
        manifest_chunks.insert(
            runtime_chunk_id.clone(),
            BundlerRuntimeManifestChunk {
                deps: chunk
                    .dependencies
                    .iter()
                    .map(|dependency| to_bundler_runtime_chunk_id(dependency))
                    .collect(),
                modules: manifest_modules,
                url: format!(
                    "{}{}",
                    input.publicPath,
                    bundler_runtime_output_file_name(
                        &chunk.name,
                        &runtime_chunk_id,
                        &base_chunk.name,
                    )
                ),
            },
        );
        module_text_by_chunk.insert(chunk.name.clone(), module_sources.join("\n"));
    }

    let manifest = BundlerRuntimeManifest {
        baseChunk: runtime_chunk_id_by_name
            .get(&base_chunk.name)
            .cloned()
            .ok_or_else(|| format!("Missing runtime chunk id for {}", base_chunk.name))?,
        chunks: manifest_chunks,
        loader: input.chunkLoader.clone(),
        modules: module_map,
        publicPath: input.publicPath.clone(),
    };
    let runtime_manifest = BundlerRuntimeInitManifest(
        *chunk_index_by_name
            .get(&base_chunk.name)
            .ok_or_else(|| format!("Missing base chunk index for {}", base_chunk.name))?,
        resolved_chunks
            .iter()
            .map(|chunk| {
                let dependency_indices = chunk
                    .dependencies
                    .iter()
                    .map(|dependency| {
                        chunk_index_by_name.get(dependency).copied().ok_or_else(|| {
                            format!("Missing chunk index for dependency {}", dependency)
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok::<_, String>(BundlerRuntimeInitChunk(
                    dependency_indices,
                    if chunk.name == base_chunk.name {
                        String::new()
                    } else {
                        bundler_runtime_output_file_name(
                            &chunk.name,
                            runtime_chunk_id_by_name
                                .get(&chunk.name)
                                .map(String::as_str)
                                .ok_or_else(|| {
                                    format!("Missing runtime chunk id for {}", chunk.name)
                                })?,
                            &base_chunk.name,
                        )
                    },
                ))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?,
        runtime_module_map,
        if input.publicPath == "./" {
            String::new()
        } else {
            input.publicPath.clone()
        },
    );

    let mut effective_externs = collect_effective_extern_paths(
        &input.packageRoot,
        &input.explicitExternPaths,
        &input.generatedExternPaths,
        Some(&input.nativeExternPath),
        None,
    )?;
    effective_externs = unique_paths(effective_externs);

    if !input.manifestFile.is_empty() {
        let manifest_path = PathBuf::from(&input.outDir).join(&input.manifestFile);
        generated_assets.push(GeneratedAsset {
            path: manifest_path.to_string_lossy().to_string(),
            text: format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?
            ),
        });
        published_outputs.push(manifest_path.to_string_lossy().to_string());
    }

    let mut linked_chunk_paths = Vec::new();
    for chunk in resolved_chunks {
        let module_text = module_text_by_chunk
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source for {}", chunk.name))?;
        let source_text = if chunk.name == base_chunk.name {
            render_bundler_runtime_base_chunk(
                *chunk_index_by_name
                    .get(&chunk.name)
                    .ok_or_else(|| format!("Missing chunk index for {}", chunk.name))?,
                &chunk
                    .entry_points
                    .iter()
                    .map(|module_id| to_bundler_runtime_module_id(module_id))
                    .collect::<Vec<_>>(),
                &input.chunkLoader,
                &runtime_manifest,
                module_text,
                runtime_debug,
            )?
        } else {
            render_bundler_runtime_lazy_chunk(
                *chunk_index_by_name
                    .get(&chunk.name)
                    .ok_or_else(|| format!("Missing chunk index for {}", chunk.name))?,
                module_text,
                runtime_debug,
            )
        };
        let source_path = runtime_asset_dir.join(format!("{}.linked.js", chunk.name));
        generated_assets.push(GeneratedAsset {
            path: source_path.to_string_lossy().to_string(),
            text: source_text.clone(),
        });
        linked_chunk_paths.push((chunk.name.clone(), source_path));
    }

    let closure_lib_files = select_bundler_runtime_closure_lib_files(
        &input.packageRoot,
        &unique_paths(
            input
                .explicitJsInputs
                .iter()
                .cloned()
                .chain(
                    linked_chunk_paths
                        .iter()
                        .map(|(_, source_path)| source_path.to_string_lossy().to_string()),
                )
                .collect(),
        ),
    )?;
    let chunk_specs = resolved_chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let chunk_output_name = runtime_chunk_id_by_name
                .get(&chunk.name)
                .cloned()
                .ok_or_else(|| format!("Missing runtime chunk id for {}", chunk.name))?;
            let dependency_suffix = if chunk.dependencies.is_empty() {
                String::new()
            } else {
                format!(
                    ":{}",
                    chunk
                        .dependencies
                        .iter()
                        .map(|dependency| {
                            runtime_chunk_id_by_name
                                .get(dependency)
                                .cloned()
                                .ok_or_else(|| {
                                    format!("Missing runtime chunk id for {}", dependency)
                                })
                        })
                        .collect::<std::result::Result<Vec<_>, _>>()?
                        .join(",")
                )
            };
            Ok::<_, String>(format!(
                "{}:{}{}",
                chunk_output_name,
                1 + if index == 0 {
                    input.explicitJsInputs.len() + closure_lib_files.len()
                } else {
                    0
                },
                dependency_suffix
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let chunk_sources = linked_chunk_paths
        .iter()
        .map(|(_, source_path)| source_path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    compile_jobs.push(ClosureCompileJob {
        assumeFunctionWrapper: true,
        chunk: Some(chunk_specs),
        chunkOutputPathPrefix: Some(format!(
            "{}{}",
            raw_dir.to_string_lossy(),
            std::path::MAIN_SEPARATOR
        )),
        compilationLevel: input.compilationLevel.clone(),
        dependencyMode: None,
        entryPoint: None,
        externs: effective_externs,
        js: unique_paths(
            input
                .explicitJsInputs
                .iter()
                .cloned()
                .chain(closure_lib_files.into_iter())
                .chain(chunk_sources.into_iter())
                .collect(),
        ),
        jsOutputFile: None,
        languageIn: "UNSTABLE".to_string(),
        languageOut: input.languageOut.clone(),
        rewritePolyfills: false,
        warningLevel: warning_level.to_string(),
    });

    for chunk in resolved_chunks {
        let internal_chunk_name = runtime_chunk_id_by_name
            .get(&chunk.name)
            .cloned()
            .ok_or_else(|| format!("Missing runtime chunk id for {}", chunk.name))?;
        let final_chunk_file_name =
            bundler_runtime_output_file_name(&chunk.name, &internal_chunk_name, &base_chunk.name);
        let output_path = raw_dir.join(format!("{}.js", internal_chunk_name));
        let final_output_path = PathBuf::from(&input.outDir).join(final_chunk_file_name);
        postprocess_actions.push(PostprocessAction {
            inputPath: output_path.to_string_lossy().to_string(),
            kind: "copy".to_string(),
            outputPath: final_output_path.to_string_lossy().to_string(),
        });
        published_outputs.push(final_output_path.to_string_lossy().to_string());
    }

    Ok(PrepareClosureJobsOutput {
        compileJobs: compile_jobs,
        generatedAssets: generated_assets,
        postprocessActions: postprocess_actions,
        publishedOutputs: published_outputs,
    })
}

pub(super) fn prepare_off_mode_jobs(
    input: &PrepareClosureJobsInput,
    resolved_chunks: &[ResolvedClosureChunk],
    raw_dir: &Path,
    warning_level: &str,
) -> std::result::Result<PrepareClosureJobsOutput, String> {
    let closure_lib_files = select_closure_lib_files(
        &input.packageRoot,
        &unique_paths(
            input
                .supportFiles
                .iter()
                .cloned()
                .chain(
                    resolved_chunks
                        .iter()
                        .flat_map(|chunk| chunk.files.iter().cloned()),
                )
                .collect(),
        ),
    )?;
    let externs = collect_effective_extern_paths(
        &input.packageRoot,
        &input.explicitExternPaths,
        &input.generatedExternPaths,
        Some(&input.nativeExternPath),
        None,
    )?;

    let compile_jobs = if resolved_chunks.len() == 1 {
        let entry_chunk = resolved_chunks
            .first()
            .ok_or_else(|| "Chunk plan must contain at least one chunk.".to_string())?;
        vec![ClosureCompileJob {
            assumeFunctionWrapper: true,
            chunk: None,
            chunkOutputPathPrefix: None,
            compilationLevel: input.compilationLevel.clone(),
            dependencyMode: Some("PRUNE".to_string()),
            entryPoint: (!entry_chunk.entry_points.is_empty())
                .then_some(entry_chunk.entry_points.clone()),
            externs,
            js: unique_paths(
                input
                    .explicitJsInputs
                    .iter()
                    .cloned()
                    .chain(closure_lib_files.iter().cloned())
                    .chain(input.supportFiles.iter().cloned())
                    .chain(entry_chunk.files.iter().cloned())
                    .collect(),
            ),
            jsOutputFile: Some(
                raw_dir
                    .join(format!("{}.js", entry_chunk.name))
                    .to_string_lossy()
                    .to_string(),
            ),
            languageIn: "UNSTABLE".to_string(),
            languageOut: input.languageOut.clone(),
            rewritePolyfills: false,
            warningLevel: warning_level.to_string(),
        }]
    } else {
        let leading_js = unique_paths(
            input
                .explicitJsInputs
                .iter()
                .cloned()
                .chain(closure_lib_files.iter().cloned())
                .chain(input.supportFiles.iter().cloned())
                .collect(),
        );
        let chunk_specs = resolved_chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                let dependency_suffix = if chunk.dependencies.is_empty() {
                    String::new()
                } else {
                    format!(":{}", chunk.dependencies.join(","))
                };
                format!(
                    "{}:{}{}",
                    chunk.name,
                    unique_paths(chunk.files.clone()).len()
                        + if index == 0 { leading_js.len() } else { 0 },
                    dependency_suffix
                )
            })
            .collect::<Vec<_>>();
        let entry_points = unique_paths(
            resolved_chunks
                .iter()
                .flat_map(|chunk| chunk.entry_points.iter().cloned())
                .collect(),
        );
        vec![ClosureCompileJob {
            assumeFunctionWrapper: true,
            chunk: Some(chunk_specs),
            chunkOutputPathPrefix: Some(format!(
                "{}{}",
                raw_dir.to_string_lossy(),
                std::path::MAIN_SEPARATOR
            )),
            compilationLevel: input.compilationLevel.clone(),
            dependencyMode: Some("PRUNE".to_string()),
            entryPoint: (!entry_points.is_empty()).then_some(entry_points),
            externs,
            js: unique_paths(
                leading_js
                    .into_iter()
                    .chain(
                        resolved_chunks
                            .iter()
                            .flat_map(|chunk| chunk.files.iter().cloned()),
                    )
                    .collect(),
            ),
            jsOutputFile: None,
            languageIn: "UNSTABLE".to_string(),
            languageOut: input.languageOut.clone(),
            rewritePolyfills: false,
            warningLevel: warning_level.to_string(),
        }]
    };

    let postprocess_actions = resolved_chunks
        .iter()
        .map(|chunk| PostprocessAction {
            inputPath: raw_dir
                .join(format!("{}.js", chunk.name))
                .to_string_lossy()
                .to_string(),
            kind: "rewrite-gcc-exports".to_string(),
            outputPath: PathBuf::from(&input.outDir)
                .join(format!("{}.js", chunk.name))
                .to_string_lossy()
                .to_string(),
        })
        .collect::<Vec<_>>();
    let published_outputs = postprocess_actions
        .iter()
        .map(|action| action.outputPath.clone())
        .collect::<Vec<_>>();

    Ok(PrepareClosureJobsOutput {
        compileJobs: compile_jobs,
        generatedAssets: Vec::new(),
        postprocessActions: postprocess_actions,
        publishedOutputs: published_outputs,
    })
}
