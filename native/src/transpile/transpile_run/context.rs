use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::closure_metadata::load_closure_metadata;
use crate::support_files::collect_commonjs_specifiers;

use super::super::context::{parse_chunk_mode, ChunkMode, TranspileContext};
use super::super::napi::{TranspileOutput, TranspileSourcesInput};
use super::super::transpile_plan::group_lazy_imports_by_file;
use super::super::transpile_write::{emit_and_write_transpile_outputs, TranspileWriteInput};
use super::maps::{index_external_specifiers, index_resolved_imports};
use super::prelude::{run_analysis_prelude, AnalysisPreludeInput};
use super::preserved::{
    allocate_run_boundary_identity_tokens, collect_preserved_module_ids,
    filter_compiled_file_names, index_preserved_modules,
};
use super::properties::extend_preserved_property_names;

pub(super) fn transpile_validated_sources(
    input: TranspileSourcesInput,
) -> Result<TranspileOutput, String> {
    let TranspileSourcesInput {
        file_names,
        explicit_extern_paths,
        out_dir,
        externs_path,
        metadata_path,
        chunk_mode,
        target,
        runtime_module_source_map_file,
        workspace_dir,
        package_aliases,
        resolved_imports,
        external_boundaries,
        opaque_external_specifiers,
        package_json_files,
        preserved_modules,
        lazy_imports,
        chunk_graph,
        class_map_calls,
        pure_callees,
        type_inference_disabled,
    } = input;
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
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let commonjs_specifiers = collect_commonjs_specifiers(&package_aliases)?
        .into_iter()
        .collect::<HashSet<_>>();
    // Prelude visitors see the same resolution-only context as before. Move
    // its maps into their final owner now rather than cloning a second context.
    let mut context = TranspileContext {
        bundler_module_slots: HashMap::new(),
        goog_live_modules: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        boundary_identity_tokens: HashMap::new(),
        external_specifiers: index_external_specifiers(external_boundaries),
        opaque_external_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        authored_enum_values: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases,
        preserved_modules: HashMap::new(),
        resolved_module_ids: index_resolved_imports(resolved_imports),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: false,
        pin_cross_chunk_assigners: chunk_graph.len() > 1,
        workspace_dir,
    };
    let prelude = run_analysis_prelude(AnalysisPreludeInput {
        file_names: &file_names,
        compiled_file_names: &compiled_file_names,
        explicit_extern_paths: &explicit_extern_paths,
        chunk_mode,
        resolution_context: &context,
        file_metadata: &file_metadata,
        chunk_graph: &chunk_graph,
        lazy_imports: &lazy_imports,
        class_map_calls: &class_map_calls,
        commonjs_specifiers: &commonjs_specifiers,
    })?;
    let mut preserved_property_names = prelude.extern_analysis.preserved_property_names;
    extend_preserved_property_names(
        &mut preserved_property_names,
        &file_metadata,
        target == "node",
        type_inference_disabled,
        prelude.prelude_property_names,
    );
    context.bundler_module_slots = prelude.bundler_module_slots;
    context.goog_live_modules = prelude.goog_live_modules;
    context.bundler_runtime_logical_ids = prelude.bundler_runtime_logical_ids;
    context.chunk_mode = chunk_mode;
    context.class_map_calls = class_map_calls;
    context.pure_callees = pure_callees.into_iter().collect();
    context.commonjs_specifiers = commonjs_specifiers;
    context.opaque_commonjs = std::sync::Arc::new(prelude.opaque_commonjs);
    context.boundary_identity_tokens = boundary_identity_tokens;
    context.opaque_external_specifiers = opaque_external_specifiers.into_iter().collect();
    context.file_metadata = file_metadata;
    context.authored_enum_values = prelude.authored_enum_values;
    context.hoist_plan = prelude.hoist_plan.map(std::sync::Arc::new);
    context.lazy_target_module_ids = lazy_imports
        .iter()
        .map(|lazy_import| lazy_import.module_id.clone())
        .collect();
    context.lazy_imports_by_file = group_lazy_imports_by_file(lazy_imports);
    context.preserved_modules = preserved_modules;
    context.preserved_property_names = preserved_property_names;
    context.static_property_names = prelude.extern_analysis.static_property_names;
    context.type_metadata_enabled = !type_inference_disabled;
    emit_and_write_transpile_outputs(TranspileWriteInput {
        compiled_file_names: &compiled_file_names,
        context: &context,
        chunk_graph: &chunk_graph,
        out_dir: Path::new(&out_dir),
        program_declared_names: &prelude.extern_analysis.declared_bindings,
        explicit_extern_property_count: prelude.extern_analysis.explicit_extern_property_names.len()
            as u32,
        externs_path,
        runtime_module_source_map_file: runtime_module_source_map_file.as_deref(),
        package_json_files: &package_json_files,
    })
}
