use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::pathing::{
    bundler_runtime_ids_are_readable, to_bundler_runtime_chunk_id, to_bundler_runtime_module_id,
    to_goog_module_id,
};

use super::super::chunk_plan::ResolvedClosureChunk;
use super::super::externs::{
    collect_effective_extern_paths, select_bundler_runtime_closure_lib_files,
    select_effective_extern_paths, unique_paths, ClosureLibScanner,
};
use super::super::runtime::{
    bundler_runtime_output_file_name, needs_custom_elements_es5_adapter,
    render_bundler_runtime_base_chunk, render_bundler_runtime_lazy_chunk_with_alias_suffix,
    render_bundler_runtime_preamble_part, runtime_alias_suffix, BundlerRuntimeBaseChunkInput,
    BundlerRuntimeInitChunk, BundlerRuntimeInitManifest, BundlerRuntimeManifest,
    BundlerRuntimeManifestChunk, RuntimeCapabilities, RuntimePreamblePart,
};
use super::super::{
    ChunkOutputType, ClosureCompileJob, GeneratedAsset, PostprocessAction, PrepareClosureJobsInput,
    PrepareClosureJobsOutput, BUNDLER_RUNTIME_PREFIX_NAMESPACE,
};
use super::shared::{aggregate_type_metadata, property_renaming_report_path};
use crate::transpile::assigners::collect_annotated_assigner_names;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Argument, BindingPattern, Expression, IdentifierReference, Program};
use oxc_ast::AstKind;
use oxc_semantic::{Semantic, SemanticBuilder, SymbolId};
use oxc_span::SourceType;

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
                to_goog_module_id(Path::new(file_path), Path::new(&input.emitted_out_dir));
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
                    input.public_path,
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
        base_chunk: runtime_chunk_id_by_name
            .get(&base_chunk.name)
            .cloned()
            .ok_or_else(|| format!("Missing runtime chunk id for {}", base_chunk.name))?,
        chunks: manifest_chunks,
        loader: input.chunk_loader.clone(),
        modules: module_map,
        public_path: input.public_path.clone(),
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
    let public_path = if input.public_path == "./" {
        String::new()
    } else {
        input.public_path.clone()
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

    let effective_externs = collect_effective_extern_paths(
        &input.package_root,
        &input.explicit_extern_paths,
        &input.generated_externs,
        Some(&input.native_extern_path),
        None,
    )?;
    let effective_externs = select_effective_extern_paths(&effective_externs, None);
    let property_renaming_report_path =
        property_renaming_report_path(raw_dir, &input.compilation_level, &base_chunk.name);
    let leading_js_inputs = unique_paths(input.explicit_js_inputs.clone());

    if !input.manifest_file.is_empty() {
        let manifest_path = PathBuf::from(&input.out_dir).join(&input.manifest_file);
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
        needs_custom_elements_es5_adapter(&input.language_out, &all_module_contents);

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
        css: input.needs_css_runtime || manifest.chunks.values().any(|chunk| !chunk.css.is_empty()),
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
        && !input.has_preserved_modules
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
    let runtime_core = runtime_core_chunk_name.as_ref().map(|_| {
        render_bundler_runtime_preamble_part(
            &runtime_manifest_json,
            runtime_debug,
            chunk_output_type,
            RuntimePreamblePart::Core,
            capabilities,
        )
    });

    let mut linked_chunk_paths = Vec::new();
    for chunk in resolved_chunks {
        let module_text = module_text_by_chunk
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source for {}", chunk.name))?;
        let chunk_index = *chunk_index_by_name
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing chunk index for {}", chunk.name))?;
        let requested_alias_suffix = runtime_alias_suffix(chunk_index, chunk_output_type);
        let rewrite = rewrite_runtime_source(
            module_text,
            &runtime_module_index_by_id,
            runtime_debug,
            &requested_alias_suffix,
        )?;
        let module_text = rewrite.text.as_deref().unwrap_or(module_text);
        // The transpiler annotated these; reading the marker back out of the
        // assembled text is what carries the list across the per-module file
        // boundary, and keeps the pin exactly in step with what was annotated.
        // Pinning a chunk's own state-mutating functions to the loader object
        // is the half of the guard that survives `CrossChunkCodeMotion`; the
        // `@noinline` half lives in `transpile::assigners`. Any chunk boundary
        // creates the hazard, so every chunk in a split plan carries the pin.
        let assigner_names = if resolved_chunks.len() > 1 {
            collect_annotated_assigner_names(module_text)
        } else {
            Vec::new()
        };
        let source_text = if chunk.name == base_chunk.name {
            render_bundler_runtime_base_chunk(&BundlerRuntimeBaseChunkInput {
                chunk_id: base_chunk_index,
                entry_points_json: &base_entry_points_json,
                manifest_json: &runtime_manifest_json,
                module_text,
                include_custom_elements_es5_adapter,
                runtime_debug,
                chunk_output_type,
                preamble_part: if runtime_core.is_some() {
                    RuntimePreamblePart::ManifestOnly
                } else {
                    RuntimePreamblePart::All
                },
                suffix: &rewrite.suffix,
                capabilities,
            })
        } else {
            render_bundler_runtime_lazy_chunk_with_alias_suffix(
                chunk_index,
                module_text,
                runtime_core_chunk_name
                    .as_deref()
                    .filter(|name| *name == chunk.name)
                    .and(runtime_core.as_deref()),
                &assigner_names,
                &rewrite.suffix,
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

    let mut helper_requirements =
        ClosureLibScanner::default().scan(input.explicit_js_inputs.iter())?;
    // Linked chunks are generated in memory and are not written until the job
    // executes. Observe them directly instead of reading their output paths.
    for asset in &generated_assets {
        helper_requirements.observe(&asset.text);
    }
    let closure_lib_files =
        select_bundler_runtime_closure_lib_files(&input.package_root, helper_requirements);
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
        assume_function_wrapper: true,
        chunk: Some(chunk_specs),
        chunk_output_type: chunk_output_type.is_esm().then(|| "ES_MODULES".to_string()),
        chunk_output_path_prefix: Some(format!(
            "{}{}",
            raw_dir.to_string_lossy(),
            std::path::MAIN_SEPARATOR
        )),
        compilation_level: input.compilation_level.clone(),
        dependency_mode: None,
        entry_point: None,
        externs: effective_externs,
        js: unique_paths(
            leading_js_inputs
                .iter()
                .cloned()
                .chain(closure_lib_files)
                .chain(chunk_sources)
                .collect(),
        ),
        js_output_file: None,
        language_in: "UNSTABLE".to_string(),
        language_out: input.language_out.clone(),
        property_renaming_report_path: property_renaming_report_path.clone(),
        // Hoisted module code is top level, so Closure prefixes every
        // cross-chunk survivor onto $gcc. Postprocess wraps each output chunk
        // in an IIFE that redeclares $gcc from globalThis, so direct
        // cross-chunk identifier references resolve through one shared object.
        // ES_MODULES gets real `import`/`export` edges instead, and Closure
        // rejects the flag outright in that mode.
        rename_prefix_namespace: (!chunk_output_type.is_esm())
            .then(|| BUNDLER_RUNTIME_PREFIX_NAMESPACE.to_string()),
        rewrite_polyfills: false,
        warning_level: warning_level.to_string(),
        has_type_metadata,
        type_metadata_counts,
    });

    for chunk in resolved_chunks {
        let internal_chunk_name = runtime_chunk_id_by_name
            .get(&chunk.name)
            .cloned()
            .ok_or_else(|| format!("Missing runtime chunk id for {}", chunk.name))?;
        let final_chunk_file_name =
            bundler_runtime_output_file_name(&chunk.name, &internal_chunk_name, &base_chunk.name);
        let output_path = raw_dir.join(format!("{}.js", internal_chunk_name));
        let final_output_path = PathBuf::from(&input.out_dir).join(final_chunk_file_name);
        postprocess_actions.push(PostprocessAction {
            input_path: output_path.to_string_lossy().to_string(),
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
            output_path: final_output_path.to_string_lossy().to_string(),
        });
        published_outputs.push(final_output_path.to_string_lossy().to_string());
    }

    Ok(PrepareClosureJobsOutput {
        bundler_runtime_base_input_path: runtime_chunk_id_by_name
            .get(&base_chunk.name)
            .map(|internal_chunk_name| raw_dir.join(format!("{internal_chunk_name}.js")))
            .map(|path| path.to_string_lossy().to_string()),
        compile_jobs,
        generated_assets,
        postprocess_actions,
        published_outputs,
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

struct RuntimeSourceRewrite {
    text: Option<String>,
    suffix: String,
}

fn rewrite_runtime_source(
    source_text: &str,
    runtime_module_index_by_id: &BTreeMap<String, usize>,
    runtime_debug: bool,
    requested_suffix: &str,
) -> Result<RuntimeSourceRewrite, String> {
    if runtime_debug && requested_suffix.is_empty() {
        return Ok(RuntimeSourceRewrite {
            text: None,
            suffix: String::new(),
        });
    }
    let allocator = Allocator::default();
    let program = parse_runtime_program(&allocator, source_text)?;
    let semantic = build_runtime_semantic(&program);

    let mut used_names = HashSet::<&str>::new();
    let mut param_call_ids = HashSet::<SymbolId>::new();
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::IdentifierReference(ident) if !requested_suffix.is_empty() => {
                used_names.insert(ident.name.as_str());
            }
            AstKind::BindingIdentifier(ident) if !requested_suffix.is_empty() => {
                used_names.insert(ident.name.as_str());
            }
            AstKind::LabelIdentifier(ident) if !requested_suffix.is_empty() => {
                used_names.insert(ident.name.as_str());
            }
            AstKind::CallExpression(call) if !runtime_debug => {
                let Expression::Identifier(callee) = &call.callee else {
                    continue;
                };
                if callee.name != "__register"
                    || runtime_reference_symbol(&semantic, callee)?.is_some()
                {
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
                // Registry factories receive require, exports, import, preload,
                // live. Only positions 0, 2, and 3 take a module ID.
                for index in [0, 2, 3] {
                    let Some(parameter) = params.items.get(index) else {
                        continue;
                    };
                    let BindingPattern::BindingIdentifier(binding) = &parameter.pattern else {
                        continue;
                    };
                    param_call_ids.insert(binding.symbol_id.get().ok_or_else(|| {
                        format!(
                            "Missing semantic binding for runtime parameter {}",
                            binding.name
                        )
                    })?);
                }
            }
            _ => {}
        }
    }

    let mut suffix = requested_suffix.to_string();
    if !requested_suffix.is_empty() {
        let mut counter = 1usize;
        while RUNTIME_ALIAS_DECL_NAMES
            .iter()
            .any(|name| used_names.contains(format!("{name}{suffix}").as_str()))
        {
            suffix = format!("{requested_suffix}_{counter}");
            counter += 1;
        }
    }

    // Both replacements use the original semantic identities and byte spans:
    // alias identifiers and module-ID literals are disjoint, even in one call.
    let mut edits = Vec::new();
    let mut errors = Vec::new();
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::IdentifierReference(ident)
                if !suffix.is_empty() && RUNTIME_ALIAS_NAMES.contains(&ident.name.as_str()) =>
            {
                // Facade parameters and authored bindings keep their spelling.
                if runtime_reference_symbol(&semantic, ident)?.is_none() {
                    edits.push((
                        ident.span.start as usize,
                        ident.span.end as usize,
                        format!("{}{suffix}", ident.name),
                    ));
                }
            }
            AstKind::CallExpression(call) if !runtime_debug => {
                let Expression::Identifier(callee) = &call.callee else {
                    continue;
                };
                if !is_runtime_call(&semantic, callee, &param_call_ids)? {
                    continue;
                }
                let Some(Expression::StringLiteral(module_id)) =
                    call.arguments.first().and_then(Argument::as_expression)
                else {
                    continue;
                };
                let Some(module_index) = runtime_module_index_by_id.get(module_id.value.as_str())
                else {
                    errors.push(format!("Missing module index for {}", module_id.value));
                    continue;
                };
                edits.push((
                    module_id.span.start as usize,
                    module_id.span.end as usize,
                    module_index.to_string(),
                ));
            }
            _ => {}
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(RuntimeSourceRewrite {
        text: if edits.is_empty() {
            None
        } else {
            Some(apply_runtime_source_edits(source_text, edits)?)
        },
        suffix,
    })
}

/// A runtime call is either a free helper or a facade parameter reference.
fn is_runtime_call(
    semantic: &Semantic<'_>,
    callee: &IdentifierReference<'_>,
    param_call_ids: &HashSet<SymbolId>,
) -> Result<bool, String> {
    Ok(match runtime_reference_symbol(semantic, callee)? {
        Some(symbol_id) => param_call_ids.contains(&symbol_id),
        None => RUNTIME_ALIAS_NAMES.contains(&callee.name.as_str()),
    })
}

/// A valid semantic reference can be unresolved; a missing reference is instead
/// an error because it cannot prove whether a runtime helper is authored.
fn runtime_reference_symbol(
    semantic: &Semantic<'_>,
    ident: &IdentifierReference<'_>,
) -> Result<Option<SymbolId>, String> {
    let reference_id = ident.reference_id.get().ok_or_else(|| {
        format!(
            "Missing semantic reference for runtime identifier {}",
            ident.name
        )
    })?;
    Ok(semantic.scoping().get_reference(reference_id).symbol_id())
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
/// the rewrite would silently find nothing.
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
    let mut previous_start = source_text.len();
    for (start, end, replacement) in edits.into_iter().rev() {
        if start > end
            || end > previous_start
            || !source_text.is_char_boundary(start)
            || !source_text.is_char_boundary(end)
        {
            return Err("Invalid bundler-runtime source edit span".to_string());
        }
        output.replace_range(start..end, &replacement);
        previous_start = start;
    }
    Ok(output)
}

#[cfg(test)]
mod identity_regressions {
    use std::collections::BTreeMap;

    use super::rewrite_runtime_source;

    #[test]
    fn runtime_text_rewrites_skip_literals_and_authored_bindings(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let source = concat!(
            "function __require(id){return id;}\n",
            "globalThis.label='__require';\n",
            "globalThis.local=__require(\"user-value\");\n",
            "__register(\"m0\",function(read,exports,load,preload,live){",
            "exports(\"authored\");live(\"authored\");",
            "function nested(read){return read(\"authored\");}",
            "load(\"m1\");preload(\"m1\");return read(\"m1\");});\n",
            "__register(\"m1\",(read,exports,load)=>load(\"m0\"));\n",
            "__dynamicImport(\"m1\");",
        );
        let rewritten = rewrite_runtime_source(
            source,
            &BTreeMap::from([("m0".to_string(), 0), ("m1".to_string(), 1)]),
            false,
            "_0",
        )?
        .text
        .ok_or("rewritten text")?;
        assert!(rewritten.contains("label='__require'"), "{rewritten}");
        assert!(
            rewritten.contains("__require(\"user-value\")"),
            "{rewritten}"
        );
        assert!(rewritten.contains("__register_0(0"), "{rewritten}");
        assert!(rewritten.contains("return read(1)"), "{rewritten}");
        assert!(rewritten.contains("load(1);preload(1)"), "{rewritten}");
        assert!(
            rewritten.contains("exports(\"authored\");live(\"authored\")"),
            "{rewritten}"
        );
        assert!(
            rewritten.contains("nested(read){return read(\"authored\");}"),
            "{rewritten}"
        );
        assert!(
            rewritten.contains("__register_0(1,(read,exports,load)=>load(0))"),
            "{rewritten}"
        );
        assert!(rewritten.contains("__dynamicImport_0(1)"), "{rewritten}");
        Ok(())
    }

    #[test]
    fn missing_generated_runtime_module_id_is_an_error() {
        assert!(rewrite_runtime_source(
            "__dynamicImport(\"missing\");",
            &BTreeMap::new(),
            false,
            "_0",
        )
        .is_err());
    }

    #[test]
    fn runtime_alias_plan_avoids_descendant_bindings() -> Result<(), Box<dyn std::error::Error>> {
        let source = concat!(
            "globalThis.label='__require';",
            "function use(__require_0){return __require_0;}",
            "const __runtime_0=1;",
            "__require(\"readable-module\");",
        );
        let rewritten = rewrite_runtime_source(source, &BTreeMap::new(), true, "_0")?;
        assert_eq!(rewritten.suffix, "_0_1");
        let code = rewritten.text.ok_or("rewritten text")?;
        assert!(code.contains("label='__require'"), "{code}");
        assert!(code.contains("function use(__require_0)"), "{code}");
        assert!(code.contains("const __runtime_0=1"), "{code}");
        assert!(
            code.contains("__require_0_1(\"readable-module\")"),
            "{code}"
        );
        Ok(())
    }
}
