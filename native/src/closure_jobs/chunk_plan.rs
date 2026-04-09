use super::*;

#[derive(Clone, Debug)]
pub(super) struct ResolvedClosureChunk {
    pub(super) dependencies: Vec<String>,
    pub(super) entry_points: Vec<String>,
    pub(super) files: Vec<String>,
    pub(super) kind: Option<String>,
    pub(super) name: String,
}

pub(super) fn resolve_chunk_plan(
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
