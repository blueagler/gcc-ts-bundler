#![allow(non_snake_case)]

pub(crate) mod assigners;
mod assigners_oxc;
mod cjs_opacity;
mod commonjs;
pub(crate) mod compat;
mod context;
mod emit;
mod emit_goog;
mod emit_helpers;
mod emit_hoist;
mod emit_reflective;
pub(crate) mod emit_runtime;
mod emit_runtime_oxc;
mod enums;
mod externs;
pub(crate) mod fresh;
mod fresh_oxc;
mod global_this;
mod hoist;
mod hoist_oxc;
mod identity;
mod identity_oxc;
mod lowering_oxc;
mod global_this_oxc;
mod imports_exports;
mod js_compat;
mod namespace;
mod precedence;
mod print;
mod pure_calls;
mod type_metadata;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::mem;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rayon::prelude::*;
use swc_core::common::{sync::Lrc, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::{
    ArrowExpr, BindingIdent, BlockStmt, BlockStmtOrExpr, Bool, CallExpr, Callee, EmptyStmt, Expr,
    ExprStmt, Ident, ImportDecl, ImportDefaultSpecifier, ImportSpecifier, Lit, MemberExpr,
    MemberProp, Module, ModuleItem, Pass, Pat, Program, PropName, Stmt, Str, SuperProp,
    TsEnumMemberId, UnaryExpr, UnaryOp, VarDecl, VarDeclKind, VarDeclarator,
};
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_react::{jsx, Options as ReactOptions, Runtime as ReactRuntime};
use swc_ecma_transforms_typescript::strip;

use crate::closure_metadata::{
    closure_metadata_key, load_closure_metadata, ClosureEnumDeclaration, ClosureFileMetadata,
    EmittedTypeMetadata,
};
use crate::commonjs::{analyze_commonjs_module, evaluate_boolean_expr};
use crate::module_cache::{parse_module, parse_source_file};
use crate::pathing::{
    is_vendor_chunk_name, normalize_path, to_bundler_runtime_module_id, to_goog_module_id,
};
use crate::support_files::{collect_commonjs_specifiers, emit_package_support_files};

use self::cjs_opacity::*;
use self::commonjs::*;
use self::compat::*;
pub(crate) use self::context::ChunkMode;
use self::context::*;
use self::emit::*;
use self::emit_goog::*;
use self::emit_hoist::*;
use self::emit_runtime::*;
use self::enums::*;
use self::externs::*;
use self::fresh::*;
use self::global_this::*;
use self::hoist::*;
pub(crate) use self::identity::*;
use self::imports_exports::*;
use self::js_compat::*;
use self::namespace::*;
use self::print::*;
use self::type_metadata::*;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub explicitExternPropertyCount: u32,
    pub externsPath: String,
    pub preservedPropertyCount: u32,
    pub supportFiles: Vec<String>,
    pub typeMetadata: Vec<EmittedTypeMetadata>,
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
pub struct ResolvedImportInput {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
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

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct TranspileChunkInput {
    /// Names of the chunks the loader guarantees have executed before this
    /// one. Read by `build_hoist_plan` to decide whether a cross-chunk direct
    /// binding is legal.
    pub dependencies: Vec<String>,
    pub files: Vec<String>,
    pub name: String,
}

/// A runtime call whose object-literal argument keys must survive property
/// renaming (framework class-map/vnode helpers). Supplied by framework
/// presets. When `keyPattern` is set, only matching keys are quoted.
#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClassMapCallInput {
    pub argIndex: u32,
    pub callee: String,
    /// Keys matching this regex are left alone even when `keyPattern`
    /// admits them.
    pub keyExcludePattern: Option<String>,
    pub keyPattern: Option<String>,
    /// When set, the rule applies only if the argument at this index is a
    /// string literal or an immutable value produced by another matching
    /// literal-gated call. This lets element transforms such as cloneElement
    /// inherit proven host-element provenance without freezing component props.
    pub stringLiteralArgIndex: Option<u32>,
    /// When set, the rule matches only when the callee binding was imported
    /// from a module whose specifier matches this regex. Callee spelling is
    /// local and meaningless for default imports and compiler-generated
    /// aliases, so import identity is what a rule can rely on.
    pub calleeModulePattern: Option<String>,
    /// Where the keys of the pinned map live in the matched argument:
    ///
    /// * `"objectLiteral"` (default) - keys of an object literal argument;
    /// * `"pairArray"` - first elements of the entries of an array-literal
    ///   argument, the `[["render", fn], ["__scopeId", id]]` shape helper
    ///   functions splat onto a target with `target[key] = value`.
    pub keySource: Option<String>,
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
    runtime_module_source_map_file: Option<String>,
    workspace_dir: String,
    package_aliases: Vec<PackageAliasInput>,
    resolved_imports: Vec<ResolvedImportInput>,
    package_json_files: Vec<String>,
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
    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let chunk_mode = parse_chunk_mode(&chunk_mode)?;
    let resolved_module_ids = resolved_imports
        .into_iter()
        .map(|resolved| {
            (
                resolved_import_key(Path::new(&resolved.importerFilePath), &resolved.specifier),
                resolved.moduleId,
            )
        })
        .collect::<HashMap<_, _>>();
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let bundler_module_slots = if chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(
            &file_names,
            &workspace_dir,
            &package_aliases,
            &resolved_module_ids,
            &file_metadata,
        )?
    } else {
        HashMap::new()
    };
    let bundler_runtime_logical_ids = bundler_module_slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect::<HashMap<_, _>>();
    let hoist_plan = if chunk_mode == ChunkMode::BundlerRuntime {
        build_hoist_plan(
            &file_names,
            &workspace_dir,
            &package_aliases,
            &resolved_module_ids,
            &chunk_graph,
            &lazy_imports,
            &file_metadata,
        )?
    } else {
        None
    };
    let ExternPropertyAnalysis {
        program_declared_names,
        explicit_extern_property_names,
        mut preserved_property_names,
        static_property_names,
    } = collect_extern_property_names_with_externs(&file_names, &explicit_extern_paths)?;
    // Decorator metadata carries property keys as string literals; preserving
    // those keys keeps the literals valid instead of rewriting Closure output.
    preserved_property_names.extend(collect_decorated_metadata_property_names(&file_metadata)?);
    // Inputs can also arrive already lowered by another tool (Vite lowers
    // `experimentalDecorators` before this stage sees the module), in which
    // case there is no decorator metadata and the literals live in the source
    // itself: `__decorateClass([property(...)], MyElement.prototype, "count")`.
    preserved_property_names.extend(collect_prelowered_decorator_property_names(&file_names)?);
    // `classMapCalls` rules with `keySource: "pairArray"` pin keys that a
    // helper splats onto a target by string while the runtime reads them as
    // dot properties.
    preserved_property_names.extend(collect_pair_array_property_names(
        &file_names,
        &class_map_calls,
    )?);
    if type_inference_disabled {
        // The escape hatch omits @enum metadata, so keep emitted TS enum keys stable.
        preserved_property_names.extend(
            file_metadata
                .values()
                .flat_map(|metadata| metadata.enums.iter())
                .flat_map(|enum_decl| enum_decl.members.iter())
                .map(|member| member.name.clone()),
        );
    }
    let commonjs_specifiers = collect_commonjs_specifiers(&package_aliases)?
        .into_iter()
        .collect::<HashSet<_>>();
    let lazy_target_module_ids = lazy_imports
        .iter()
        .map(|lazy_import| lazy_import.moduleId.clone())
        .collect::<HashSet<_>>();
    let context = TranspileContext {
        bundler_module_slots,
        bundler_runtime_logical_ids,
        chunk_mode,
        class_map_calls,
        pure_callees: pure_callees.into_iter().collect(),
        commonjs_specifiers: commonjs_specifiers.clone(),
        opaque_commonjs: std::sync::Arc::new(collect_opaque_commonjs(
            &file_names,
            &commonjs_specifiers,
            &package_aliases,
        )?),
        file_metadata,
        hoist_plan: hoist_plan.map(std::sync::Arc::new),
        lazy_imports_by_file: group_lazy_imports_by_file(lazy_imports),
        lazy_target_module_ids,
        package_aliases,
        resolved_module_ids,
        preserved_property_names,
        static_property_names,
        type_metadata_enabled: !type_inference_disabled,
        vendor_module_ids: collect_vendor_module_ids(&chunk_graph, &workspace_dir),
        workspace_dir: workspace_dir.clone(),
    };
    let emitted_outputs = file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let emitted = GLOBALS.set(&Globals::new(), || {
                let emitted = transform_source_file(&file_path, &context)?;
                Ok::<_, String>(emitted)
            })?;

            Ok::<_, String>((file_path, output_path, emitted))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Reflective `for...in` keys are property names read as data. Preserving
    // them is what replaces the post-Closure string rewrite that used to
    // respell them (and everything that looked like them) from the
    // property-renaming report.
    let mut preserved_property_names = context.preserved_property_names.clone();
    for (_, _, emitted) in &emitted_outputs {
        preserved_property_names.extend(emitted.reflective_property_names.iter().cloned());
    }
    // Ambient globals ride the metadata channel: an ambient `.d.ts` that
    // nothing imports never enters the module graph, so this is the only place
    // both the declaration and the extern writer are in scope. Names the
    // program declares itself are excluded — those are program code.
    let ambient_global_names = context
        .file_metadata
        .values()
        .flat_map(|metadata| metadata.ambient_globals.iter().cloned())
        .filter(|name| !program_declared_names.contains(name))
        .collect::<HashSet<_>>();
    fs::write(
        &externs_path,
        render_generated_externs(
            &preserved_property_names,
            &context.static_property_names,
            &ambient_global_names,
        ),
    )
    .map_err(|error| error.to_string())?;

    let shared_helper_prefixes =
        plan_shared_helper_placement(&emitted_outputs, &chunk_graph, &out_dir, &workspace_dir);

    let mut runtime_module_source_map = BTreeMap::new();
    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    let mut emitted_type_metadata = Vec::with_capacity(emitted_outputs.len());
    for (file_path, output_path, emitted) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let code = match shared_helper_prefixes.get(&output_path) {
            Some(prefix) => format!("{prefix}\n{}", emitted.code),
            None => emitted.code,
        };
        fs::write(&output_path, code).map_err(|error| error.to_string())?;
        if runtime_module_source_map_file.is_some() {
            let runtime_module_id =
                to_bundler_runtime_module_id(&to_goog_module_id(&output_path, &out_dir));
            runtime_module_source_map.insert(
                runtime_module_id,
                normalize_path(&file_path).to_string_lossy().to_string(),
            );
        }
        let emitted_file = output_path.to_string_lossy().to_string();
        emitted_type_metadata.push(EmittedTypeMetadata::new(
            emitted_file.clone(),
            emitted.type_metadata.counts,
            emitted.type_metadata.diagnostics,
        ));
        emitted_files.push(emitted_file);
    }

    if let Some(mapping_file) = runtime_module_source_map_file {
        let mapping_path = if Path::new(&mapping_file).is_absolute() {
            PathBuf::from(mapping_file)
        } else {
            out_dir.join(mapping_file)
        };
        if let Some(parent) = mapping_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mapping_text = serde_json::to_string_pretty(&runtime_module_source_map)
            .map_err(|error| error.to_string())?;
        fs::write(&mapping_path, format!("{mapping_text}\n")).map_err(|error| error.to_string())?;
    }

    emitted_files.sort();
    emitted_type_metadata.sort_by(|left, right| left.emittedFile.cmp(&right.emittedFile));
    let support_files = emit_package_support_files(
        &out_dir,
        &workspace_dir,
        chunk_mode,
        &context.package_aliases,
        &package_json_files,
    )?;
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        explicitExternPropertyCount: explicit_extern_property_names.len() as u32,
        externsPath: externs_path,
        preservedPropertyCount: preserved_property_names.len() as u32,
        supportFiles: support_files,
        typeMetadata: emitted_type_metadata,
    })
}

