//! Hoist-plan construction: module scans, export resolution, and facade slots.

mod exports;
mod scan;
mod slots;

use super::super::*;
use super::HoistPlan;
use exports::{resolve_all_export_bindings, resolve_all_namespace_reexports};
#[cfg(test)]
use oxc_allocator::Allocator;
use oxc_semantic::SemanticBuilder;
use scan::{collect_state_writing_declarations, scan_commonjs_module, scan_esm_program};
use slots::compute_facade_slots;
#[cfg(test)]
use std::fs;

pub(crate) use scan::ModuleScan;

/// Scan one already-parsed module for hoist-plan construction.
pub(crate) fn scan_hoist_module(
    program: &oxc_ast::ast::Program<'_>,
    file_path: &Path,
    workspace_dir: &Path,
    metadata: Option<&ClosureFileMetadata>,
    resolution_context: &TranspileContext,
) -> std::result::Result<(String, ModuleScan), String> {
    let module_id = to_goog_module_id(file_path, workspace_dir);
    let commonjs_analysis = crate::commonjs::analyze_commonjs_program(program);
    let mut scan = if should_normalize_commonjs(file_path, &commonjs_analysis) {
        scan_commonjs_module(file_path, &commonjs_analysis, resolution_context)
    } else {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(program);
        if !semantic.diagnostics.is_empty() {
            return Err(semantic
                .diagnostics
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"));
        }
        let live_assigners = collect_state_writing_declarations(&semantic.semantic);
        let identity =
            super::super::identity::ModuleIdentity::new(semantic.semantic.into_scoping());
        let mut scan = scan_esm_program(program, &identity, file_path, resolution_context);
        scan.local_export_modes =
            super::super::emit_runtime::collect_local_export_modes(program, &identity);
        scan.live_assigners = live_assigners;
        scan
    };
    if let Some(metadata) = metadata {
        scan.own_exports.extend(
            metadata
                .enums
                .iter()
                .filter(|enum_decl| enum_decl.exported)
                .map(|enum_decl| {
                    (
                        enum_decl.binding_name.clone(),
                        enum_decl.binding_name.clone(),
                    )
                }),
        );
    }
    Ok((module_id, scan))
}

/// Fold per-file scans into the cross-module hoist plan.
pub(crate) fn assemble_hoist_plan(
    scans: HashMap<String, ModuleScan>,
    workspace_dir: &Path,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
) -> HoistPlan {
    let mut module_chunks = HashMap::new();
    let mut module_positions = HashMap::new();
    for (chunk_index, chunk) in chunk_graph.iter().enumerate() {
        for (position, relative_file) in chunk.files.iter().enumerate() {
            let module_id = to_goog_module_id(&workspace_dir.join(relative_file), workspace_dir);
            module_chunks.insert(module_id.clone(), chunk_index);
            module_positions.insert(module_id, position);
        }
    }
    let chunk_dependency_closure = build_chunk_dependency_closure(chunk_graph);
    let sorted_module_ids = scans.keys().cloned().collect::<BTreeSet<_>>();
    let mut hoistable = HashSet::new();
    for (module_id, scan) in &scans {
        if module_chunks.contains_key(module_id) && !scan.scan_failed {
            hoistable.insert(module_id.clone());
        }
    }

    let module_ordinals = sorted_module_ids
        .iter()
        .enumerate()
        .map(|(ordinal, module_id)| (module_id.clone(), ordinal))
        .collect::<HashMap<_, _>>();

    let export_bindings = resolve_all_export_bindings(&scans);
    let namespace_reexports = resolve_all_namespace_reexports(&scans);
    let reified_namespace_modules = scans
        .values()
        .flat_map(|scan| {
            scan.import_edges
                .iter()
                .filter(|edge| edge.namespace && edge.namespace_members.is_none())
                .map(|edge| edge.target_module_id.clone())
        })
        .collect::<HashSet<_>>();
    let namespace_object_modules = namespace_reexports
        .values()
        .flat_map(|targets| targets.values().cloned())
        .chain(reified_namespace_modules.iter().cloned())
        .collect();

    let plan_without_facades = HoistPlan {
        chunk_dependency_closure,
        export_bindings,
        namespace_reexports,
        namespace_object_modules,
        reified_namespace_modules,
        facade_slots: HashMap::new(),
        hoisted_modules: hoistable,
        module_chunks,
        module_positions,
        module_ordinals,
    };
    let facade_slots = compute_facade_slots(&plan_without_facades, &scans, lazy_imports);
    HoistPlan {
        facade_slots,
        ..plan_without_facades
    }
}

/// Whole-graph driver retained for hoist unit tests. Production uses the fused
/// prelude, which parses once and calls `scan_hoist_module` / `assemble_hoist_plan`.
#[cfg(test)]
pub(crate) fn build_hoist_plan(
    file_names: &[String],
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<Option<HoistPlan>, String> {
    if chunk_graph.is_empty() {
        return Ok(None);
    }
    let resolution_context = super::super::analysis_resolution_context(
        workspace_dir,
        package_aliases,
        resolved_module_ids,
    );
    let mut scans = HashMap::<String, ModuleScan>::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        let metadata = file_metadata.get(&closure_metadata_key(&file_path));
        let authored_source = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        let source = metadata
            .and_then(|metadata| metadata.decorated_output_text.as_deref())
            .unwrap_or(&authored_source);
        let effective_path =
            if metadata.is_some_and(|metadata| metadata.decorated_output_text.is_some()) {
                file_path.with_extension("js")
            } else {
                file_path.clone()
            };
        let allocator = Allocator::default();
        let program = super::super::parse_oxc_program(&allocator, &effective_path, source)?;
        let (module_id, scan) = scan_hoist_module(
            &program,
            &file_path,
            workspace_dir,
            metadata,
            &resolution_context,
        )?;
        scans.insert(module_id, scan);
    }
    Ok(Some(assemble_hoist_plan(
        scans,
        workspace_dir,
        chunk_graph,
        lazy_imports,
    )))
}

/// Transitive closure of the plan's chunk dependency edges, by chunk index.
///
/// The loader fetches and runs a chunk's dependencies before the chunk
/// itself, so "is in the closure" is exactly "has already executed". An empty
/// result (no chunk declared a dependency) disables the ordering check rather
/// than forbidding every cross-chunk binding, which is what callers that do
/// not build a dependency graph rely on.
fn build_chunk_dependency_closure(chunk_graph: &[TranspileChunkInput]) -> Vec<HashSet<usize>> {
    if chunk_graph
        .iter()
        .all(|chunk| chunk.dependencies.is_empty())
    {
        return Vec::new();
    }
    let index_by_name = chunk_graph
        .iter()
        .enumerate()
        .map(|(index, chunk)| (chunk.name.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut closure = vec![HashSet::new(); chunk_graph.len()];
    for (index, chunk) in chunk_graph.iter().enumerate() {
        let mut pending = chunk
            .dependencies
            .iter()
            .filter_map(|name| index_by_name.get(name.as_str()).copied())
            .collect::<Vec<_>>();
        while let Some(dependency) = pending.pop() {
            if dependency == index || !closure[index].insert(dependency) {
                continue;
            }
            pending.extend(
                chunk_graph[dependency]
                    .dependencies
                    .iter()
                    .filter_map(|name| index_by_name.get(name.as_str()).copied()),
            );
        }
    }
    closure
}
