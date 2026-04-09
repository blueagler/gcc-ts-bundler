use super::super::*;
use super::shared::property_renaming_report_path;

pub(crate) fn prepare_off_mode_jobs(
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
    let property_renaming_report_path =
        property_renaming_report_path(raw_dir, &input.compilationLevel);

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
            propertyRenamingReportPath: property_renaming_report_path.clone(),
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
            propertyRenamingReportPath: property_renaming_report_path.clone(),
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
            kind: if property_renaming_report_path.is_some() {
                "rewrite-gcc-exports-and-decorator-metadata".to_string()
            } else {
                "rewrite-gcc-exports".to_string()
            },
            outputPath: PathBuf::from(&input.outDir)
                .join(format!("{}.js", chunk.name))
                .to_string_lossy()
                .to_string(),
            propertyRenamingReportPath: property_renaming_report_path.clone(),
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
