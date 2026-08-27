use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use rayon::prelude::*;

use crate::closure_metadata::{closure_metadata_key, ClosureFileMetadata};
use crate::pathing::to_bundler_runtime_module_id;

use super::super::cjs_opacity::{
    collect_opaque_package_keys_from_program, opaque_commonjs_from_package_keys, OpaqueCommonJs,
};
use super::super::compat_properties;
use super::super::context::{
    analysis_resolution_context, collect_file_bundler_exports, resolve_bundler_module_slots,
    BundlerModuleSlots, ChunkMode, RawBundlerExportInfo, TranspileContext,
};
use super::super::emit_helpers;
use super::super::externs::{
    analyze_extern_file_program, merge_extern_property_facts, ExternFileFacts,
    ExternPropertyAnalysis,
};
use super::super::hoist::{assemble_hoist_plan, scan_hoist_module, HoistPlan, ModuleScan};
use super::super::napi::{
    ClassMapCallInput, LazyImportInput, PackageAliasInput, TranspileChunkInput,
};
use super::super::transpile_plan::parse_oxc_program;

pub(crate) struct AnalysisPrelude {
    pub(crate) bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    pub(crate) bundler_runtime_logical_ids: HashMap<String, String>,
    pub(crate) hoist_plan: Option<HoistPlan>,
    pub(crate) opaque_commonjs: OpaqueCommonJs,
    pub(crate) extern_analysis: ExternPropertyAnalysis,
    pub(crate) prelude_property_names: HashSet<String>,
}

struct FileAnalysis {
    opaque_package_keys: HashSet<String>,
    bundler_raw: Option<(String, RawBundlerExportInfo)>,
    hoist: Option<(String, ModuleScan)>,
    extern_facts: Option<ExternFileFacts>,
    prelowered_names: BTreeSet<String>,
    pair_array_names: HashSet<String>,
}

struct PreludeInput<'a> {
    compiled: &'a HashSet<String>,
    file_metadata: &'a HashMap<String, ClosureFileMetadata>,
    commonjs_specifiers: &'a HashSet<String>,
    package_aliases: &'a [PackageAliasInput],
    class_map_calls: &'a [ClassMapCallInput],
    resolution_context: &'a TranspileContext,
    need_bundler: bool,
    need_hoist: bool,
    need_pair_array: bool,
}

/// One parse per file for every pre-emit analysis visitor, then a deterministic merge.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_analysis_prelude(
    file_names: &[String],
    compiled_file_names: &[String],
    explicit_extern_paths: &[String],
    chunk_mode: ChunkMode,
    workspace_dir: &Path,
    package_aliases: &[PackageAliasInput],
    resolved_module_ids: &HashMap<String, String>,
    file_metadata: &HashMap<String, ClosureFileMetadata>,
    chunk_graph: &[TranspileChunkInput],
    lazy_imports: &[LazyImportInput],
    class_map_calls: &[ClassMapCallInput],
    commonjs_specifiers: &HashSet<String>,
) -> std::result::Result<AnalysisPrelude, String> {
    let need_bundler = chunk_mode == ChunkMode::BundlerRuntime;
    let need_hoist = need_bundler && !chunk_graph.is_empty();
    let need_pair_array = class_map_calls
        .iter()
        .any(|call| call.keySource.as_deref() == Some("pairArray"));
    let compiled = compiled_file_names.iter().cloned().collect::<HashSet<_>>();
    let resolution_context =
        analysis_resolution_context(workspace_dir, package_aliases, resolved_module_ids);
    let input = PreludeInput {
        compiled: &compiled,
        file_metadata,
        commonjs_specifiers,
        package_aliases,
        class_map_calls,
        resolution_context: &resolution_context,
        need_bundler,
        need_hoist,
        need_pair_array,
    };
    let files = file_names
        .iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .collect::<Vec<_>>();
    let results: Vec<std::result::Result<FileAnalysis, String>> = files
        .par_iter()
        .map(|file_name| analyze_one_file(file_name, &input))
        .collect();

    let mut opaque_package_keys = HashSet::new();
    let mut raw_exports_by_module = HashMap::new();
    let mut scans = HashMap::new();
    let mut extern_files = Vec::new();
    let mut prelude_property_names = HashSet::new();
    for result in results {
        let analysis = result?;
        opaque_package_keys.extend(analysis.opaque_package_keys);
        if let Some((module_id, raw)) = analysis.bundler_raw {
            raw_exports_by_module.insert(module_id, raw);
        }
        if let Some((module_id, scan)) = analysis.hoist {
            scans.insert(module_id, scan);
        }
        prelude_property_names.extend(analysis.prelowered_names);
        prelude_property_names.extend(analysis.pair_array_names);
        if let Some(facts) = analysis.extern_facts {
            extern_files.push(facts);
        }
    }

    let bundler_module_slots = if need_bundler {
        resolve_bundler_module_slots(raw_exports_by_module)?
    } else {
        HashMap::new()
    };
    let bundler_runtime_logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect();
    let hoist_plan = if need_hoist {
        Some(assemble_hoist_plan(
            scans,
            workspace_dir,
            chunk_graph,
            lazy_imports,
        ))
    } else {
        None
    };

    Ok(AnalysisPrelude {
        bundler_module_slots,
        bundler_runtime_logical_ids,
        hoist_plan,
        opaque_commonjs: opaque_commonjs_from_package_keys(
            opaque_package_keys,
            commonjs_specifiers,
            package_aliases,
        ),
        extern_analysis: merge_extern_property_facts(extern_files, explicit_extern_paths)?,
        prelude_property_names,
    })
}

