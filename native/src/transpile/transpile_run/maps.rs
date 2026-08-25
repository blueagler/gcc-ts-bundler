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

pub(crate) struct CompiledModuleIndex<'a> {
    pub(crate) chunk_mode: ChunkMode,
    pub(crate) compiled_file_names: &'a [String],
    pub(crate) workspace_dir: &'a Path,
    pub(crate) package_aliases: &'a [PackageAliasInput],
    pub(crate) resolved_module_ids: &'a HashMap<String, String>,
    pub(crate) file_metadata: &'a HashMap<String, ClosureFileMetadata>,
}

pub(crate) struct BundlerRuntimeMaps {
    pub(crate) module_slots: HashMap<String, BundlerModuleSlots>,
    pub(crate) logical_ids: HashMap<String, String>,
}

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
    index: &CompiledModuleIndex<'_>,
) -> std::result::Result<BundlerRuntimeMaps, String> {
    let bundler_module_slots = if index.chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(
            index.compiled_file_names,
            index.workspace_dir,
            index.package_aliases,
            index.resolved_module_ids,
            index.file_metadata,
        )?
    } else {
        HashMap::new()
    };
    let logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect::<HashMap<_, _>>();
    Ok(BundlerRuntimeMaps {
        module_slots: bundler_module_slots,
        logical_ids,
    })
}

pub(crate) fn maybe_build_hoist_plan(
    index: &CompiledModuleIndex<'_>,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
) -> std::result::Result<Option<HoistPlan>, String> {
    if index.chunk_mode == ChunkMode::BundlerRuntime {
        build_hoist_plan(
            index.compiled_file_names,
            index.workspace_dir,
            index.package_aliases,
            index.resolved_module_ids,
            chunk_graph,
            lazy_imports,
            index.file_metadata,
        )
    } else {
        Ok(None)
    }
}
