use std::collections::{HashMap, HashSet};

use std::path::{Path, PathBuf};

use super::super::chunk_plan::ResolvedClosureChunk;
use super::super::externs::{
    collect_effective_extern_paths, read_candidate_contents, select_closure_lib_files,
    select_effective_extern_paths, unique_paths, ClosureLibScanner,
};
use super::super::runtime::{
    language_out_requires_es5_adapter, needs_custom_elements_es5_adapter,
    render_custom_elements_es5_adapter,
};
use super::super::{
    ChunkOutputType, ClosureCompileJob, GeneratedAsset, PostprocessAction, PrepareClosureJobsInput,
    PrepareClosureJobsOutput,
};
use super::shared::{aggregate_type_metadata, property_renaming_report_path};

pub(crate) fn prepare_off_mode_jobs(
    input: &PrepareClosureJobsInput,
    resolved_chunks: &[ResolvedClosureChunk],
    raw_dir: &Path,
    warning_level: &str,
    chunk_output_type: ChunkOutputType,
) -> std::result::Result<PrepareClosureJobsOutput, String> {
    let mut generated_assets = Vec::new();
    let externs = collect_effective_extern_paths(
        &input.package_root,
        &input.explicit_extern_paths,
        &input.generated_externs,
        Some(&input.native_extern_path),
        None,
    )?;
    let mut explicit_js_inputs = input.explicit_js_inputs.clone();
    if language_out_requires_es5_adapter(&input.language_out) {
        let adapter_scan_contents = read_candidate_contents(
            input
                .support_files
                .iter()
                .chain(resolved_chunks.iter().flat_map(|chunk| chunk.files.iter())),
        )?;
        if needs_custom_elements_es5_adapter(&input.language_out, &adapter_scan_contents) {
            let adapter_path = raw_dir.join("custom-elements-es5-adapter.js");
            generated_assets.push(GeneratedAsset {
                path: adapter_path.to_string_lossy().to_string(),
                text: render_custom_elements_es5_adapter(),
            });
            explicit_js_inputs.push(adapter_path.to_string_lossy().to_string());
        }
    }
    explicit_js_inputs = unique_paths(explicit_js_inputs);
    let mut helper_scanner = ClosureLibScanner::default();
    let mut common_requirements = helper_scanner.scan(
        input
            .explicit_js_inputs
            .iter()
            .chain(input.support_files.iter()),
    )?;
    for asset in &generated_assets {
        common_requirements.observe(&asset.text);
    }
    let (type_metadata_counts, has_type_metadata) = aggregate_type_metadata(
        input,
        resolved_chunks
            .iter()
            .flat_map(|chunk| chunk.files.iter().cloned())
            .collect::<Vec<_>>(),
    )?;

    let compile_jobs = partition_off_mode_components(resolved_chunks)
        .into_iter()
        .map(|component| {
            let entries = component
                .iter()
                .filter_map(|chunk| chunk.entry_files.as_ref())
                .flatten()
                .collect::<HashSet<_>>();
            // Shared chunks have no entry ownership. An unowned leaf, however,
            // can be an entry from an incomplete external plan: retain contracts.
            let ownership_known = !entries.is_empty()
                && component.iter().all(|chunk| {
                    chunk
                        .entry_files
                        .as_ref()
                        .is_some_and(|entries| !entries.is_empty())
                        || component
                            .iter()
                            .any(|other| other.dependencies.contains(&chunk.name))
                });
            let job_externs =
                select_effective_extern_paths(&externs, ownership_known.then_some(&entries));
            let mut requirements = common_requirements;
            requirements
                .merge(helper_scanner.scan(component.iter().flat_map(|chunk| chunk.files.iter()))?);
            let closure_lib_files = select_closure_lib_files(&input.package_root, requirements);
            let job_stem = component.first().map_or("job", |chunk| chunk.name.as_str());
            let property_renaming_report_path =
                property_renaming_report_path(raw_dir, &input.compilation_level, job_stem);
            let job = if component.len() == 1 && !chunk_output_type.is_esm() {
                let entry_chunk = component[0];
                ClosureCompileJob {
                    assume_function_wrapper: true,
                    chunk: None,
                    chunk_output_path_prefix: None,
                    chunk_output_type: None,
                    compilation_level: input.compilation_level.clone(),
                    dependency_mode: Some("PRUNE".to_string()),
                    entry_point: (!entry_chunk.entry_points.is_empty())
                        .then_some(entry_chunk.entry_points.clone()),
                    externs: job_externs,
                    js: unique_paths(
                        explicit_js_inputs
                            .iter()
                            .cloned()
                            .chain(closure_lib_files.iter().cloned())
                            .chain(input.support_files.iter().cloned())
                            .chain(entry_chunk.files.iter().cloned())
                            .collect(),
                    ),
                    js_output_file: Some(
                        raw_dir
                            .join(format!("{}.js", entry_chunk.name))
                            .to_string_lossy()
                            .to_string(),
                    ),
                    language_in: "UNSTABLE".to_string(),
                    language_out: input.language_out.clone(),
                    property_renaming_report_path: property_renaming_report_path.clone(),
                    rename_prefix_namespace: None,
                    rewrite_polyfills: false,
                    warning_level: warning_level.to_string(),
                    has_type_metadata,
                    type_metadata_counts: type_metadata_counts.clone(),
                }
            } else {
                let leading_js = unique_paths(
                    explicit_js_inputs
                        .iter()
                        .cloned()
                        .chain(closure_lib_files.iter().cloned())
                        .chain(input.support_files.iter().cloned())
                        .collect(),
                );
                let chunk_specs = component
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
                    component
                        .iter()
                        .flat_map(|chunk| chunk.entry_points.iter().cloned())
                        .collect(),
                );
                ClosureCompileJob {
                    assume_function_wrapper: true,
                    chunk: Some(chunk_specs),
                    chunk_output_path_prefix: Some(format!(
                        "{}{}",
                        raw_dir.to_string_lossy(),
                        std::path::MAIN_SEPARATOR
                    )),
                    chunk_output_type: chunk_output_type.is_esm().then(|| "ES_MODULES".to_string()),
                    compilation_level: input.compilation_level.clone(),
                    dependency_mode: Some("PRUNE".to_string()),
                    entry_point: (!entry_points.is_empty()).then_some(entry_points),
                    externs: job_externs,
                    js: unique_paths(
                        leading_js
                            .into_iter()
                            .chain(
                                component
                                    .iter()
                                    .flat_map(|chunk| chunk.files.iter().cloned()),
                            )
                            .collect(),
                    ),
                    js_output_file: None,
                    language_in: "UNSTABLE".to_string(),
                    language_out: input.language_out.clone(),
                    property_renaming_report_path: property_renaming_report_path.clone(),
                    rename_prefix_namespace: None,
                    rewrite_polyfills: false,
                    warning_level: warning_level.to_string(),
                    has_type_metadata,
                    type_metadata_counts: type_metadata_counts.clone(),
                }
            };
            Ok(job)
        })
        .collect::<Result<Vec<_>, String>>()?;

    let postprocess_actions = resolved_chunks
        .iter()
        .map(|chunk| PostprocessAction {
            input_path: raw_dir
                .join(format!("{}.js", chunk.name))
                .to_string_lossy()
                .to_string(),
            // Off and split mode publish Closure wrapper exports, so every
            // action goes through the ESM export rewrite.
            kind: "rewrite-gcc-exports".to_string(),
            output_path: PathBuf::from(&input.out_dir)
                .join(format!("{}.js", chunk.name))
                .to_string_lossy()
                .to_string(),
        })
        .collect::<Vec<_>>();
    let published_outputs = postprocess_actions
        .iter()
        .map(|action| action.output_path.clone())
        .collect::<Vec<_>>();

    Ok(PrepareClosureJobsOutput {
        bundler_runtime_base_input_path: None,
        compile_jobs,
        generated_assets,
        postprocess_actions,
        published_outputs,
    })
}

