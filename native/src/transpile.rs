#![allow(non_snake_case)]

mod commonjs;
mod compat;
mod context;
mod emit;
mod emit_goog;
mod emit_runtime;
mod enums;
mod externs;
mod global_this;
mod imports_exports;
mod js_compat;
mod namespace;
mod print;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::mem;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rayon::prelude::*;
use swc_core::common::{sync::Lrc, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::{
    ArrowExpr, BindingIdent, BlockStmt, BlockStmtOrExpr, Bool, CallExpr, Callee, EmptyStmt, Expr,
    ExprStmt, Id, Ident, ImportDecl, ImportDefaultSpecifier, ImportSpecifier, Lit, MemberExpr,
    MemberProp, Module, ModuleItem, Pass, Pat, Program, PropName, Stmt, Str, SuperProp,
    TsEnumMemberId, UnaryExpr, UnaryOp, VarDecl, VarDeclKind, VarDeclarator,
};
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_react::{jsx, Options as ReactOptions, Runtime as ReactRuntime};
use swc_ecma_transforms_typescript::strip;

use crate::closure_metadata::{
    load_closure_metadata, ClosureEnumDeclaration, ClosureFileMetadata, ClosureTopLevelDoc,
};
use crate::commonjs::{analyze_commonjs_module, evaluate_boolean_expr};
use crate::module_cache::{get_or_parse_cached_module, parse_module};
use crate::pathing::{normalize_path, to_bundler_runtime_module_id, to_goog_module_id};
use crate::support_files::{collect_commonjs_specifiers, emit_package_support_files};

use self::commonjs::*;
use self::compat::*;
pub(crate) use self::context::ChunkMode;
use self::context::*;
use self::emit::*;
use self::emit_goog::*;
use self::emit_runtime::*;
use self::enums::*;
use self::externs::*;
use self::global_this::*;
use self::imports_exports::*;
use self::js_compat::*;
use self::namespace::*;
use self::print::*;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub externsPath: String,
    pub supportFiles: Vec<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasInput {
    pub packageName: String,
    pub subpath: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LazyImportInput {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

pub fn transpile_sources(
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    metadata_path: String,
    chunk_mode: String,
    workspace_dir: String,
    package_aliases: Vec<PackageAliasInput>,
    package_json_files: Vec<String>,
    lazy_imports: Vec<LazyImportInput>,
) -> std::result::Result<TranspileOutput, String> {
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let chunk_mode = parse_chunk_mode(&chunk_mode)?;
    let bundler_module_slots = if chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(&file_names, &workspace_dir, &package_aliases)?
    } else {
        HashMap::new()
    };
    let bundler_runtime_logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect::<HashMap<_, _>>();
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let global_property_names = collect_global_property_names(&file_names)?;
    let ExternPropertyAnalysis {
        preserved_property_names,
        static_property_names,
    } = collect_extern_property_names(&file_names, &global_property_names)?;
    let context = TranspileContext {
        bundler_module_slots,
        bundler_runtime_logical_ids,
        chunk_mode,
        commonjs_specifiers: collect_commonjs_specifiers(&package_aliases)?
            .into_iter()
            .collect(),
        file_metadata,
        global_property_names,
        lazy_imports_by_file: group_lazy_imports_by_file(lazy_imports),
        package_aliases,
        preserved_property_names,
        static_property_names,
        workspace_dir: workspace_dir.clone(),
    };

    let emitted_outputs = file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let code = GLOBALS.set(&Globals::new(), || {
                let code = transform_source_file(&file_path, &context)?;
                Ok::<_, String>(code)
            })?;

            Ok::<_, String>((output_path, code))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    fs::write(
        &externs_path,
        render_generated_externs(
            &context.global_property_names,
            &context.static_property_names,
        ),
    )
    .map_err(|error| error.to_string())?;

    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    for (output_path, code) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&output_path, code).map_err(|error| error.to_string())?;
        emitted_files.push(output_path.to_string_lossy().to_string());
    }

    emitted_files.sort();
    let support_files = emit_package_support_files(
        &out_dir,
        &workspace_dir,
        chunk_mode,
        &context.package_aliases,
        &package_json_files,
    )?;
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        externsPath: externs_path,
        supportFiles: support_files,
    })
}

fn transform_source_file(
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<String, String> {
    let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let file_metadata = context
        .file_metadata
        .get(&file_path.to_string_lossy().to_string())
        .cloned();
    let module = if let Some(decorated_output_text) = file_metadata
        .as_ref()
        .and_then(|metadata| metadata.decorated_output_text.clone())
    {
        parse_module(&file_path.with_extension("js"), &decorated_output_text)?
    } else {
        get_or_parse_cached_module(&file_path.to_path_buf())?
    };
    let commonjs_analysis = analyze_commonjs_module(&module);

    if should_normalize_commonjs(file_path, &commonjs_analysis) {
        return normalize_commonjs_module(
            module,
            &commonjs_analysis,
            file_path,
            context,
            file_metadata.as_ref(),
        );
    }

    let program = if should_run_resolver(file_path) {
        transform_program(module, file_path, context, file_metadata.as_ref())?
    } else {
        transform_js_pass_through_program(module, source_text, file_path, context)
    };
    emit_module_program(file_path, program, context, file_metadata.as_ref(), None)
}

fn is_typescript_source_file(file_path: &Path) -> bool {
    matches!(
        file_path.extension().and_then(|value| value.to_str()),
        Some("ts") | Some("tsx") | Some("mts")
    ) && !file_path.to_string_lossy().ends_with(".d.ts")
}

fn should_run_resolver(file_path: &Path) -> bool {
    is_typescript_source_file(file_path)
}

fn should_run_react_transform(file_path: &Path) -> bool {
    matches!(
        file_path.extension().and_then(|value| value.to_str()),
        Some("tsx") | Some("jsx")
    )
}

#[cfg(test)]
mod tests;
