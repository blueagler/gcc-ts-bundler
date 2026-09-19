use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use oxc_allocator::Allocator;
use rayon::prelude::*;

use super::super::emit_goog::live_bindings::{
    collect_live_module_facts, resolve_live_module_facts, LiveModuleFacts,
};
use crate::closure_metadata::{closure_metadata_key, ClosureFileMetadata};
use crate::pathing::{to_bundler_runtime_module_id, to_goog_module_id};

use super::super::cjs_opacity::{
    collect_opaque_package_keys_from_program, opaque_commonjs_from_package_keys, OpaqueCommonJs,
};
use super::super::compat_properties;
use super::super::context::{
    collect_export_topology, collect_file_bundler_exports, resolve_bundler_module_slots,
    BundlerModuleSlots, ChunkMode, RawBundlerExportInfo, TranspileContext,
};
use super::super::emit_helpers;
use super::super::externs::{
    analyze_extern_file_program, merge_extern_property_facts, ExternFileFacts,
    ExternPropertyAnalysis,
};
use super::super::hoist::{assemble_hoist_plan, scan_hoist_module, HoistPlan, ModuleScan};
use super::super::js_compat::should_normalize_commonjs;
use super::super::napi::{
    ClassMapCallInput, LazyImportInput, PackageAliasInput, TranspileChunkInput,
};
use super::super::transpile_plan::parse_oxc_program;
use crate::commonjs::analyze_commonjs_program;

pub(crate) struct AnalysisPrelude {
    pub(crate) bundler_module_slots: HashMap<String, BundlerModuleSlots>,
    pub(crate) goog_live_modules: HashMap<String, LiveModuleFacts>,
    pub(crate) bundler_runtime_logical_ids: HashMap<String, String>,
    pub(crate) hoist_plan: Option<HoistPlan>,
    pub(crate) opaque_commonjs: OpaqueCommonJs,
    pub(crate) extern_analysis: ExternPropertyAnalysis,
    pub(crate) prelude_property_names: HashSet<String>,
    pub(crate) authored_enum_values: HashMap<PathBuf, super::super::lowering::EnumValues>,
}

struct FileAnalysis {
    authored_enum_values: (PathBuf, super::super::lowering::EnumValues),
    live: Option<(String, LiveModuleFacts)>,
    opaque_package_keys: HashSet<String>,
    bundler_raw: Option<(String, RawBundlerExportInfo)>,
    hoist: Option<(String, ModuleScan)>,
    extern_facts: Option<ExternFileFacts>,
    prelowered_names: BTreeSet<String>,
    pair_array_names: HashSet<String>,
}

struct PreludeInput<'a> {
    compiled: &'a HashSet<&'a str>,
    file_metadata: &'a HashMap<String, ClosureFileMetadata>,
    commonjs_specifiers: &'a HashSet<String>,
    package_aliases: &'a [PackageAliasInput],
    class_map_calls: &'a [ClassMapCallInput],
    resolution_context: &'a TranspileContext,
    need_live: bool,
    need_hoist: bool,
    need_pair_array: bool,
}

pub(super) struct AnalysisPreludeInput<'a> {
    pub(super) file_names: &'a [String],
    pub(super) compiled_file_names: &'a [String],
    pub(super) explicit_extern_paths: &'a [String],
    pub(super) chunk_mode: ChunkMode,
    pub(super) resolution_context: &'a TranspileContext,
    pub(super) file_metadata: &'a HashMap<String, ClosureFileMetadata>,
    pub(super) chunk_graph: &'a [TranspileChunkInput],
    pub(super) lazy_imports: &'a [LazyImportInput],
    pub(super) class_map_calls: &'a [ClassMapCallInput],
    pub(super) commonjs_specifiers: &'a HashSet<String>,
}

