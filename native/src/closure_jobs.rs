#![allow(non_snake_case)]

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde::Serialize;

use crate::pathing::{
    bundler_runtime_ids_are_readable, to_bundler_runtime_chunk_id, to_bundler_runtime_module_id,
    to_goog_module_id,
};

const BUNDLER_RUNTIME_GLOBAL: &str = "__g";

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureJobChunkPlanChunkInput {
    pub dependencies: Vec<String>,
    pub entryFiles: Option<Vec<String>>,
    pub files: Vec<String>,
    pub kind: Option<String>,
    pub lazyModuleIds: Option<Vec<String>>,
    pub name: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsInput {
    pub chunkMode: String,
    pub chunkLoader: String,
    pub chunkPlan: Vec<ClosureJobChunkPlanChunkInput>,
    pub compilationLevel: String,
    pub diagnosticsVerbose: bool,
    pub emittedOutDir: String,
    pub explicitExternPaths: Vec<String>,
    pub explicitJsInputs: Vec<String>,
    pub finalCacheDir: String,
    pub generatedExternPaths: Vec<String>,
    pub languageOut: String,
    pub manifestFile: String,
    pub nativeExternPath: String,
    pub outDir: String,
    pub packageRoot: String,
    pub publicPath: String,
    pub supportFiles: Vec<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct GeneratedAsset {
    pub path: String,
    pub text: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClosureCompileJob {
    pub assumeFunctionWrapper: bool,
    pub chunk: Option<Vec<String>>,
    pub chunkOutputPathPrefix: Option<String>,
    pub compilationLevel: String,
    pub dependencyMode: Option<String>,
    pub entryPoint: Option<Vec<String>>,
    pub externs: Vec<String>,
    pub js: Vec<String>,
    pub jsOutputFile: Option<String>,
    pub languageIn: String,
    pub languageOut: String,
    pub rewritePolyfills: bool,
    pub warningLevel: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PostprocessAction {
    pub inputPath: String,
    pub kind: String,
    pub outputPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PrepareClosureJobsOutput {
    pub compileJobs: Vec<ClosureCompileJob>,
    pub generatedAssets: Vec<GeneratedAsset>,
    pub postprocessActions: Vec<PostprocessAction>,
    pub publishedOutputs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChunkMode {
    BundlerRuntime,
    Off,
}

#[derive(Clone, Debug)]
struct ResolvedClosureChunk {
    dependencies: Vec<String>,
    entry_points: Vec<String>,
    files: Vec<String>,
    kind: Option<String>,
    name: String,
}

#[derive(Clone, Debug, Serialize)]
struct BundlerRuntimeManifest {
    baseChunk: String,
    chunks: BTreeMap<String, BundlerRuntimeManifestChunk>,
    loader: String,
    modules: BTreeMap<String, String>,
    publicPath: String,
}

#[derive(Clone, Debug, Serialize)]
struct BundlerRuntimeManifestChunk {
    deps: Vec<String>,
    modules: Vec<String>,
    url: String,
}

#[derive(Clone, Debug, Serialize)]
struct BundlerRuntimeInitManifest(
    usize,
    Vec<BundlerRuntimeInitChunk>,
    BTreeMap<String, usize>,
    String,
);

#[derive(Clone, Debug, Serialize)]
struct BundlerRuntimeInitChunk(Vec<usize>, String);

pub fn prepare_closure_jobs(
    input: PrepareClosureJobsInput,
) -> std::result::Result<PrepareClosureJobsOutput, String> {
    let chunk_mode = parse_chunk_mode(&input.chunkMode)?;
    let emitted_out_dir = PathBuf::from(&input.emittedOutDir);
    let final_cache_dir = PathBuf::from(&input.finalCacheDir);
    let raw_dir = final_cache_dir.join("raw");
    let runtime_asset_dir = final_cache_dir.join("bundler-runtime");
    let warning_level = if input.diagnosticsVerbose {
        "VERBOSE".to_string()
    } else {
        "QUIET".to_string()
    };
    let resolved_chunks = resolve_chunk_plan(&input.chunkPlan, &emitted_out_dir);

    match chunk_mode {
        ChunkMode::BundlerRuntime => prepare_bundler_runtime_jobs(
            &input,
            &resolved_chunks,
            &raw_dir,
            &runtime_asset_dir,
            &warning_level,
        ),
        ChunkMode::Off => prepare_off_mode_jobs(&input, &resolved_chunks, &raw_dir, &warning_level),
    }
}

fn parse_chunk_mode(value: &str) -> std::result::Result<ChunkMode, String> {
    match value {
        "bundler-runtime" => Ok(ChunkMode::BundlerRuntime),
        "off" => Ok(ChunkMode::Off),
        _ => Err(format!("Unsupported chunk mode: {value}")),
    }
}

fn prepare_bundler_runtime_jobs(
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

fn prepare_off_mode_jobs(
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

fn resolve_chunk_plan(
    chunk_plan: &[ClosureJobChunkPlanChunkInput],
    emitted_out_dir: &Path,
) -> Vec<ResolvedClosureChunk> {
    chunk_plan
        .iter()
        .map(|chunk| {
            let files = chunk
                .files
                .iter()
                .map(|file_path| to_emitted_js_path(emitted_out_dir, file_path))
                .collect::<Vec<_>>();
            let entry_points = if let Some(entry_files) = &chunk.entryFiles {
                entry_files
                    .iter()
                    .map(|file_path| {
                        to_goog_module_id(
                            &PathBuf::from(to_emitted_js_path(emitted_out_dir, file_path)),
                            emitted_out_dir,
                        )
                    })
                    .collect()
            } else if chunk
                .lazyModuleIds
                .as_ref()
                .map(|values| !values.is_empty())
                .unwrap_or(false)
            {
                chunk.lazyModuleIds.clone().unwrap_or_default()
            } else if let Some(last_file) = chunk.files.last() {
                vec![to_goog_module_id(
                    &PathBuf::from(to_emitted_js_path(emitted_out_dir, last_file)),
                    emitted_out_dir,
                )]
            } else {
                Vec::new()
            };

            ResolvedClosureChunk {
                dependencies: chunk.dependencies.clone(),
                entry_points,
                files,
                kind: chunk.kind.clone(),
                name: chunk.name.clone(),
            }
        })
        .collect()
}

fn to_emitted_js_path(emitted_out_dir: &Path, relative_file_path: &str) -> String {
    emitted_out_dir
        .join(relative_file_path)
        .with_extension("js")
        .to_string_lossy()
        .to_string()
}

fn collect_effective_extern_paths(
    package_root: &str,
    explicit_extern_paths: &[String],
    generated_extern_paths: &[String],
    native_extern_path: Option<&str>,
    runtime_extern_path: Option<&str>,
) -> std::result::Result<Vec<String>, String> {
    let mut ordered_paths = explicit_extern_paths.to_vec();
    ordered_paths.extend(collect_bundled_externs(package_root)?);
    ordered_paths.extend(generated_extern_paths.iter().cloned());
    if let Some(path) = native_extern_path {
        ordered_paths.push(path.to_string());
    }
    if let Some(path) = runtime_extern_path {
        ordered_paths.push(path.to_string());
    }

    let mut effective_paths = Vec::new();
    for file_path in unique_paths(ordered_paths) {
        if extern_file_has_declarations(&file_path)? {
            effective_paths.push(file_path);
        }
    }
    Ok(effective_paths)
}

fn collect_bundled_externs(package_root: &str) -> std::result::Result<Vec<String>, String> {
    let externs_dir = Path::new(package_root).join("closure-externs");
    let entries = match fs::read_dir(&externs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let mut files = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn extern_file_has_declarations(file_path: &str) -> std::result::Result<bool, String> {
    let source_text = match fs::read_to_string(file_path) {
        Ok(source_text) => source_text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };

    Ok(source_text.lines().map(|line| line.trim()).any(|line| {
        !line.is_empty()
            && line != "/** @externs */"
            && line != "*/"
            && !line.starts_with('*')
            && !line.starts_with("//")
    }))
}

fn select_closure_lib_files(
    package_root: &str,
    candidate_files: &[String],
) -> std::result::Result<Vec<String>, String> {
    let contents = read_candidate_contents(candidate_files)?;
    let closure_lib_dir = Path::new(package_root).join("closure-lib");
    let mut required = Vec::new();

    let needs_goog_base = contents.contains("goog.module(")
        || contents.contains("goog.require(")
        || contents.contains("goog.requireType(")
        || contents.contains("goog.provide(")
        || contents.contains("goog.reflect.");
    if needs_goog_base {
        required.push(
            closure_lib_dir
                .join("base.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if contents.contains("goog.reflect.") {
        required.push(
            closure_lib_dir
                .join("reflect.js")
                .to_string_lossy()
                .to_string(),
        );
    }
    if contents.contains("tslib") {
        let base_path = closure_lib_dir
            .join("base.js")
            .to_string_lossy()
            .to_string();
        if !required.contains(&base_path) {
            required.push(base_path);
        }
        required.push(
            closure_lib_dir
                .join("tslib.js")
                .to_string_lossy()
                .to_string(),
        );
    }

    Ok(unique_paths(required))
}

fn select_bundler_runtime_closure_lib_files(
    package_root: &str,
    candidate_files: &[String],
) -> std::result::Result<Vec<String>, String> {
    let contents = read_candidate_contents(candidate_files)?;
    if !contents.contains("goog.reflect.") {
        return Ok(Vec::new());
    }

    let closure_lib_dir = Path::new(package_root).join("closure-lib");
    Ok(vec![
        closure_lib_dir
            .join("base.js")
            .to_string_lossy()
            .to_string(),
        closure_lib_dir
            .join("reflect.js")
            .to_string_lossy()
            .to_string(),
    ])
}

fn read_candidate_contents(candidate_files: &[String]) -> std::result::Result<String, String> {
    let mut contents = String::new();
    for file_path in unique_paths(candidate_files.to_vec()) {
        match fs::read_to_string(&file_path) {
            Ok(source_text) => {
                contents.push_str(&source_text);
                contents.push('\n');
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(contents)
}

fn bundler_runtime_output_file_name(
    chunk_name: &str,
    runtime_chunk_id: &str,
    base_chunk_name: &str,
) -> String {
    if chunk_name == base_chunk_name {
        format!("{chunk_name}.js")
    } else {
        format!("{runtime_chunk_id}.js")
    }
}

fn render_bundler_runtime_base_chunk(
    chunk_id: usize,
    entry_points: &[String],
    loader: &str,
    manifest: &BundlerRuntimeInitManifest,
    module_text: &str,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    Ok([
        render_bundler_runtime_preamble(loader, manifest, debug_runtime)?,
        "var __register=globalThis.__g.r;".to_string(),
        module_text.to_string(),
        format!(
            "globalThis.{runtime_key}.l({chunk_id:?});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL
        ),
        format!(
            "globalThis.{runtime_key}.n({entry_points});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL,
            entry_points = serde_json::to_string(entry_points).map_err(|error| error.to_string())?,
        ),
        String::new(),
    ]
    .join("\n"))
}

fn render_bundler_runtime_lazy_chunk(
    chunk_id: usize,
    module_text: &str,
    debug_runtime: bool,
) -> String {
    [
        "(function(g){".to_string(),
        if debug_runtime {
            "if(!g)throw Error(\"base chunk missing\");".to_string()
        } else {
            "if(!g)throw Error(\"b\");".to_string()
        },
        "var __register=g.r;".to_string(),
        module_text.to_string(),
        format!("g.l({chunk_id:?});"),
        format!(
            "}}).call(this,globalThis.{runtime_key});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL
        ),
        String::new(),
    ]
    .join("\n")
}

fn render_bundler_runtime_preamble(
    loader: &str,
    manifest: &BundlerRuntimeInitManifest,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    let manifest_json = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
    let loader_code = match loader {
        "script" => 1,
        "fetch" => 2,
        _ => 0,
    };
    let missing_chunk_error = if debug_runtime {
        "\"unknown chunk \"+a"
    } else {
        "\"c\"+a"
    };
    let missing_module_error = if debug_runtime {
        "\"unknown module \"+a"
    } else {
        "\"m\"+a"
    };
    let script_error = if debug_runtime {
        "\"load \"+a+\" failed\""
    } else {
        "\"l\"+a"
    };
    let fetch_error = if debug_runtime {
        "\"fetch \"+a+\" failed (\"+c.status+\")\""
    } else {
        "\"f\"+a"
    };
    let fetch_eval = if debug_runtime {
        "(0,global.eval)(c+\"\\n//# sourceURL=\"+b);"
    } else {
        "(0,global.eval)(c);"
    };
    Ok([
        "(function(global){".to_string(),
        format!("var r=global.{BUNDLER_RUNTIME_GLOBAL}||(global.{BUNDLER_RUNTIME_GLOBAL}={{}});"),
        "if(!r.i){".to_string(),
        "r.f=Object.create(null);".to_string(),
        "r.c=Object.create(null);".to_string(),
        "r.s=Object.create(null);".to_string(),
        "r.d=Object.create(null);".to_string(),
        "r.b=\"\";".to_string(),
        "r.o=0;".to_string(),
        "r.k=null;".to_string(),
        "r.m=null;".to_string(),
        format!("function u(a){{var b=r.k&&r.k[a];if(!b)throw Error({missing_chunk_error});return new URL(b[1],r.b||(global.location&&global.location.href?global.location.href:\"./\")).toString();}}"),
        "function g(a){var b=r.d[a];if(b)return b;b={};b.p=new Promise(function(c,d){b.r=c;b.j=d});r.d[a]=b;return b;}".to_string(),
        "r.l=function(a){r.s[a]=1;var b=r.d[a];if(b){b.r();delete r.d[a];}};".to_string(),
        "function h(a,b){r.s[a]=2;var c=r.d[a];if(c){c.j(b);delete r.d[a];}}".to_string(),
        "r.r=function(a,b,c){r.f[a]=c;};".to_string(),
        format!("r.q=function(a){{if(Object.prototype.hasOwnProperty.call(r.c,a))return r.c[a];var b=r.f[a];if(!b)throw Error({missing_module_error});var c=[];r.c[a]=c;b(r.q,c,r.j,r.x);return c;}};"),
        format!("function p(a,b){{return new Promise(function(c,d){{var e=global.document.createElement(\"script\");e.async=true;e.src=b;e.onload=function(){{c();}};e.onerror=function(){{d(Error({script_error}));}};(global.document.head||global.document.documentElement).appendChild(e);}});}}"),
        format!("function w(a,b){{return Promise.resolve(global.fetch(b)).then(function(c){{if(!c.ok)throw Error({fetch_error});return c.text();}}).then(function(c){{{fetch_eval}}});}}"),
        "function t(){return r.o===1?1:r.o===2?2:global.document?1:2;}".to_string(),
        format!("function e(a){{var b=r.s[a];if(b===1)return Promise.resolve();if(b===0)return g(a).p;var c=r.k&&r.k[a];if(!c)throw Error({missing_chunk_error});r.s[a]=0;var d=g(a),f=t();return Promise.all((c[0]||[]).map(function(j){{return e(j);}})).then(function(){{var j=u(a);return f===2?w(a,j):p(a,j);}}).then(function(){{return d.p;}}).catch(function(j){{h(a,j);throw j;}});}}"),
        format!("r.j=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{return r.q(a);}});}};"),
        format!("r.x=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{}});}};"),
        "r.n=function(a){for(var b=0;b<a.length;b+=1)r.q(a[b]);};".to_string(),
        "r.a=function(a,b){r.k=a[1];r.m=a[2];r.o=b;var c=global.document&&global.document.currentScript&&global.document.currentScript.src?global.document.currentScript.src:(global.location&&global.location.href?global.location.href:\"./\");r.b=new URL(a[3]||\"./\",c).toString();r.s[a[0]]=1;};".to_string(),
        "r.i=1;".to_string(),
        "}".to_string(),
        format!("r.a({manifest_json},{loader_code});"),
        "}).call(this,globalThis);".to_string(),
        String::new(),
    ]
    .join("\n"))
}

fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            result.push(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prepares_bundler_runtime_jobs_with_runtime_assets() {
        let root = make_temp_dir("bundler-runtime-jobs");
        let emitted_out_dir = root.join("native-out");
        let out_dir = root.join("dist");
        let final_cache_dir = root.join("cache/final");
        let package_root = root.join("pkg");
        fs::create_dir_all(&emitted_out_dir).unwrap();
        fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
        fs::create_dir_all(&out_dir).unwrap();
        fs::create_dir_all(package_root.join("closure-externs")).unwrap();
        fs::create_dir_all(package_root.join("closure-lib")).unwrap();
        fs::write(
            emitted_out_dir.join("src/main.js"),
            "__exports[\"boot\"]=boot;\n",
        )
        .unwrap();
        fs::write(
            emitted_out_dir.join("src/feature.js"),
            "__exports[\"renderMessage\"]=renderMessage;\n",
        )
        .unwrap();
        fs::write(
            package_root.join("closure-externs/runtime.js"),
            "/** @externs */\nWindow.prototype.external;\n",
        )
        .unwrap();
        fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
        fs::write(package_root.join("closure-lib/reflect.js"), "").unwrap();
        let native_extern = root.join("native.externs.js");
        fs::write(
            &native_extern,
            "/** @externs */\nWindow.prototype.nativeKeep;\n",
        )
        .unwrap();

        let output = prepare_closure_jobs(PrepareClosureJobsInput {
            chunkMode: "bundler-runtime".to_string(),
            chunkLoader: "script".to_string(),
            chunkPlan: vec![
                ClosureJobChunkPlanChunkInput {
                    dependencies: vec![],
                    entryFiles: Some(vec!["src/main.ts".to_string()]),
                    files: vec!["src/main.ts".to_string()],
                    kind: Some("base".to_string()),
                    lazyModuleIds: None,
                    name: "main".to_string(),
                },
                ClosureJobChunkPlanChunkInput {
                    dependencies: vec!["main".to_string()],
                    entryFiles: None,
                    files: vec!["src/feature.ts".to_string()],
                    kind: Some("lazy".to_string()),
                    lazyModuleIds: Some(vec!["gcc.src.feature".to_string()]),
                    name: "src-feature-lazy".to_string(),
                },
            ],
            compilationLevel: "ADVANCED".to_string(),
            diagnosticsVerbose: false,
            emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
            explicitExternPaths: vec![],
            explicitJsInputs: vec![],
            finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
            generatedExternPaths: vec![],
            languageOut: "ECMASCRIPT_NEXT".to_string(),
            manifestFile: "chunk-map.json".to_string(),
            nativeExternPath: native_extern.to_string_lossy().to_string(),
            outDir: out_dir.to_string_lossy().to_string(),
            packageRoot: package_root.to_string_lossy().to_string(),
            publicPath: "./".to_string(),
            supportFiles: vec![],
        })
        .unwrap();

        assert_eq!(output.compileJobs.len(), 1);
        assert_eq!(output.postprocessActions.len(), 2);
        assert!(output
            .publishedOutputs
            .iter()
            .any(|path| path.ends_with("chunk-map.json")));
        assert!(output.generatedAssets.iter().any(|asset| {
            asset.path.ends_with("chunk-map.json")
                && asset.text.contains("\"baseChunk\": \"c")
                && asset.text.contains("\"modules\": [")
        }));
        assert!(output.generatedAssets.iter().any(|asset| {
            asset.path.ends_with("main.linked.js")
                && !asset.text.contains("__gcc_runtime__")
                && !asset.text.contains("initialized")
                && asset.text.contains("globalThis.__g.l(")
        }));
        assert!(output.compileJobs[0].chunk.is_some());
        assert!(!output.compileJobs[0]
            .externs
            .iter()
            .any(|file| file.ends_with("runtime-shared.externs.js")));
    }

    #[test]
    fn prepares_off_mode_jobs_and_filters_empty_externs() {
        let root = make_temp_dir("off-jobs");
        let emitted_out_dir = root.join("native-out");
        let out_dir = root.join("dist");
        let final_cache_dir = root.join("cache/final");
        let package_root = root.join("pkg");
        fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
        fs::create_dir_all(&out_dir).unwrap();
        fs::create_dir_all(package_root.join("closure-lib")).unwrap();
        fs::write(
            emitted_out_dir.join("src/shared.js"),
            "goog.module(\"gcc.src.shared\");\nexports.shared = 1;\n",
        )
        .unwrap();
        fs::write(
            emitted_out_dir.join("src/entry-a.js"),
            "goog.module(\"gcc.src.entry_a\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",
        )
        .unwrap();
        fs::write(
            emitted_out_dir.join("src/entry-b.js"),
            "goog.module(\"gcc.src.entry_b\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",
        )
        .unwrap();
        fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
        let empty_extern = root.join("empty.externs.js");
        let real_extern = root.join("real.externs.js");
        let native_extern = root.join("native.externs.js");
        fs::write(&empty_extern, "/** @externs */\n").unwrap();
        fs::write(
            &real_extern,
            "/** @externs */\nWindow.prototype.userKeep;\n",
        )
        .unwrap();
        fs::write(
            &native_extern,
            "/** @externs */\nWindow.prototype.nativeKeep;\n",
        )
        .unwrap();

        let output = prepare_closure_jobs(PrepareClosureJobsInput {
            chunkMode: "off".to_string(),
            chunkLoader: "auto".to_string(),
            chunkPlan: vec![
                ClosureJobChunkPlanChunkInput {
                    dependencies: vec![],
                    entryFiles: None,
                    files: vec!["src/shared.ts".to_string()],
                    kind: None,
                    lazyModuleIds: None,
                    name: "shared".to_string(),
                },
                ClosureJobChunkPlanChunkInput {
                    dependencies: vec!["shared".to_string()],
                    entryFiles: None,
                    files: vec!["src/entry-a.ts".to_string()],
                    kind: None,
                    lazyModuleIds: None,
                    name: "entry-a".to_string(),
                },
                ClosureJobChunkPlanChunkInput {
                    dependencies: vec!["shared".to_string()],
                    entryFiles: None,
                    files: vec!["src/entry-b.ts".to_string()],
                    kind: None,
                    lazyModuleIds: None,
                    name: "entry-b".to_string(),
                },
            ],
            compilationLevel: "ADVANCED".to_string(),
            diagnosticsVerbose: true,
            emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
            explicitExternPaths: vec![
                empty_extern.to_string_lossy().to_string(),
                real_extern.to_string_lossy().to_string(),
            ],
            explicitJsInputs: vec![],
            finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
            generatedExternPaths: vec![],
            languageOut: "ECMASCRIPT_NEXT".to_string(),
            manifestFile: "".to_string(),
            nativeExternPath: native_extern.to_string_lossy().to_string(),
            outDir: out_dir.to_string_lossy().to_string(),
            packageRoot: package_root.to_string_lossy().to_string(),
            publicPath: "./".to_string(),
            supportFiles: vec![],
        })
        .unwrap();

        assert_eq!(output.compileJobs.len(), 1);
        assert!(output.compileJobs[0].chunk.is_some());
        assert!(!output.compileJobs[0]
            .externs
            .iter()
            .any(|path| path == &empty_extern.to_string_lossy()));
        assert!(output.compileJobs[0]
            .externs
            .iter()
            .any(|path| path == &real_extern.to_string_lossy()));
        assert_eq!(output.postprocessActions.len(), 3);
        assert!(output
            .postprocessActions
            .iter()
            .all(|action| action.kind == "rewrite-gcc-exports"));
    }
}
