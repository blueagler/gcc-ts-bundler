use super::super::*;
use super::shared::{aggregate_type_metadata, property_renaming_report_path};
use crate::transpile::assigners::collect_annotated_assigner_names;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, BindingPattern, Expression, IdentifierReference, Program};
use oxc_ast::AstKind;
use oxc_semantic::{Semantic, SemanticBuilder, SymbolId};
use oxc_span::SourceType;
use std::collections::{HashMap, HashSet};

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
    let (type_metadata_counts, has_type_metadata) = aggregate_type_metadata(
        input,
        resolved_chunks
            .iter()
            .flat_map(|chunk| chunk.files.iter().cloned())
            .collect::<Vec<_>>(),
    )?;

    let mut generated_assets = Vec::new();
    let mut compile_jobs = Vec::new();
    let mut postprocess_actions = Vec::new();
    let mut published_outputs = Vec::new();
    let runtime_debug = bundler_runtime_ids_are_readable();
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

    // Every optional runtime block hangs off the global `__g` object, so
    // Closure can never prove one dead. Deciding here is the only place the
    // question can be answered, and every answer is a fail-closed
    // over-approximation: a substring hit on the assembled module text is
    // enough to keep a block.
    //
    // CSS is the one capability this side cannot see on its own: standalone
    // builds never fill manifest CSS rows, and the Vite plugin fills them
    // *after* the compile, so it passes its pre-compile CSS-ownership answer
    // in through `needsCssRuntime`.
    let capabilities = RuntimeCapabilities {
        css: input.needsCssRuntime || manifest.chunks.values().any(|chunk| !chunk.css.is_empty()),
        entry_runner: base_entry_points_json != "[]",
        live_exports: calls_runtime_helper(&all_module_contents, "__live"),
        preload: calls_runtime_helper(&all_module_contents, "__preloadDynamicImport"),
    };
    // A known-safe one-chunk ESM graph whose emitted modules call none of the
    // runtime ABI has nothing for the browser-side manifest, registry, loader,
    // or promise state to do. Keep the build-time JSON manifest for naming/CSS
    // ownership, and mark the final base output for structural runtime stripping.
    // Preserved ESM boundaries and Vite worker-asset placeholders stay on the
    // conservative side of the gate: both cross delivery systems that this
    // capability scan does not classify, so unknown means retain.
    let elide_runtime = chunk_output_type.is_esm()
        && resolved_chunks.len() == 1
        && base_chunk.dependencies.is_empty()
        && !input.hasPreservedModules
        && !all_module_contents.contains("__VITE_WORKER_ASSET__")
        && !capabilities.css
        && !capabilities.entry_runner
        && !capabilities.live_exports
        && !capabilities.preload
        && !calls_runtime_helper(&all_module_contents, "__register")
        && !calls_runtime_helper(&all_module_contents, "__require")
        && !calls_runtime_helper(&all_module_contents, "__dynamicImport");

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
                capabilities,
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
        // Module-id replacement runs first because it keys generated calls by
        // resolver identity before their per-chunk aliases are renamed.
        let requested_alias_suffix = runtime_alias_suffix(chunk_index, chunk_output_type);
        let alias_rewrite = rename_runtime_aliases(module_text, &requested_alias_suffix)?;
        let module_text = alias_rewrite.text.as_deref().unwrap_or(module_text);
        // The transpiler annotated these; reading the marker back out of the
        // assembled text is what carries the list across the per-module file
        // boundary, and keeps the pin exactly in step with what was annotated.
        let assigner_names = if chunk.kind.as_deref() == Some("vendor") {
            collect_annotated_assigner_names(module_text)
        } else {
            Vec::new()
        };
        let source_text = if chunk.name == base_chunk.name {
            render_bundler_runtime_base_chunk_with_alias_suffix(
                base_chunk_index,
                &base_entry_points_json,
                &input.chunkLoader,
                &runtime_manifest_json,
                !runtime_debug,
                module_text,
                include_custom_elements_es5_adapter,
                runtime_debug,
                chunk_output_type,
                if runtime_core.is_some() {
                    RuntimePreamblePart::ManifestOnly
                } else {
                    RuntimePreamblePart::All
                },
                &alias_rewrite.suffix,
                capabilities,
            )?
        } else {
            render_bundler_runtime_lazy_chunk_with_alias_suffix(
                chunk_index,
                module_text,
                runtime_core_chunk_name
                    .as_deref()
                    .filter(|name| *name == chunk.name)
                    .and(runtime_core.as_deref()),
                &assigner_names,
                &alias_rewrite.suffix,
                capabilities,
            )
        };
        let source_path = runtime_asset_dir.join(format!("{}.linked.js", chunk.name));
        generated_assets.push(GeneratedAsset {
            path: source_path.to_string_lossy().to_string(),
            text: source_text.clone(),
        });
        linked_chunk_paths.push((chunk.name.clone(), source_path));
    }

    let mut closure_lib_files =
        select_bundler_runtime_closure_lib_files(&input.packageRoot, &leading_js_inputs)?;
    // Linked chunks are generated in memory and are not written until the job
    // executes, so file-based selection cannot inspect them here. Include the
    // reflect runtime when native emission introduced a goog.reflect call.
    if generated_assets
        .iter()
        .any(|asset| asset.text.contains("goog.reflect."))
    {
        let closure_lib_dir = Path::new(&input.packageRoot).join("closure-lib");
        closure_lib_files.extend([
            closure_lib_dir
                .join("base.js")
                .to_string_lossy()
                .to_string(),
            closure_lib_dir
                .join("reflect.js")
                .to_string_lossy()
                .to_string(),
        ]);
        closure_lib_files = unique_paths(closure_lib_files);
    }
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
                .chain(closure_lib_files)
                .chain(chunk_sources)
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
        hasTypeMetadata: has_type_metadata,
        typeMetadataCounts: type_metadata_counts,
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
            // Compile the ordinary runtime-shaped input so removing an unused
            // eager-only envelope cannot perturb Closure's optimization of the
            // application body. The postprocess action strips only the two
            // generated leading statements after Closure, with structural
            // validation and a fail-closed error if their shape drifts.
            kind: if elide_runtime && chunk.name == base_chunk.name {
                "strip-bundler-runtime".to_string()
            } else {
                "copy".to_string()
            },
            outputPath: final_output_path.to_string_lossy().to_string(),
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