fn partition_off_mode_components(
    chunks: &[ResolvedClosureChunk],
) -> Vec<Vec<&ResolvedClosureChunk>> {
    if chunks.is_empty() {
        return vec![Vec::new()];
    }

    let mut parent = (0..chunks.len()).collect::<Vec<_>>();
    let index_by_name = chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| (chunk.name.as_str(), index))
        .collect::<HashMap<_, _>>();
    for (index, chunk) in chunks.iter().enumerate() {
        for dependency in &chunk.dependencies {
            if let Some(&dependency_index) = index_by_name.get(dependency.as_str()) {
                union_job_roots(&mut parent, index, dependency_index);
            }
        }
    }

    let mut component_order = Vec::new();
    let mut members = HashMap::<usize, Vec<usize>>::new();
    for index in 0..chunks.len() {
        let root = find_job_root(&mut parent, index);
        if !members.contains_key(&root) {
            component_order.push(root);
        }
        members.entry(root).or_default().push(index);
    }

    component_order
        .into_iter()
        .map(|root| {
            members
                .get(&root)
                .into_iter()
                .flatten()
                .map(|&index| &chunks[index])
                .collect()
        })
        .collect()
}

fn find_job_root(parent: &mut [usize], mut index: usize) -> usize {
    while parent[index] != index {
        parent[index] = parent[parent[index]];
        index = parent[index];
    }
    index
}

fn union_job_roots(parent: &mut [usize], left: usize, right: usize) {
    let left_root = find_job_root(parent, left);
    let right_root = find_job_root(parent, right);
    if left_root != right_root {
        parent[right_root] = left_root;
    }
}
