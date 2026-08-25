use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::pathing::{normalize_path, to_goog_module_id};

use super::super::emit_goog;
use super::super::napi::{ExternalBoundaryInput, PreservedModuleInput, ResolvedImportInput};

pub(crate) fn collect_preserved_module_ids(
    preserved_modules: &[PreservedModuleInput],
) -> HashSet<String> {
    preserved_modules
        .iter()
        .map(|module| module.moduleId.clone())
        .collect()
}

pub(crate) fn allocate_run_boundary_identity_tokens(
    external_boundaries: &[ExternalBoundaryInput],
    resolved_imports: &[ResolvedImportInput],
    preserved_module_ids: &HashSet<String>,
    workspace_dir: &Path,
) -> HashMap<String, String> {
    emit_goog::allocate_boundary_identity_tokens(
        external_boundaries
            .iter()
            .map(|boundary| boundary.specifier.clone())
            .chain(
                resolved_imports
                    .iter()
                    .filter(|resolved| preserved_module_ids.contains(&resolved.moduleId))
                    .map(|resolved| {
                        emit_goog::boundary_identity(
                            &to_goog_module_id(
                                Path::new(&resolved.importerFilePath),
                                workspace_dir,
                            ),
                            &resolved.specifier,
                        )
                    }),
            ),
    )
}

pub(crate) fn index_preserved_modules(
    preserved_modules: Vec<PreservedModuleInput>,
) -> HashMap<String, PreservedModuleInput> {
    preserved_modules
        .into_iter()
        .map(|module| (module.moduleId.clone(), module))
        .collect()
}

pub(crate) fn filter_compiled_file_names(
    file_names: &[String],
    preserved_modules: &HashMap<String, PreservedModuleInput>,
) -> Vec<String> {
    let preserved_file_paths = preserved_modules
        .values()
        .map(|module| {
            normalize_path(Path::new(&module.filePath))
                .to_string_lossy()
                .to_string()
        })
        .collect::<HashSet<_>>();
    file_names
        .iter()
        .filter(|file_name| {
            !preserved_file_paths.contains(
                &normalize_path(Path::new(file_name))
                    .to_string_lossy()
                    .to_string(),
            )
        })
        .cloned()
        .collect()
}