fn analyze_one_file(
    file_name: &str,
    input: &PreludeInput<'_>,
) -> std::result::Result<FileAnalysis, String> {
    let file_path = PathBuf::from(file_name);
    let authored_source = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
    let metadata = input.file_metadata.get(&closure_metadata_key(&file_path));
    let allocator = Allocator::default();
    // Extern, pair-array, and pre-lowered-helper scans have always walked the
    // authored text: custom-element registration lives on the decorator AST,
    // and accessibility modifiers exist only before TypeScript emit. Bundler
    // and hoist slots follow the text Closure actually compiles, so a second
    // parse is taken only when that emit-shaped text differs.
    let mut authored_program = parse_oxc_program(&allocator, &file_path, &authored_source)?;
    let opaque_package_keys = collect_opaque_package_keys_from_program(
        &authored_program,
        &file_path,
        input.commonjs_specifiers,
        input.package_aliases,
    );
    if !input.compiled.contains(file_name) {
        return Ok(FileAnalysis {
            opaque_package_keys,
            bundler_raw: None,
            hoist: None,
            extern_facts: None,
            prelowered_names: BTreeSet::new(),
            pair_array_names: HashSet::new(),
        });
    }

    let (bundler_raw, hoist) = if input.need_bundler || input.need_hoist {
        let lowered_program =
            match metadata.and_then(|metadata| metadata.decorated_output_text.as_deref()) {
                Some(lowered_source) => Some(parse_oxc_program(
                    &allocator,
                    &file_path.with_extension("js"),
                    lowered_source,
                )?),
                None => None,
            };
        let emitted_program = lowered_program.as_ref().unwrap_or(&authored_program);
        let bundler_raw = if input.need_bundler {
            Some(collect_file_bundler_exports(
                emitted_program,
                &file_path,
                &input.resolution_context.workspace_dir,
                metadata,
                input.resolution_context,
            )?)
        } else {
            None
        };
        let hoist = if input.need_hoist {
            Some(scan_hoist_module(
                emitted_program,
                &file_path,
                &input.resolution_context.workspace_dir,
                metadata,
                input.resolution_context,
            )?)
        } else {
            None
        };
        (bundler_raw, hoist)
    } else {
        (None, None)
    };
    let prelowered_names =
        emit_helpers::collect_decorator_metadata_property_names(&authored_program);
    let pair_array_names = if input.need_pair_array {
        compat_properties::collect_pair_array_class_map_property_names(
            &authored_program,
            input.class_map_calls,
        )?
    } else {
        HashSet::new()
    };
    let extern_facts = Some(analyze_extern_file_program(
        &allocator,
        &mut authored_program,
        metadata,
    ));
    Ok(FileAnalysis {
        opaque_package_keys,
        bundler_raw,
        hoist,
        extern_facts,
        prelowered_names,
        pair_array_names,
    })
}