/// Whether any module *calls* a generated runtime helper.
///
/// Every registry facade lists all five helpers in its parameter list whether
/// or not it uses them, so a plain substring test is always true and gates
/// nothing. Only a call site proves the helper is reachable. Collision-renamed
/// spellings (`__live1`, `__live2`, ...) count too: `RuntimeBindingNames`
/// allocates them by appending digits.
fn calls_runtime_helper(text: &str, name: &str) -> bool {
    let bytes = text.as_bytes();
    let mut search_from = 0usize;
    while let Some(offset) = text[search_from..].find(name) {
        let start = search_from + offset;
        let mut cursor = start + name.len();
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b'(') {
            return true;
        }
        search_from = start + name.len();
    }
    false
}

const RUNTIME_ALIAS_DECL_NAMES: [&str; 5] = [
    "__runtime",
    "__register",
    "__require",
    "__dynamicImport",
    "__preloadDynamicImport",
];

const RUNTIME_ALIAS_NAMES: [&str; 4] = [
    "__register",
    "__require",
    "__dynamicImport",
    "__preloadDynamicImport",
];

struct RuntimeAliasRewrite {
    text: Option<String>,
    suffix: String,
}

fn rename_runtime_aliases(
    source_text: &str,
    requested_suffix: &str,
) -> std::result::Result<RuntimeAliasRewrite, String> {
    if requested_suffix.is_empty() {
        return Ok(RuntimeAliasRewrite {
            text: None,
            suffix: String::new(),
        });
    }
    let allocator = Allocator::default();
    let program = parse_runtime_program(&allocator, source_text)?;
    let semantic = build_runtime_semantic(&program);

    let mut targets = Vec::<(usize, usize, &'static str)>::new();
    let mut used_names = HashSet::<String>::new();
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::IdentifierReference(ident) => {
                // Only a free reference to the generated helper is a rename
                // target. A reference that resolves to any declaration in the
                // file is an authored binding and must keep its spelling.
                match RUNTIME_ALIAS_NAMES
                    .into_iter()
                    .find(|name| *name == ident.name.as_str())
                    .filter(|_| is_unresolved(&semantic, ident))
                {
                    Some(name) => {
                        targets.push((ident.span.start as usize, ident.span.end as usize, name))
                    }
                    None => {
                        used_names.insert(ident.name.to_string());
                    }
                }
            }
            // Binding and label names occupy the same namespace the suffix
            // search has to dodge. Member and property names (oxc
            // `IdentifierName`) deliberately do not, matching what swc's
            // `Ident`-only visitor saw.
            AstKind::BindingIdentifier(ident) => {
                used_names.insert(ident.name.to_string());
            }
            AstKind::LabelIdentifier(ident) => {
                used_names.insert(ident.name.to_string());
            }
            _ => {}
        }
    }

    let mut suffix = requested_suffix.to_string();
    let mut counter = 1usize;
    while RUNTIME_ALIAS_DECL_NAMES
        .iter()
        .any(|name| used_names.contains(&format!("{name}{suffix}")))
    {
        suffix = format!("{requested_suffix}_{counter}");
        counter += 1;
    }
    let edits = targets
        .into_iter()
        .map(|(start, end, name)| (start, end, format!("{name}{suffix}")))
        .collect();
    Ok(RuntimeAliasRewrite {
        text: Some(apply_runtime_source_edits(source_text, edits)?),
        suffix,
    })
}