/// One parse per file for every pre-emit analysis visitor, then a deterministic merge.
pub(super) fn run_analysis_prelude(
    input: AnalysisPreludeInput<'_>,
) -> std::result::Result<AnalysisPrelude, String> {
    let AnalysisPreludeInput {
        file_names,
        compiled_file_names,
        explicit_extern_paths,
        chunk_mode,
        resolution_context,
        file_metadata,
        chunk_graph,
        lazy_imports,
        class_map_calls,
        commonjs_specifiers,
    } = input;
    let workspace_dir = &resolution_context.workspace_dir;
    let package_aliases = &resolution_context.package_aliases;
    let need_bundler = chunk_mode == ChunkMode::BundlerRuntime;
    let need_hoist = need_bundler && !chunk_graph.is_empty();
    let need_pair_array = class_map_calls
        .iter()
        .any(|call| call.key_source.as_deref() == Some("pairArray"));
    let compiled = compiled_file_names
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let input = PreludeInput {
        compiled: &compiled,
        file_metadata,
        commonjs_specifiers,
        package_aliases,
        class_map_calls,
        resolution_context,
        need_live: !need_bundler,
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
    let mut goog_live_modules = HashMap::new();
    let mut extern_files = Vec::new();
    let mut prelude_property_names = HashSet::new();
    let mut authored_enum_values = HashMap::new();
    // Metadata can describe preserved modules or files outside the source list.
    // Only these uncovered inputs need a standalone lowered-text parse.
    let covered_metadata = files
        .iter()
        .map(|file_name| closure_metadata_key(&PathBuf::from(file_name.as_str())))
        .collect::<HashSet<_>>();
    for (key, metadata) in file_metadata {
        if covered_metadata.contains(key) {
            continue;
        }
        if let Some(source) = metadata.decorated_output_text.as_deref() {
            let allocator = Allocator::default();
            let path = PathBuf::from(key).with_extension("js");
            let program = parse_oxc_program(&allocator, &path, source)?;
            prelude_property_names.extend(emit_helpers::collect_decorator_metadata_property_names(
                &program,
            ));
        }
    }
    for result in results {
        let analysis = result?;
        let (path, values) = analysis.authored_enum_values;
        authored_enum_values.insert(path, values);
        if let Some((module_id, live)) = analysis.live {
            goog_live_modules.insert(module_id, live);
        }
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

    resolve_live_module_facts(&mut goog_live_modules);
    let bundler_module_slots = resolve_bundler_module_slots(raw_exports_by_module)?;
    for (module_id, live) in &mut goog_live_modules {
        if let Some(slots) = bundler_module_slots.get(module_id) {
            live.names.retain(|name| slots.slot_for(name).is_some());
            live.locals.retain(|name, _| slots.slot_for(name).is_some());
        }
        if live.names.is_empty() {
            continue;
        }
        let mut names = super::super::fresh::FreshNameAllocator::default();
        if let Some(slots) = bundler_module_slots.get(module_id) {
            for name in slots.export_names() {
                names.try_reserve(name);
            }
        }
        for name in &live.names {
            names.try_reserve(&super::super::live_export_accessor_name(name));
        }
        live.namespace_export = names.fresh("__gccNamespace");
    }
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
        goog_live_modules,
        bundler_runtime_logical_ids,
        hoist_plan,
        opaque_commonjs: opaque_commonjs_from_package_keys(
            opaque_package_keys,
            commonjs_specifiers,
            package_aliases,
        ),
        extern_analysis: merge_extern_property_facts(extern_files, explicit_extern_paths)?,
        prelude_property_names,
        authored_enum_values,
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
    let authored_enum_values = (
        crate::pathing::normalize_path(&file_path),
        super::super::lowering::collect_enum_values(&authored_program),
    );
    let lowered_program =
        match metadata.and_then(|metadata| metadata.decorated_output_text.as_deref()) {
            Some(lowered_source) => Some(parse_oxc_program(
                &allocator,
                &file_path.with_extension("js"),
                lowered_source,
            )?),
            None => None,
        };
    let mut prelowered_names =
        emit_helpers::collect_decorator_metadata_property_names(&authored_program);
    if let Some(program) = &lowered_program {
        prelowered_names.extend(emit_helpers::collect_decorator_metadata_property_names(
            program,
        ));
    }
    let opaque_package_keys = collect_opaque_package_keys_from_program(
        &authored_program,
        &file_path,
        input.commonjs_specifiers,
        input.package_aliases,
    );
    if !input.compiled.contains(file_name) {
        return Ok(FileAnalysis {
            authored_enum_values,
            live: None,
            opaque_package_keys,
            bundler_raw: None,
            hoist: None,
            extern_facts: None,
            prelowered_names,
            pair_array_names: HashSet::new(),
        });
    }

    let live = if input.need_live {
        Some((
            to_goog_module_id(&file_path, &input.resolution_context.workspace_dir),
            collect_live_module_facts(&authored_program, &file_path, input.resolution_context)?,
        ))
    } else {
        None
    };
    let (bundler_raw, hoist) = {
        let emitted_program = lowered_program.as_ref().unwrap_or(&authored_program);
        let commonjs_analysis = analyze_commonjs_program(emitted_program);
        let topology = if should_normalize_commonjs(&file_path, &commonjs_analysis) {
            None
        } else {
            Some(collect_export_topology(
                emitted_program,
                &file_path,
                input.resolution_context,
            )?)
        };
        let bundler_raw = Some(collect_file_bundler_exports(
            emitted_program,
            &file_path,
            &input.resolution_context.workspace_dir,
            metadata,
            input.resolution_context,
            &commonjs_analysis,
            topology.as_ref(),
        )?);
        let hoist = if input.need_hoist {
            Some(scan_hoist_module(
                emitted_program,
                &file_path,
                &input.resolution_context.workspace_dir,
                metadata,
                input.resolution_context,
                &commonjs_analysis,
                topology,
            )?)
        } else {
            None
        };
        (bundler_raw, hoist)
    };
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
        authored_enum_values,
        live,
        opaque_package_keys,
        bundler_raw,
        hoist,
        extern_facts,
        prelowered_names,
        pair_array_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transpile::context::analysis_resolution_context;
    use crate::transpile::transform::transform_source_with_oxc;

    #[test]
    fn prelude_covers_authored_enums_and_all_decorator_metadata_inputs(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "gcc-prelude-facts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos(),
        ));
        fs::create_dir_all(&root)?;
        let compiled = root.join("compiled.ts");
        let preserved = root.join("preserved.ts");
        let fallback = root.join("fallback.js");
        fs::write(
            &compiled,
            "export const enum Dir { Up = 3 }; __decorate([], {}, 'authored');",
        )?;
        fs::write(&preserved, "export const preserved = true;")?;
        fs::write(&fallback, "export {};")?;
        fs::write(
            fallback.with_extension("d.ts"),
            "export declare const enum Fallback { Down = 7 }",
        )?;
        let metadata = [
            (
                &compiled,
                "__esDecorate(null, null, [], { name: 'compiled' });",
            ),
            (&preserved, "__decorate([], {}, 'preserved');"),
            (
                &root.join("metadata-only.ts"),
                "__decorate([], {}, 'metadataOnly');",
            ),
            (&root.join("ambient.d.ts"), "__decorate([], {}, 'ambient');"),
        ]
        .into_iter()
        .map(|(path, source)| {
            let metadata = serde_json::from_value(serde_json::json!({
                "filePath": path,
                "sourceFilePath": path,
                "decoratedOutputText": source,
            }))?;
            Ok((closure_metadata_key(path), metadata))
        })
        .collect::<Result<HashMap<_, _>, serde_json::Error>>()?;
        let file_names = vec![
            compiled.to_string_lossy().into_owned(),
            preserved.to_string_lossy().into_owned(),
            root.join("ambient.d.ts").to_string_lossy().into_owned(),
        ];
        let compiled_file_names = vec![file_names[0].clone()];
        let mut context = analysis_resolution_context(&root, &[], &HashMap::new());
        let prelude = run_analysis_prelude(AnalysisPreludeInput {
            file_names: &file_names,
            compiled_file_names: &compiled_file_names,
            explicit_extern_paths: &[],
            chunk_mode: ChunkMode::BundlerRuntime,
            resolution_context: &context,
            file_metadata: &metadata,
            chunk_graph: &[],
            lazy_imports: &[],
            class_map_calls: &[],
            commonjs_specifiers: &HashSet::new(),
        })?;
        context.authored_enum_values = prelude.authored_enum_values;
        context.preserved_property_names = prelude.prelude_property_names;
        context.chunk_mode = ChunkMode::Off;
        let source = r#"
            import { Dir as D } from "./compiled";
            import { Fallback } from "./fallback.js";
            const host = { authored: 1, compiled: 2, preserved: 3, metadataOnly: 4, ambient: 5 };
            export const probe = [
                D.Up, ((D: any) => D.Up)({ Up: 9 }), Fallback.Down,
                host.authored, host.compiled, host.preserved, host.metadataOnly, host.ambient
            ];
        "#;
        let path = root.join("entry.ts");
        let emitted = transform_source_with_oxc(&path, source, &context, None, &path)?;
        for name in [
            "authored",
            "compiled",
            "preserved",
            "metadataOnly",
            "ambient",
        ] {
            assert!(
                emitted.code.contains(&format!("[\"{name}\"]")),
                "{}",
                emitted.code
            );
        }
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "--eval"])
            .arg(format!(
                "let exports = {{}}; const goog = {{ module() {{}} }};\n{}\nconsole.log(JSON.stringify(exports.probe));",
                emitted.code,
            ))
            .output()?;
        fs::remove_dir_all(&root)?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "[3,9,7,1,2,3,4,5]"
        );
        Ok(())
    }
}
