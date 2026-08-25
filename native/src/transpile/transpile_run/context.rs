use std::collections::HashSet;
use std::path::PathBuf;

use crate::closure_metadata::load_closure_metadata;
use crate::support_files::collect_commonjs_specifiers;

use super::super::cjs_opacity::collect_opaque_commonjs;
use super::super::context::{parse_chunk_mode, TranspileContext};
use super::super::externs::{collect_extern_property_names_with_externs, ExternPropertyAnalysis};
use super::super::napi::{
    ClassMapCallInput, ExternalBoundaryInput, LazyImportInput, PackageAliasInput,
    PreservedModuleInput, ResolvedImportInput, TranspileChunkInput,
};
use super::super::transpile_plan::{collect_assigner_pin_module_ids, group_lazy_imports_by_file};
use super::maps::{
    collect_bundler_runtime_slots, index_external_specifiers, index_resolved_imports,
    maybe_build_hoist_plan, CompiledModuleIndex,
};
use super::preserved::{
    allocate_run_boundary_identity_tokens, collect_preserved_module_ids,
    filter_compiled_file_names, index_preserved_modules,
};
use super::properties::extend_preserved_property_names;

pub(crate) struct TranspileRunContext {
    pub(crate) compiled_file_names: Vec<String>,
    pub(crate) context: TranspileContext,
    pub(crate) program_declared_names: HashSet<String>,
    pub(crate) explicit_extern_property_count: u32,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_transpile_context(
    file_names: Vec<String>,
    explicit_extern_paths: Vec<String>,
    metadata_path: String,
    chunk_mode: String,
    target: String,
    workspace_dir: String,
    package_aliases: Vec<PackageAliasInput>,
    resolved_imports: Vec<ResolvedImportInput>,
    external_boundaries: Vec<ExternalBoundaryInput>,
    opaque_external_specifiers: Vec<String>,
    preserved_modules: Vec<PreservedModuleInput>,
    lazy_imports: Vec<LazyImportInput>,
    chunk_graph: &[TranspileChunkInput],
    class_map_calls: Vec<ClassMapCallInput>,
    pure_callees: Vec<String>,
    type_inference_disabled: bool,
) -> std::result::Result<TranspileRunContext, String> {
    let workspace_dir = PathBuf::from(workspace_dir);
    let chunk_mode = parse_chunk_mode(&chunk_mode)?;
    let preserved_module_ids = collect_preserved_module_ids(&preserved_modules);
    let boundary_identity_tokens = allocate_run_boundary_identity_tokens(
        &external_boundaries,
        &resolved_imports,
        &preserved_module_ids,
        &workspace_dir,
    );
    let preserved_modules = index_preserved_modules(preserved_modules);
    let compiled_file_names = filter_compiled_file_names(&file_names, &preserved_modules);
    let resolved_module_ids = index_resolved_imports(resolved_imports);
    let external_specifiers = index_external_specifiers(external_boundaries);
    let preserves_node_import_meta = target == "node";
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let compiled_index = CompiledModuleIndex {
        chunk_mode,
        compiled_file_names: &compiled_file_names,
        workspace_dir: &workspace_dir,
        package_aliases: &package_aliases,
        resolved_module_ids: &resolved_module_ids,
        file_metadata: &file_metadata,
    };
    let bundler_runtime = collect_bundler_runtime_slots(&compiled_index)?;
    let hoist_plan = maybe_build_hoist_plan(&compiled_index, chunk_graph, &lazy_imports)?;
    let ExternPropertyAnalysis {
        program_declared_names,
        explicit_extern_property_names,
        mut preserved_property_names,
        static_property_names,
    } = collect_extern_property_names_with_externs(
        &compiled_file_names,
        &explicit_extern_paths,
        &file_metadata,
    )?;
    extend_preserved_property_names(
        &mut preserved_property_names,
        &compiled_file_names,
        &class_map_calls,
        &file_metadata,
        preserves_node_import_meta,
        type_inference_disabled,
    )?;
    let commonjs_specifiers = collect_commonjs_specifiers(&package_aliases)?
        .into_iter()
        .collect::<HashSet<_>>();
    let lazy_target_module_ids = lazy_imports
        .iter()
        .map(|lazy_import| lazy_import.moduleId.clone())
        .collect::<HashSet<_>>();
    let context = TranspileContext {
        bundler_module_slots: bundler_runtime.module_slots,
        bundler_runtime_logical_ids: bundler_runtime.logical_ids,
        chunk_mode,
        class_map_calls,
        pure_callees: pure_callees.into_iter().collect(),
        commonjs_specifiers: commonjs_specifiers.clone(),
        opaque_commonjs: std::sync::Arc::new(collect_opaque_commonjs(
            &file_names,
            &commonjs_specifiers,
            &package_aliases,
        )?),
        boundary_identity_tokens,
        external_specifiers,
        opaque_external_specifiers: opaque_external_specifiers.into_iter().collect(),
        file_metadata,
        hoist_plan: hoist_plan.map(std::sync::Arc::new),
        lazy_imports_by_file: group_lazy_imports_by_file(lazy_imports),
        lazy_target_module_ids,
        package_aliases,
        preserved_modules,
        resolved_module_ids,
        preserved_property_names,
        static_property_names,
        type_metadata_enabled: !type_inference_disabled,
        assigner_pin_module_ids: collect_assigner_pin_module_ids(chunk_graph, &workspace_dir),
        workspace_dir: workspace_dir.clone(),
    };
    Ok(TranspileRunContext {
        compiled_file_names,
        context,
        program_declared_names,
        explicit_extern_property_count: explicit_extern_property_names.len() as u32,
    })
}
