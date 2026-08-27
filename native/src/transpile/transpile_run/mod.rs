use std::fs;
use std::path::{Path, PathBuf};

use crate::pathing::normalize_path;

use super::compat::validate_class_map_calls;
use super::napi::{
    ClassMapCallInput, ExternalBoundaryInput, LazyImportInput, PackageAliasInput,
    PreservedModuleInput, ResolvedImportInput, TranspileChunkInput, TranspileOutput,
};
use super::transpile_plan::append_extension;
use super::transpile_write::emit_and_write_transpile_outputs;

mod context;
mod maps;
mod prelude;
mod preserved;
mod properties;

pub(crate) use self::context::{build_transpile_context, TranspileRunContext};

pub(crate) fn resolve_relative_module(file_path: &Path, specifier: &str) -> Option<PathBuf> {
    let base = normalize_path(&file_path.parent()?.join(specifier));
    let candidates = if base.extension().is_some() {
        match base
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
        {
            "js" => vec![
                base.clone(),
                base.with_extension("ts"),
                base.with_extension("tsx"),
                base.with_extension("mts"),
                base.with_extension("cjs"),
                base.with_extension("cts"),
                base.with_extension("jsx"),
                base.with_extension("mjs"),
            ],
            "cjs" => vec![
                base.clone(),
                base.with_extension("js"),
                base.with_extension("ts"),
                base.with_extension("cts"),
            ],
            _ => vec![
                base.clone(),
                append_extension(&base, "ts"),
                append_extension(&base, "tsx"),
                append_extension(&base, "js"),
                append_extension(&base, "jsx"),
            ],
        }
    } else {
        ["ts", "tsx", "mts", "js", "cjs", "cts", "jsx", "mjs"]
            .into_iter()
            .map(|extension| base.with_extension(extension))
            .chain(
                [
                    "index.ts",
                    "index.tsx",
                    "index.mts",
                    "index.js",
                    "index.cjs",
                    "index.cts",
                    "index.jsx",
                    "index.mjs",
                ]
                .into_iter()
                .map(|file| base.join(file)),
            )
            .collect()
    };
    candidates.into_iter().find(|candidate| candidate.exists())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_transpile_sources(
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
    validate_class_map_calls(&class_map_calls)?;
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let TranspileRunContext {
        compiled_file_names,
        context,
        program_declared_names,
        explicit_extern_property_count,
    } = build_transpile_context(
        file_names,
        explicit_extern_paths,
        metadata_path,
        chunk_mode,
        target,
        workspace_dir,
        package_aliases,
        resolved_imports,
        external_boundaries,
        opaque_external_specifiers,
        preserved_modules,
        lazy_imports,
        &chunk_graph,
        class_map_calls,
        pure_callees,
        type_inference_disabled,
    )?;
    emit_and_write_transpile_outputs(
        &compiled_file_names,
        &context,
        &chunk_graph,
        Path::new(&out_dir),
        &program_declared_names,
        explicit_extern_property_count,
        externs_path,
        runtime_module_source_map_file,
        &package_json_files,
    )
}
