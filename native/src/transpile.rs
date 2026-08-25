#![allow(non_snake_case)]

pub(crate) mod assigners;
mod cjs_opacity;
mod commonjs;
mod compat;
mod compat_properties;
mod context;
mod emit;
mod emit_goog;
pub(crate) mod emit_helpers;
mod emit_hoist;
mod emit_reflective;
mod emit_runtime;
mod externs;
mod fresh;
mod global_this;
mod hoist;
mod identity;
mod imports_exports;
mod js_compat;
mod lowering;
mod namespace;
mod napi;
mod nocollapse;
mod pure_calls;
mod quote_keys;
mod transform;
mod transpile_plan;
mod transpile_run;
mod transpile_write;

mod type_metadata;
mod type_metadata_oxc;

pub(crate) use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
pub(crate) use std::path::{Path, PathBuf};

pub(crate) use crate::closure_metadata::{
    closure_metadata_key, ClosureEnumDeclaration, ClosureFileMetadata, EmittedTypeMetadata,
};
pub(crate) use crate::pathing::{normalize_path, to_bundler_runtime_module_id, to_goog_module_id};

pub(crate) use self::cjs_opacity::*;
pub(crate) use self::compat::*;
pub(crate) use self::context::*;
pub(crate) use self::emit::*;

pub(crate) use self::externs::*;
pub(crate) use self::hoist::*;
pub(crate) use self::imports_exports::*;
pub(crate) use self::js_compat::*;
pub(crate) use self::transpile_plan::{
    append_extension, collect_assigner_pin_module_ids, collect_decorated_metadata_property_names,
    collect_pair_array_property_names, collect_prelowered_decorator_property_names,
    group_lazy_imports_by_file, parse_oxc_program, plan_shared_helper_placement,
    transform_source_file,
};
pub(crate) use self::transpile_run::resolve_relative_module;
pub use napi::*;

pub fn emit_preserved_module(file_path: String, source: String) -> Result<String, String> {
    lowering::emit_preserved_module(Path::new(&file_path), &source)
}

// napi positional contract: the TS side calls these by argument
// position, so the parameter list is the published signature.
#[allow(clippy::too_many_arguments)]
pub fn transpile_sources(
    file_names: Vec<String>,
    explicit_extern_paths: Vec<String>,
    out_dir: String,
    externs_path: String,
    metadata_path: String,
    chunk_mode: String,
    target: String,
    runtime_module_source_map_file: Option<String>,
    workspace_dir: String,
    package_aliases: Vec<PackageAliasInput>,
    resolved_imports: Vec<ResolvedImportInput>,
    external_boundaries: Vec<ExternalBoundaryInput>,
    opaque_external_specifiers: Vec<String>,
    package_json_files: Vec<String>,
    preserved_modules: Vec<PreservedModuleInput>,
    lazy_imports: Vec<LazyImportInput>,
    chunk_graph: Vec<TranspileChunkInput>,
    class_map_calls: Vec<ClassMapCallInput>,
    pure_callees: Vec<String>,
    type_inference_disabled: bool,
) -> std::result::Result<TranspileOutput, String> {
    transpile_run::run_transpile_sources(
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
    )
}