#[derive(Clone, Copy)]
enum RuntimeCallKind {
    Register,
    Require,
    DynamicImport,
    PreloadDynamicImport,
}

fn rewrite_runtime_module_ids(
    source_text: &str,
    runtime_module_index_by_id: &BTreeMap<String, usize>,
) -> std::result::Result<String, String> {
    let allocator = Allocator::default();
    let program = parse_runtime_program(&allocator, source_text)?;
    let semantic = build_runtime_semantic(&program);

    // Every registry facade rebinds the helpers as callback parameters, so the
    // parameter symbols are as much a call site as the free global is. Position
    // in the facade signature is what names them.
    let mut param_call_ids = HashMap::<SymbolId, RuntimeCallKind>::new();
    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::Identifier(callee) = &call.callee else {
            continue;
        };
        if callee.name != "__register" || !is_unresolved(&semantic, callee) {
            continue;
        }
        let Some(callback) = call.arguments.get(1).and_then(Argument::as_expression) else {
            continue;
        };
        let params = match callback {
            Expression::FunctionExpression(function) => &function.params,
            Expression::ArrowFunctionExpression(arrow) => &arrow.params,
            _ => continue,
        };
        for (index, parameter) in params.items.iter().enumerate() {
            let BindingPattern::BindingIdentifier(binding) = &parameter.pattern else {
                continue;
            };
            let kind = match index {
                0 => RuntimeCallKind::Require,
                2 => RuntimeCallKind::DynamicImport,
                3 => RuntimeCallKind::PreloadDynamicImport,
                _ => continue,
            };
            param_call_ids.insert(binding.symbol_id(), kind);
        }
    }

    let mut edits = Vec::<(usize, usize, String)>::new();
    let mut errors = Vec::<String>::new();
    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::Identifier(callee) = &call.callee else {
            continue;
        };
        if runtime_call_kind(&semantic, callee, &param_call_ids).is_none() {
            continue;
        }
        let Some(argument) = call.arguments.first().and_then(Argument::as_expression) else {
            continue;
        };
        let Expression::StringLiteral(module_id) = argument else {
            continue;
        };
        let Some(module_index) = runtime_module_index_by_id.get(module_id.value.as_str()) else {
            errors.push(format!("Missing module index for {}", module_id.value));
            continue;
        };
        // oxc spans are plain byte offsets into `source_text`, so the literal's
        // span - quotes included - is already the replacement range.
        edits.push((
            module_id.span.start as usize,
            module_id.span.end as usize,
            module_index.to_string(),
        ));
    }
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    apply_runtime_source_edits(source_text, edits)
}