/// Places each pooled lowering-helper declaration exactly once.
///
/// A helper claimed by a single module stays in that module, where Closure can
/// still inline it locally. A helper claimed by two or more modules moves to
/// the first file of the first chunk — the chunk every other chunk transitively
/// depends on — so one definition dominates every use. Closure compiles all
/// chunks as one job and sinks the definition again if only one chunk uses it.
fn plan_shared_helper_placement(
    emitted_outputs: &[(PathBuf, PathBuf, EmittedProgram)],
    chunk_graph: &[TranspileChunkInput],
    out_dir: &Path,
    workspace_dir: &Path,
) -> HashMap<PathBuf, String> {
    let mut claims: BTreeMap<String, (String, BTreeSet<PathBuf>)> = BTreeMap::new();
    for (_, output_path, emitted) in emitted_outputs {
        for helper in &emitted.shared_helpers {
            let entry = claims
                .entry(helper.canonical_name.clone())
                .or_insert_with(|| (helper.text.clone(), BTreeSet::new()));
            entry.1.insert(output_path.clone());
        }
    }
    if claims.is_empty() {
        return HashMap::new();
    }

    let program_owner = chunk_graph
        .first()
        .and_then(|chunk| chunk.files.first())
        .map(|relative_file| {
            out_dir
                .join(
                    Path::new(relative_file)
                        .strip_prefix(workspace_dir)
                        .unwrap_or(Path::new(relative_file)),
                )
                .with_extension("js")
        });

    let mut prefixes: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for (_, (text, claimants)) in claims {
        let owner = if claimants.len() == 1 {
            claimants.into_iter().next()
        } else {
            program_owner
                .clone()
                .or_else(|| claimants.into_iter().next())
        };
        if let Some(owner) = owner {
            prefixes.entry(owner).or_default().push(text);
        }
    }
    prefixes
        .into_iter()
        .map(|(path, texts)| (path, texts.join("\n")))
        .collect()
}

