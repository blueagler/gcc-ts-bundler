#![allow(non_snake_case)]

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use regex::Regex;
use serde::Serialize;

use crate::pathing::to_goog_module_id;

const BUNDLER_RUNTIME_GLOBAL: &str = "__gcc_runtime__";

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
        ChunkMode::Off => prepare_off_mode_jobs(
            &input,
            &resolved_chunks,
            &raw_dir,
            &warning_level,
        ),
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
    let mut module_map = BTreeMap::new();
    let mut manifest_chunks = BTreeMap::new();
    let mut export_names_by_chunk = BTreeMap::<String, BTreeSet<String>>::new();
    let mut module_text_by_chunk = BTreeMap::new();

    for chunk in resolved_chunks {
        let mut module_sources = Vec::with_capacity(chunk.files.len());
        let mut manifest_modules = Vec::with_capacity(chunk.files.len());
        let mut chunk_export_names = BTreeSet::new();
        for file_path in &chunk.files {
            let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
            chunk_export_names.extend(collect_bundler_runtime_export_names(&source_text));
            module_sources.push(source_text);
            let module_id = to_goog_module_id(Path::new(file_path), Path::new(&input.emittedOutDir));
            manifest_modules.push(module_id.clone());
            module_map.insert(module_id, chunk.name.clone());
        }
        manifest_chunks.insert(
            chunk.name.clone(),
            BundlerRuntimeManifestChunk {
                deps: chunk.dependencies.clone(),
                modules: manifest_modules,
                url: format!("{}{}.js", input.publicPath, chunk.name),
            },
        );
        export_names_by_chunk.insert(chunk.name.clone(), chunk_export_names);
        module_text_by_chunk.insert(chunk.name.clone(), module_sources.join("\n"));
    }

    let manifest = BundlerRuntimeManifest {
        baseChunk: base_chunk.name.clone(),
        chunks: manifest_chunks,
        loader: input.chunkLoader.clone(),
        modules: module_map,
        publicPath: input.publicPath.clone(),
    };

    let runtime_externs_path = runtime_asset_dir.join("runtime-shared.externs.js");
    let runtime_externs_path_string = runtime_externs_path.to_string_lossy().to_string();
    let runtime_externs_text = render_shared_bundler_runtime_externs();
    generated_assets.push(GeneratedAsset {
        path: runtime_externs_path_string.clone(),
        text: runtime_externs_text.clone(),
    });

    let mut effective_externs = collect_effective_extern_paths(
        &input.packageRoot,
        &input.explicitExternPaths,
        &input.generatedExternPaths,
        Some(&input.nativeExternPath),
        None,
    )?;
    if extern_text_has_declarations(&runtime_externs_text) {
        effective_externs.push(runtime_externs_path_string.clone());
    }
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
    let mut linked_chunk_text_by_name = BTreeMap::new();
    for chunk in resolved_chunks {
        let module_text = module_text_by_chunk
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source for {}", chunk.name))?;
        let source_text = if chunk.name == base_chunk.name {
            render_bundler_runtime_base_chunk(
                &chunk.name,
                &chunk.entry_points,
                &input.chunkLoader,
                &manifest,
                module_text,
            )?
        } else {
            render_bundler_runtime_lazy_chunk(&chunk.name, module_text)
        };
        let source_path = runtime_asset_dir.join(format!("{}.linked.js", chunk.name));
        generated_assets.push(GeneratedAsset {
            path: source_path.to_string_lossy().to_string(),
            text: source_text.clone(),
        });
        linked_chunk_text_by_name.insert(chunk.name.clone(), source_text);
        linked_chunk_paths.push((chunk.name.clone(), source_path));
    }

    for chunk in resolved_chunks {
        let chunk_export_externs_path = runtime_asset_dir.join(format!("{}.exports.externs.js", chunk.name));
        let chunk_export_names = export_names_by_chunk
            .get(&chunk.name)
            .cloned()
            .unwrap_or_default();
        let chunk_export_externs_text = render_chunk_export_externs(&chunk_export_names);
        generated_assets.push(GeneratedAsset {
            path: chunk_export_externs_path.to_string_lossy().to_string(),
            text: chunk_export_externs_text.clone(),
        });
    }

    let mut chunk_export_extern_paths = BTreeMap::<String, Option<String>>::new();
    for chunk in resolved_chunks {
        let chunk_export_externs_path = runtime_asset_dir.join(format!("{}.exports.externs.js", chunk.name));
        let chunk_export_names = export_names_by_chunk
            .get(&chunk.name)
            .cloned()
            .unwrap_or_default();
        let chunk_export_externs_text = render_chunk_export_externs(&chunk_export_names);
        let chunk_export_externs_path_string =
            chunk_export_externs_path.to_string_lossy().to_string();
        chunk_export_extern_paths.insert(
            chunk.name.clone(),
            extern_text_has_declarations(&chunk_export_externs_text)
                .then_some(chunk_export_externs_path_string),
        );
    }

    for chunk in resolved_chunks {
        let (_, linked_source_path) = linked_chunk_paths
            .iter()
            .find(|(chunk_name, _)| chunk_name == &chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source for {}", chunk.name))?;
        let extra_js = if chunk.kind.as_deref() == Some("base") {
            input.explicitJsInputs.clone()
        } else {
            Vec::new()
        };
        let closure_lib_files = select_bundler_runtime_closure_lib_files(
            &input.packageRoot,
            &unique_paths(
                extra_js
                    .iter()
                    .cloned()
                    .chain(std::iter::once(linked_source_path.to_string_lossy().to_string()))
                    .collect(),
            ),
        )?;
        let mut chunk_externs = effective_externs.clone();
        if let Some(Some(export_extern_path)) = chunk_export_extern_paths.get(&chunk.name) {
            chunk_externs.push(export_extern_path.clone());
        }
        let linked_source_text = linked_chunk_text_by_name
            .get(&chunk.name)
            .ok_or_else(|| format!("Missing linked chunk source text for {}", chunk.name))?;
        for imported_module_id in collect_dynamic_import_module_ids(&linked_source_text) {
            let Some(target_chunk_name) = manifest.modules.get(&imported_module_id) else {
                continue;
            };
            let Some(Some(export_extern_path)) = chunk_export_extern_paths.get(target_chunk_name) else {
                continue;
            };
            chunk_externs.push(export_extern_path.clone());
        }
        chunk_externs = unique_paths(chunk_externs);
        let output_path = raw_dir.join(format!("{}.js", chunk.name));
        compile_jobs.push(ClosureCompileJob {
            assumeFunctionWrapper: true,
            chunk: None,
            chunkOutputPathPrefix: None,
            compilationLevel: input.compilationLevel.clone(),
            dependencyMode: None,
            entryPoint: None,
            externs: chunk_externs,
            js: unique_paths(
                extra_js
                    .into_iter()
                    .chain(closure_lib_files.into_iter())
                    .chain(std::iter::once(linked_source_path.to_string_lossy().to_string()))
                    .collect(),
            ),
            jsOutputFile: Some(output_path.to_string_lossy().to_string()),
            languageIn: "UNSTABLE".to_string(),
            languageOut: input.languageOut.clone(),
            rewritePolyfills: false,
            warningLevel: warning_level.to_string(),
        });

        let final_output_path = PathBuf::from(&input.outDir).join(format!("{}.js", chunk.name));
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
                .chain(resolved_chunks.iter().flat_map(|chunk| chunk.files.iter().cloned()))
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
            entryPoint: (!entry_chunk.entry_points.is_empty()).then_some(entry_chunk.entry_points.clone()),
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
                    unique_paths(chunk.files.clone()).len() + if index == 0 { leading_js.len() } else { 0 },
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
            chunkOutputPathPrefix: Some(format!("{}{}", raw_dir.to_string_lossy(), std::path::MAIN_SEPARATOR)),
            compilationLevel: input.compilationLevel.clone(),
            dependencyMode: Some("PRUNE".to_string()),
            entryPoint: (!entry_points.is_empty()).then_some(entry_points),
            externs,
            js: unique_paths(
                leading_js
                    .into_iter()
                    .chain(resolved_chunks.iter().flat_map(|chunk| chunk.files.iter().cloned()))
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

    Ok(source_text
        .lines()
        .map(|line| line.trim())
        .any(|line| {
            !line.is_empty()
                && line != "/** @externs */"
                && line != "*/"
                && !line.starts_with('*')
                && !line.starts_with("//")
        }))
}

fn extern_text_has_declarations(source_text: &str) -> bool {
    source_text
        .lines()
        .map(|line| line.trim())
        .any(|line| {
            !line.is_empty()
                && line != "/** @externs */"
                && line != "*/"
                && !line.starts_with('*')
                && !line.starts_with("//")
        })
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
        required.push(closure_lib_dir.join("base.js").to_string_lossy().to_string());
    }
    if contents.contains("goog.reflect.") {
        required.push(closure_lib_dir.join("reflect.js").to_string_lossy().to_string());
    }
    if contents.contains("tslib") {
        let base_path = closure_lib_dir.join("base.js").to_string_lossy().to_string();
        if !required.contains(&base_path) {
            required.push(base_path);
        }
        required.push(closure_lib_dir.join("tslib.js").to_string_lossy().to_string());
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
        closure_lib_dir.join("base.js").to_string_lossy().to_string(),
        closure_lib_dir.join("reflect.js").to_string_lossy().to_string(),
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

fn collect_bundler_runtime_export_names(source_text: &str) -> BTreeSet<String> {
    let mut export_names = BTreeSet::new();
    for regex in [
        Regex::new(r#"__exports\["([^"]+)"\]\s*="#).expect("valid double-quote regex"),
        Regex::new(r#"__exports\['([^']+)'\]\s*="#).expect("valid single-quote regex"),
    ] {
        for captures in regex.captures_iter(source_text) {
            let Some(name) = captures.get(1) else {
                continue;
            };
            export_names.insert(name.as_str().to_string());
        }
    }
    export_names
}

fn collect_dynamic_import_module_ids(source_text: &str) -> BTreeSet<String> {
    let mut module_ids = BTreeSet::new();
    for regex in [
        Regex::new(r#"__dynamicImport\(\s*["']([^"']+)["']\s*\)"#)
            .expect("valid dynamic import regex"),
        Regex::new(r#"__preloadDynamicImport\(\s*["']([^"']+)["']\s*\)"#)
            .expect("valid preload dynamic import regex"),
    ] {
        for captures in regex.captures_iter(source_text) {
            let Some(module_id) = captures.get(1) else {
                continue;
            };
            module_ids.insert(module_id.as_str().to_string());
        }
    }
    module_ids
}

fn render_shared_bundler_runtime_externs() -> String {
    let mut lines = vec![
        "/** @externs */".to_string(),
        format!("Window.prototype.{BUNDLER_RUNTIME_GLOBAL};"),
        format!("WorkerGlobalScope.prototype.{BUNDLER_RUNTIME_GLOBAL};"),
        "Object.prototype.markChunkFailed;".to_string(),
        "Object.prototype.markChunkLoaded;".to_string(),
        "Object.prototype.preloadDynamicImport;".to_string(),
        "Object.prototype.registerModule;".to_string(),
        "Object.prototype.require;".to_string(),
        "Object.prototype.runEntries;".to_string(),
        String::new(),
    ];
    lines.push(String::new());
    lines.join("\n")
}

fn render_chunk_export_externs(export_names: &BTreeSet<String>) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    for export_name in export_names {
        if is_valid_js_identifier(export_name) {
            lines.push(format!("Object.prototype.{export_name};"));
        } else {
            lines.push(format!("Object.prototype[{export_name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn render_bundler_runtime_base_chunk(
    chunk_id: &str,
    entry_points: &[String],
    loader: &str,
    manifest: &BundlerRuntimeManifest,
    module_text: &str,
) -> std::result::Result<String, String> {
    Ok([
        render_bundler_runtime_preamble(loader, manifest)?,
        module_text.to_string(),
        format!(
            "globalThis[{runtime_key:?}][\"markChunkLoaded\"]({chunk_id:?});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL
        ),
        format!(
            "globalThis[{runtime_key:?}][\"runEntries\"]({entry_points});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL,
            entry_points = serde_json::to_string(entry_points).map_err(|error| error.to_string())?,
        ),
        String::new(),
    ]
    .join("\n"))
}

fn render_bundler_runtime_lazy_chunk(chunk_id: &str, module_text: &str) -> String {
    [
        "(function(__gcc_runtime){".to_string(),
        "if(!__gcc_runtime)throw new Error(\"bundler-runtime base chunk must load before lazy chunks.\");"
            .to_string(),
        module_text.to_string(),
        format!("__gcc_runtime[\"markChunkLoaded\"]({chunk_id:?});"),
        format!("}}).call(this,globalThis[{runtime_key:?}]);", runtime_key = BUNDLER_RUNTIME_GLOBAL),
        String::new(),
    ]
    .join("\n")
}

fn render_bundler_runtime_preamble(
    loader: &str,
    manifest: &BundlerRuntimeManifest,
) -> std::result::Result<String, String> {
    let manifest_json = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
    Ok([
        "(function(global){".to_string(),
        format!("var runtimeKey={BUNDLER_RUNTIME_GLOBAL:?};"),
        "var runtime=global[runtimeKey]||(global[runtimeKey]={});".to_string(),
        "if(!runtime[\"initialized\"]){".to_string(),
        "runtime[\"manifest\"]=null;".to_string(),
        "runtime[\"factories\"]=Object.create(null);".to_string(),
        "runtime[\"cache\"]=Object.create(null);".to_string(),
        "runtime[\"chunkStates\"]=Object.create(null);".to_string(),
        "runtime[\"chunkDeferreds\"]=Object.create(null);".to_string(),
        "runtime[\"baseUrl\"]=\"\";".to_string(),
        "runtime[\"loaderMode\"]=\"auto\";".to_string(),
        "runtime[\"resolveChunkUrl\"]=function(chunkId){var manifest=runtime[\"manifest\"];var chunk=manifest&&manifest[\"chunks\"]&&manifest[\"chunks\"][chunkId];if(!chunk)throw new Error(\"Unknown chunk \" + chunkId);return new URL(chunk[\"url\"], runtime[\"baseUrl\"] || (global.location && global.location.href ? global.location.href : \"./\")).toString();};".to_string(),
        "runtime[\"getDeferred\"]=function(chunkId){var existing=runtime[\"chunkDeferreds\"][chunkId];if(existing)return existing;var deferred={};deferred[\"promise\"]=new Promise(function(resolve,reject){deferred[\"resolve\"]=resolve;deferred[\"reject\"]=reject;});runtime[\"chunkDeferreds\"][chunkId]=deferred;return deferred;};".to_string(),
        "runtime[\"markChunkLoaded\"]=function(chunkId){runtime[\"chunkStates\"][chunkId]=\"loaded\";var deferred=runtime[\"chunkDeferreds\"][chunkId];if(deferred){deferred[\"resolve\"]();delete runtime[\"chunkDeferreds\"][chunkId];}};".to_string(),
        "runtime[\"markChunkFailed\"]=function(chunkId,error){runtime[\"chunkStates\"][chunkId]=\"failed\";var deferred=runtime[\"chunkDeferreds\"][chunkId];if(deferred){deferred[\"reject\"](error);delete runtime[\"chunkDeferreds\"][chunkId];}};".to_string(),
        "runtime[\"registerModule\"]=function(moduleId,_deps,factory){runtime[\"factories\"][moduleId]=factory;};".to_string(),
        "runtime[\"require\"]=function(moduleId){if(Object.prototype.hasOwnProperty.call(runtime[\"cache\"],moduleId))return runtime[\"cache\"][moduleId];var factory=runtime[\"factories\"][moduleId];if(!factory)throw new Error(\"Module not registered: \" + moduleId);var exports={};runtime[\"cache\"][moduleId]=exports;factory(runtime[\"require\"], exports, runtime[\"dynamicImport\"], runtime[\"preloadDynamicImport\"]);return exports;};".to_string(),
        "runtime[\"loadWithScript\"]=function(chunkId,url){return new Promise(function(resolve,reject){var script=global.document.createElement(\"script\");script.async=true;script.src=url;script.onload=function(){resolve();};script.onerror=function(){reject(new Error(\"Failed to load chunk \" + chunkId));};(global.document.head||global.document.documentElement).appendChild(script);});};".to_string(),
        "runtime[\"loadWithFetch\"]=function(chunkId,url){return Promise.resolve(global.fetch(url)).then(function(response){if(!response.ok)throw new Error(\"Failed to fetch chunk \" + chunkId + \" (\" + response.status + \")\");return response.text();}).then(function(source){(0, global.eval)(source + \"\\n//# sourceURL=\" + url);});};".to_string(),
        "runtime[\"selectLoader\"]=function(){if(runtime[\"loaderMode\"]!==\"auto\")return runtime[\"loaderMode\"];return global.document ? \"script\" : \"fetch\";};".to_string(),
        "runtime[\"ensureChunk\"]=function(chunkId){var state=runtime[\"chunkStates\"][chunkId];if(state===\"loaded\")return Promise.resolve();if(state===\"loading\"){return runtime[\"getDeferred\"](chunkId)[\"promise\"];}var manifest=runtime[\"manifest\"];var chunk=manifest&&manifest[\"chunks\"]&&manifest[\"chunks\"][chunkId];if(!chunk)throw new Error(\"Unknown chunk \" + chunkId);runtime[\"chunkStates\"][chunkId]=\"loading\";var deferred=runtime[\"getDeferred\"](chunkId);var loader=runtime[\"selectLoader\"]();return Promise.all((chunk[\"deps\"]||[]).map(function(depId){return runtime[\"ensureChunk\"](depId);})).then(function(){var url=runtime[\"resolveChunkUrl\"](chunkId);return loader===\"fetch\"?runtime[\"loadWithFetch\"](chunkId,url):runtime[\"loadWithScript\"](chunkId,url);}).then(function(){return deferred[\"promise\"];}).catch(function(error){runtime[\"markChunkFailed\"](chunkId,error);throw error;});};".to_string(),
        "runtime[\"dynamicImport\"]=function(moduleId){var manifest=runtime[\"manifest\"];var chunkId=manifest&&manifest[\"modules\"]&&manifest[\"modules\"][moduleId];if(!chunkId)throw new Error(\"Unknown module \" + moduleId);return runtime[\"ensureChunk\"](chunkId).then(function(){return runtime[\"require\"](moduleId);});};".to_string(),
        "runtime[\"preloadDynamicImport\"]=function(moduleId){var manifest=runtime[\"manifest\"];var chunkId=manifest&&manifest[\"modules\"]&&manifest[\"modules\"][moduleId];if(!chunkId)throw new Error(\"Unknown module \" + moduleId);return runtime[\"ensureChunk\"](chunkId).then(function(){});};".to_string(),
        "runtime[\"runEntries\"]=function(entryIds){for(var index=0;index<entryIds.length;index+=1)runtime[\"require\"](entryIds[index]);};".to_string(),
        "runtime[\"init\"]=function(manifest, loaderMode){runtime[\"manifest\"]=manifest;runtime[\"loaderMode\"]=loaderMode||runtime[\"loaderMode\"];var currentScript=global.document&&global.document.currentScript&&global.document.currentScript.src?global.document.currentScript.src:(global.location&&global.location.href?global.location.href:\"./\");runtime[\"baseUrl\"]=new URL(manifest[\"publicPath\"]||\"./\", currentScript).toString();runtime[\"chunkStates\"][manifest[\"baseChunk\"]]=\"loaded\";};".to_string(),
        "runtime[\"initialized\"]=true;".to_string(),
        "}".to_string(),
        format!("runtime[\"init\"]({manifest_json}, {loader:?});"),
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

fn is_valid_js_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
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
        fs::write(emitted_out_dir.join("src/main.js"), "__exports[\"boot\"]=boot;\n").unwrap();
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
        fs::write(&native_extern, "/** @externs */\nWindow.prototype.nativeKeep;\n").unwrap();

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

        assert_eq!(output.compileJobs.len(), 2);
        assert_eq!(output.postprocessActions.len(), 2);
        assert!(output
        .publishedOutputs
        .iter()
        .any(|path| path.ends_with("chunk-map.json")));
        assert!(output.generatedAssets.iter().any(|asset| {
            asset.path.ends_with("runtime-shared.externs.js")
                && asset.text.contains("Object.prototype.require;")
        }));
        assert!(output.generatedAssets.iter().any(|asset| {
            asset.path.ends_with("src-feature-lazy.exports.externs.js")
                && asset.text.contains("renderMessage")
        }));
        assert!(output.generatedAssets.iter().any(|asset| {
            asset.path.ends_with("chunk-map.json") && asset.text.contains("\"baseChunk\": \"main\"")
        }));
        assert!(output
            .compileJobs
            .iter()
            .all(|job| job.externs.iter().any(|file| file.ends_with("runtime-shared.externs.js"))));
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
        fs::write(&real_extern, "/** @externs */\nWindow.prototype.userKeep;\n").unwrap();
        fs::write(&native_extern, "/** @externs */\nWindow.prototype.nativeKeep;\n").unwrap();

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