/// Which generated helper a callee names, if any: either a free reference to
/// the global spelling or a reference to a facade parameter that rebound it.
fn runtime_call_kind(
    semantic: &Semantic<'_>,
    callee: &IdentifierReference<'_>,
    param_call_ids: &HashMap<SymbolId, RuntimeCallKind>,
) -> Option<RuntimeCallKind> {
    match semantic
        .scoping()
        .get_reference(callee.reference_id())
        .symbol_id()
    {
        Some(symbol_id) => param_call_ids.get(&symbol_id).copied(),
        None => match callee.name.as_str() {
            "__register" => Some(RuntimeCallKind::Register),
            "__require" => Some(RuntimeCallKind::Require),
            "__dynamicImport" => Some(RuntimeCallKind::DynamicImport),
            "__preloadDynamicImport" => Some(RuntimeCallKind::PreloadDynamicImport),
            _ => None,
        },
    }
}

/// True when the reference resolves to no declaration in this file, which is
/// oxc's equivalent of swc's "carries the unresolved mark".
fn is_unresolved(semantic: &Semantic<'_>, ident: &IdentifierReference<'_>) -> bool {
    semantic
        .scoping()
        .get_reference(ident.reference_id())
        .symbol_id()
        .is_none()
}

fn parse_runtime_program<'a>(
    allocator: &'a Allocator,
    source_text: &'a str,
) -> std::result::Result<Program<'a>, String> {
    let parsed = oxc_parser::Parser::new(allocator, source_text, SourceType::mjs()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("bundler-runtime-linked.js: {}", error.message));
    }
    Ok(parsed.program)
}

/// Resolves bindings. This is the oxc replacement for swc's `resolver` pass:
/// the scope tree it builds is what distinguishes a generated helper call from
/// an authored binding that happens to share the name.
///
/// `with_build_nodes` is off by default and leaves `Semantic::nodes` empty, so
/// both passes below would silently find nothing to rewrite.
fn build_runtime_semantic<'a>(program: &'a Program<'a>) -> Semantic<'a> {
    SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic
}

fn apply_runtime_source_edits(
    source_text: &str,
    mut edits: Vec<(usize, usize, String)>,
) -> std::result::Result<String, String> {
    edits.sort_by_key(|(start, _, _)| *start);
    let mut output = source_text.to_string();
    for (start, end, replacement) in edits.into_iter().rev() {
        if start > end
            || end > output.len()
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            return Err("Invalid bundler-runtime source edit span".to_string());
        }
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

#[cfg(test)]
mod identity_regressions {
    use super::*;

    #[test]
    fn runtime_text_rewrites_skip_literals_and_authored_bindings() {
        let source = concat!(
            "function __require(id){return id;}\n",
            "globalThis.label='__require';\n",
            "globalThis.local=__require(\"user-value\");\n",
            "__register(\"m0\",function(__require,__exports,__dynamicImport,__preloadDynamicImport,__live){",
            "return __require(\"m1\");});\n",
);
        let rewritten = rewrite_runtime_module_ids(
            source,
            &BTreeMap::from([("m0".to_string(), 0), ("m1".to_string(), 1)]),
        )
        .expect("runtime ids");
        assert!(rewritten.contains("label='__require'"), "{rewritten}");
        assert!(
            rewritten.contains("__require(\"user-value\")"),
            "{rewritten}"
        );
        assert!(rewritten.contains("__register(0"), "{rewritten}");
        assert!(rewritten.contains("return __require(1)"), "{rewritten}");
    }

    #[test]
    fn missing_generated_runtime_module_id_is_an_error() {
        let error = rewrite_runtime_module_ids("__dynamicImport(\"missing\");", &BTreeMap::new())
            .expect_err("missing id");
        assert_eq!(error, "Missing module index for missing");
    }

    #[test]
    fn runtime_alias_plan_avoids_descendant_bindings() {
        let source = concat!(
            "globalThis.label='__require';",
            "function use(__require_0){return __require_0;}",
            "const __runtime_0=1;",
            "__require(0);",
        );
        let rewritten = rename_runtime_aliases(source, "_0").expect("aliases");
        assert_eq!(rewritten.suffix, "_0_1");
        let code = rewritten.text.expect("rewritten text");
        assert!(code.contains("label='__require'"), "{code}");
        assert!(code.contains("function use(__require_0)"), "{code}");
        assert!(code.contains("const __runtime_0=1"), "{code}");
        assert!(code.contains("__require_0_1(0)"), "{code}");
    }
}