/// Property keys embedded as string literals by TypeScript decorator lowering.
///
/// Collected from the lowered text TypeScript produced, keyed on the helper
/// name TypeScript emitted, before any optimization runs.
fn collect_decorated_metadata_property_names(
    file_metadata: &HashMap<String, ClosureFileMetadata>,
) -> std::result::Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for (metadata_key, metadata) in file_metadata {
        let Some(lowered_source) = metadata.decorated_output_text.as_deref() else {
            continue;
        };
        let module = parse_module(
            &PathBuf::from(metadata_key).with_extension("js"),
            lowered_source,
        )?;
        names.extend(emit_helpers::collect_decorator_metadata_property_names(
            &module,
        ));
    }
    Ok(names)
}

/// Property keys embedded as string literals by decorator lowering that ran
/// before this stage (Vite/esbuild/oxc lower `experimentalDecorators` during
/// their own transform, so no decorator metadata reaches us).
fn collect_prelowered_decorator_property_names(
    file_names: &[String],
) -> std::result::Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let module = parse_source_file(Path::new(file_name))?;
        names.extend(emit_helpers::collect_decorator_metadata_property_names(
            &module,
        ));
    }
    Ok(names)
}

/// Module ids the chunk plan placed in the vendor chunk.
///
/// Only the chunk name and its file list cross the napi boundary, so the name
/// is how a vendor chunk is recognised here; `pathing::VENDOR_CHUNK_NAME_SUFFIX`
/// is shared with the planner that mints it so the two cannot drift.
fn collect_vendor_module_ids(
    chunk_graph: &[TranspileChunkInput],
    workspace_dir: &Path,
) -> HashSet<String> {
    chunk_graph
        .iter()
        .filter(|chunk| is_vendor_chunk_name(&chunk.name))
        .flat_map(|chunk| chunk.files.iter())
        .map(|relative_file| to_goog_module_id(&workspace_dir.join(relative_file), workspace_dir))
        .collect()
}

fn transform_source_file(
    file_path: &Path,
    context: &TranspileContext,
) -> std::result::Result<EmittedProgram, String> {
    let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let file_metadata = context
        .file_metadata
        .get(&closure_metadata_key(file_path))
        .cloned();
    let module = if let Some(decorated_output_text) = file_metadata
        .as_ref()
        .and_then(|metadata| metadata.decorated_output_text.clone())
    {
        parse_module(&file_path.with_extension("js"), &decorated_output_text)?
    } else {
        parse_source_file(file_path)?
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
mod regression_tests;

#[cfg(test)]
mod tests;

/// Property names pinned by pair-array `classMapCalls` rules across all inputs.
fn collect_pair_array_property_names(
    file_names: &[String],
    class_map_calls: &[ClassMapCallInput],
) -> std::result::Result<BTreeSet<String>, String> {
    if class_map_calls
        .iter()
        .all(|call| call.keySource.as_deref() != Some("pairArray"))
    {
        return Ok(BTreeSet::new());
    }
    let mut names = BTreeSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let module = parse_source_file(Path::new(file_name))?;
        names.extend(collect_pair_array_class_map_property_names(
            &module,
            class_map_calls,
        )?);
    }
    Ok(names)
}
