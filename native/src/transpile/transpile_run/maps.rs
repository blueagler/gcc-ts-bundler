use std::collections::HashMap;
use std::path::Path;

use crate::closure_metadata::ClosureFileMetadata;
use crate::pathing::to_bundler_runtime_module_id;

use super::super::context::{collect_bundler_module_slots, BundlerModuleSlots, ChunkMode};
use super::super::hoist::{build_hoist_plan, HoistPlan};
use super::super::imports_exports::resolved_import_key;
use super::super::napi::{
    ExternalBoundaryInput, LazyImportInput, PackageAliasInput, ResolvedImportInput,
    TranspileChunkInput,
};

pub(crate) fn index_resolved_imports(
    resolved_imports: Vec<ResolvedImportInput>,
) -> HashMap<String, String> {
    resolved_imports
        .into_iter()
        .map(|resolved| {
            (
                resolved_import_key(Path::new(&resolved.importerFilePath), &resolved.specifier),
                resolved.moduleId,
            )
        })
        .collect()
}

pub(crate) fn index_external_specifiers(
    external_boundaries: Vec<ExternalBoundaryInput>,
) -> HashMap<String, String> {
    external_boundaries
        .into_iter()
        .map(|boundary| {
            (
                resolved_import_key(Path::new(&boundary.importerFilePath), &boundary.specifier),
                boundary.specifier,
            )
        })
        .collect()
}

pub(crate) fn collect_bundler_runtime_slots(
    chunk_mode: ChunkMode,
    compiled_file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<(HashMap<String, BundlerModuleSlots>, HashMap<String, String>), String> {
    let bundler_module_slots = if chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(
            compiled_file_names,
            workspace_dir,
            package_aliases,
            resolved_module_ids,
            file_metadata,
        )?
    } else {
        HashMap::new()
    };
    let bundler_runtime_logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect::<HashMap<_, _>>();
    Ok((bundler_module_slots, bundler_runtime_logical_ids))
}

pub(crate) fn maybe_build_hoist_plan(
    chunk_mode: ChunkMode,
    compiled_file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<Option<HoistPlan>, String> {
    if chunk_mode == ChunkMode::BundlerRuntime {
        build_hoist_plan(
            compiled_file_names,
            workspace_dir,
            package_aliases,
            resolved_module_ids,
            chunk_graph,
            lazy_imports,
            file_metadata,
        )
    } else {
        Ok(None)
    }
}
