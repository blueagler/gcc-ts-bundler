use super::super::*;
use super::shared::property_renaming_report_path;
use crate::transpile::assigners::collect_annotated_assigner_names;
use regex::Regex;

#[derive(Clone, Debug, serde::Serialize)]
struct DebugBundlerRuntimeInitManifest(
    usize,
    Vec<BundlerRuntimeInitChunk>,
    BTreeMap<String, usize>,
    String,
);

pub(crate) fn prepare_bundler_runtime_jobs(
    input: &PrepareClosureJobsInput,
    resolved_chunks: &[ResolvedClosureChunk],
    raw_dir: &Path,
    runtime_asset_dir: &Path,
    warning_level: &str,
    chunk_output_type: ChunkOutputType,
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
    // Mirrors the transpile-side switch: GCC_DISABLE_HOIST=1 falls back to the
    // old registry/h() chunk format, which the loader still supports.
    let hoisted = !matches!(std::env::var("GCC_DISABLE_HOIST").as_deref(), Ok("1"));
    let mut module_map = BTreeMap::new();
    let mut runtime_module_map = BTreeMap::new();
    let mut manifest_chunks = BTreeMap::new();
    let mut module_text_by_chunk = BTreeMap::new();
    let mut runtime_module_ids = Vec::new();
    let mut registered_runtime_ids = std::collections::BTreeSet::new();
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
            let module_id =
                to_goog_module_id(Path::new(file_path), Path::new(&input.emittedOutDir));
            let runtime_module_id = to_bundler_runtime_module_id(&module_id);
            if source_text.contains("__register(") {
                registered_runtime_ids.insert(runtime_module_id.clone());
            }
            module_sources.push(source_text);
            runtime_module_ids.push(runtime_module_id.clone());
            manifest_modules.push(runtime_module_id.clone());
            module_map.insert(runtime_module_id.clone(), runtime_chunk_id.clone());
            runtime_module_map.insert(runtime_module_id, chunk_index);
        }
        manifest_chunks.insert(
            runtime_chunk_id.clone(),
            BundlerRuntimeManifestChunk {
                css: vec![],
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

    let runtime_module_index_by_id = runtime_module_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .enumerate()
        .map(|(index, module_id)| (module_id, index))
        .collect::<BTreeMap<_, _>>();

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
    let runtime_chunks = resolved_chunks
        .iter()
        .map(|chunk| {
            let dependency_indices = chunk
                .dependencies
                .iter()
                .map(|dependency| {
                    chunk_index_by_name
                        .get(dependency)
                        .copied()
                        .ok_or_else(|| format!("Missing chunk index for dependency {}", dependency))
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok::<_, String>(BundlerRuntimeInitChunk(
                dependency_indices,
                if chunk.name == base_chunk.name {
                    String::new()
                } else {
                    let file_name = bundler_runtime_output_file_name(
                        &chunk.name,
                        runtime_chunk_id_by_name
                            .get(&chunk.name)
                            .map(String::as_str)
                            .ok_or_else(|| {
                                format!("Missing runtime chunk id for {}", chunk.name)
                            })?,
                        &base_chunk.name,
                    );
                    if chunk_output_type.is_esm() {
                        // A relative specifier resolves against the importing
                        // chunk's own URL, which removes the need for a public
                        // path (and the `document.currentScript` hack) for JS.
                        format!("./{file_name}")
                    } else {
                        file_name
                    }
                },
                vec![],
            ))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let base_chunk_index = *chunk_index_by_name
        .get(&base_chunk.name)
        .ok_or_else(|| format!("Missing base chunk index for {}", base_chunk.name))?;
    let public_path = if input.publicPath == "./" {
        String::new()
    } else {
        input.publicPath.clone()
    };
    let runtime_manifest_json = if runtime_debug {
        serde_json::to_string(&DebugBundlerRuntimeInitManifest(
            base_chunk_index,
            runtime_chunks.clone(),
            runtime_module_map.clone(),
            public_path.clone(),
        ))
        .map_err(|error| error.to_string())?
    } else {
        let mut runtime_module_chunks = vec![0usize; runtime_module_index_by_id.len()];
        for (runtime_module_id, chunk_index) in &runtime_module_map {
            let module_index = *runtime_module_index_by_id
                .get(runtime_module_id)
                .ok_or_else(|| format!("Missing module index for {}", runtime_module_id))?;
            runtime_module_chunks[module_index] = *chunk_index;
        }
        serde_json::to_string(&BundlerRuntimeInitManifest(
            base_chunk_index,
            runtime_chunks,
            runtime_module_chunks,
            public_path,
        ))
        .map_err(|error| error.to_string())?
    };

    let mut effective_externs = collect_effective_extern_paths(
        &input.packageRoot,
        &input.explicitExternPaths,
        &input.generatedExternPaths,
        Some(&input.nativeExternPath),
        None,
    )?;
    effective_externs = unique_paths(effective_externs);
    let property_renaming_report_path =
        property_renaming_report_path(raw_dir, &input.compilationLevel);
    let leading_js_inputs = unique_paths(input.explicitJsInputs.clone());

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

    // Hoisted entry modules execute inline when the chunk body runs; only
    // registry-form entries still need an explicit `r.n` kick.
    let registry_entry_runtime_ids = base_chunk
        .entry_points
        .iter()
        .map(|module_id| to_bundler_runtime_module_id(module_id))
        .filter(|runtime_module_id| registered_runtime_ids.contains(runtime_module_id))
        .collect::<Vec<_>>();
    let base_entry_points_json = if runtime_debug {
        serde_json::to_string(&registry_entry_runtime_ids).map_err(|error| error.to_string())?
    } else {
        serde_json::to_string(
            &registry_entry_runtime_ids
                .iter()
                .map(|runtime_module_id| {
                    runtime_module_index_by_id
                        .get(runtime_module_id)
                        .copied()
                        .ok_or_else(|| format!("Missing module index for {}", runtime_module_id))
                })
                .collect::<std::result::Result<Vec<_>, _>>()?,
        )
        .map_err(|error| error.to_string())?
    };
    let all_module_contents = module_text_by_chunk
        .values()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let include_custom_elements_es5_adapter =
        needs_custom_elements_es5_adapter(&input.languageOut, &all_module_contents);

    // The plan puts a vendor chunk first precisely so base's generated
    // `import "./<vendor>.js"` edge executes it at startup. That inverts the
    // usual order: vendor runs before base's preamble would have created the
    // runtime object, so the guarded core travels with whichever chunk is
    // first and base keeps only `r.a(<manifest>)`. Vendor stays free of the
    // manifest by design - the manifest holds chunk URLs that change on every
    // app edit, and vendor keeping its filename across app edits is the whole
    // point of the feature.
    let runtime_core_chunk_name = resolved_chunks
        .first()
        .filter(|chunk| chunk.name != base_chunk.name)
        .map(|chunk| chunk.name.clone());
    let runtime_core = runtime_core_chunk_name
        .as_ref()
        .map(|_| {
            render_bundler_runtime_preamble_part(
                &runtime_manifest_json,
                !runtime_debug,
                runtime_debug,
                chunk_output_type,
                RuntimePreamblePart::Core,
            )
        })
        .transpose()?;

    let mut linked_chunk_paths = Vec::new();
    for chunk in resolved_chunks {
        let module_text = module_text_by_chunk
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source for {}", chunk.name))?;
        let chunk_index = *chunk_index_by_name
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing chunk index for {}", chunk.name))?;
        let rewritten_module_text = (!runtime_debug)
            .then(|| rewrite_runtime_module_ids(module_text, &runtime_module_index_by_id))
            .transpose()?;
        let module_text = rewritten_module_text.as_deref().unwrap_or(module_text);
        // Must run after the module-id rewrite, which matches on the unsuffixed
        // callee names.
        let suffixed_module_text = rename_runtime_aliases(
            module_text,
            &runtime_alias_suffix(chunk_index, chunk_output_type),
        )?;
        let module_text = suffixed_module_text.as_deref().unwrap_or(module_text);
        // The transpiler annotated these; reading the marker back out of the
        // assembled text is what carries the list across the per-module file
        // boundary, and keeps the pin exactly in step with what was annotated.
        let assigner_names = if chunk.kind.as_deref() == Some("vendor") {
            collect_annotated_assigner_names(module_text)
        } else {
            Vec::new()
        };
        let source_text = if chunk.name == base_chunk.name {
            render_bundler_runtime_base_chunk(
                base_chunk_index,
                &base_entry_points_json,
                &input.chunkLoader,
                &runtime_manifest_json,
                !runtime_debug,
                module_text,
                include_custom_elements_es5_adapter,
                runtime_debug,
                hoisted,
                chunk_output_type,
                if runtime_core.is_some() {
                    RuntimePreamblePart::ManifestOnly
                } else {
                    RuntimePreamblePart::All
                },
            )?
        } else {
            render_bundler_runtime_lazy_chunk(
                chunk_index,
                module_text,
                runtime_debug,
                hoisted,
                chunk_output_type,
                runtime_core_chunk_name
                    .as_deref()
                    .filter(|name| *name == chunk.name)
                    .and(runtime_core.as_deref()),
                &assigner_names,
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
            leading_js_inputs
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
                    leading_js_inputs.len() + closure_lib_files.len()
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
        // ES_MODULES already implies `setAssumeGlobalScopeIsIsolated(true)`
        // inside the compiler; passing the flag as well is a no-op there and
        // keeps script mode unchanged, so there is one value for both modes.
        assumeFunctionWrapper: true,
        chunk: Some(chunk_specs),
        chunkOutputType: chunk_output_type.is_esm().then(|| "ES_MODULES".to_string()),
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
            leading_js_inputs
                .iter()
                .cloned()
                .chain(closure_lib_files.into_iter())
                .chain(chunk_sources.into_iter())
                .collect(),
        ),
        jsOutputFile: None,
        languageIn: "UNSTABLE".to_string(),
        languageOut: input.languageOut.clone(),
        propertyRenamingReportPath: property_renaming_report_path.clone(),
        // Hoisted module code is top level, so Closure prefixes every
        // cross-chunk survivor onto $gcc. Postprocess wraps each output chunk
        // in an IIFE that redeclares $gcc from globalThis, so direct
        // cross-chunk identifier references resolve through one shared object.
        // ES_MODULES gets real `import`/`export` edges instead, and Closure
        // rejects the flag outright in that mode.
        renamePrefixNamespace: (!chunk_output_type.is_esm())
            .then(|| BUNDLER_RUNTIME_PREFIX_NAMESPACE.to_string()),
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
            kind: if property_renaming_report_path.is_some() {
                "rewrite-decorator-metadata".to_string()
            } else {
                "copy".to_string()
            },
            outputPath: final_output_path.to_string_lossy().to_string(),
            propertyRenamingReportPath: property_renaming_report_path.clone(),
        });
        published_outputs.push(final_output_path.to_string_lossy().to_string());
    }

    Ok(PrepareClosureJobsOutput {
        bundlerRuntimeBaseInputPath: runtime_chunk_id_by_name
            .get(&base_chunk.name)
            .map(|internal_chunk_name| raw_dir.join(format!("{internal_chunk_name}.js")))
            .map(|path| path.to_string_lossy().to_string()),
        compileJobs: compile_jobs,
        generatedAssets: generated_assets,
        postprocessActions: postprocess_actions,
        publishedOutputs: published_outputs,
    })
}

const RUNTIME_ALIAS_NAMES: [&str; 4] = [
    "__register",
    "__require",
    "__dynamicImport",
    "__preloadDynamicImport",
];

/// Renames the loader alias identifiers a chunk's module code references, to
/// match the per-chunk-unique declarations emitted by the alias line. Both the
/// declaration and every reference live in this one chunk's text, so a
/// whole-text rename stays scope-consistent (registry-form modules take these
/// names as function parameters, which rename with their uses).
fn rename_runtime_aliases(
    source_text: &str,
    suffix: &str,
) -> std::result::Result<Option<String>, String> {
    if suffix.is_empty() {
        return Ok(None);
    }
    let mut current = source_text.to_string();
    for name in RUNTIME_ALIAS_NAMES {
        let regex = Regex::new(&format!(r"\b{name}\b")).map_err(|error| error.to_string())?;
        current = regex
            .replace_all(&current, format!("{name}{suffix}"))
            .into_owned();
    }
    Ok(Some(current))
}

fn rewrite_runtime_module_ids(
    source_text: &str,
    runtime_module_index_by_id: &BTreeMap<String, usize>,
) -> std::result::Result<String, String> {
    let rewrites = [
        (
            Regex::new(r#"__register\("([^"]+)"\s*,"#).map_err(|error| error.to_string())?,
            "__register",
        ),
        (
            Regex::new(r#"__require\("([^"]+)"\)"#).map_err(|error| error.to_string())?,
            "__require",
        ),
        (
            Regex::new(r#"__dynamicImport\("([^"]+)"\)"#).map_err(|error| error.to_string())?,
            "__dynamicImport",
        ),
        (
            Regex::new(r#"__preloadDynamicImport\("([^"]+)"\)"#)
                .map_err(|error| error.to_string())?,
            "__preloadDynamicImport",
        ),
    ];
    let mut current = source_text.to_string();
    for (regex, callee_name) in rewrites {
        current = regex
            .replace_all(&current, |captures: &regex::Captures| {
                let runtime_module_id = captures
                    .get(1)
                    .map(|capture| capture.as_str())
                    .unwrap_or_default();
                let module_index = runtime_module_index_by_id
                    .get(runtime_module_id)
                    .copied()
                    .unwrap_or_else(|| panic!("Missing module index for {}", runtime_module_id));
                format!("{callee_name}({module_index}")
                    + if callee_name == "__register" {
                        ","
                    } else {
                        ")"
                    }
            })
            .into_owned();
    }
    Ok(current)
}
