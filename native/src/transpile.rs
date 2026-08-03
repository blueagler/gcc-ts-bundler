#![allow(non_snake_case)]

pub(crate) mod assigners;
mod assigners_oxc;
mod cjs_opacity;
mod commonjs_oxc;
mod compat;
mod compat_properties_oxc;
mod context;
mod emit;
mod emit_goog_oxc;
mod emit_helpers;
mod emit_helpers_oxc;
mod emit_hoist_oxc;
mod emit_reflective_oxc;
mod emit_runtime_oxc;
mod externs;
mod fresh_oxc;
mod global_this_oxc;
mod hoist;
mod hoist_oxc;
mod identity_oxc;
mod imports_exports;
mod js_compat;
mod js_compat_oxc;
mod lowering_oxc;
mod namespace;
mod nocollapse_oxc;
mod print;
mod pure_calls;
mod type_metadata;
mod type_metadata_oxc;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rayon::prelude::*;

use crate::closure_metadata::{
    closure_metadata_key, load_closure_metadata, ClosureEnumDeclaration, ClosureFileMetadata,
    EmittedTypeMetadata,
};
use crate::commonjs::analyze_commonjs_source;
use crate::pathing::{
    is_vendor_chunk_name, normalize_path, to_bundler_runtime_module_id, to_goog_module_id,
};
use crate::support_files::{collect_commonjs_specifiers, emit_package_support_files};

use self::cjs_opacity::*;
use self::compat::*;
pub(crate) use self::context::ChunkMode;
use self::context::*;
use self::emit::*;
use self::externs::*;
use self::hoist::*;
use self::imports_exports::*;
use self::js_compat::*;
use self::print::*;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub explicitExternPropertyCount: u32,
    pub externsPath: String,
    pub preservedImports: Vec<PreservedImportOutput>,
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
pub struct PreservedModuleInput {
    pub exportNames: Vec<String>,
    pub filePath: String,
    pub hasDefaultExport: bool,
    pub moduleId: String,
    pub outputRelativePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedImportOutput {
    pub boundaryExports: Vec<String>,
    pub boundaryNames: Vec<String>,
    pub externalSpecifier: Option<String>,
    pub importClause: String,
    pub importerFilePath: String,
    pub targetModuleId: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ExternalBoundaryInput {
    pub importerFilePath: String,
    pub specifier: String,
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

pub fn strip_typescript_module(file_path: String, source: String) -> Result<String, String> {
    lowering_oxc::strip_typescript_module(Path::new(&file_path), &source)
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
    validate_class_map_calls(&class_map_calls)?;
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let chunk_mode = parse_chunk_mode(&chunk_mode)?;
    let preserved_modules = preserved_modules
        .into_iter()
        .map(|module| (module.moduleId.clone(), module))
        .collect::<HashMap<_, _>>();
    let preserved_file_paths = preserved_modules
        .values()
        .map(|module| {
            normalize_path(Path::new(&module.filePath))
                .to_string_lossy()
                .to_string()
        })
        .collect::<HashSet<_>>();
    let compiled_file_names = file_names
        .iter()
        .filter(|file_name| {
            !preserved_file_paths.contains(
                &normalize_path(Path::new(file_name))
                    .to_string_lossy()
                    .to_string(),
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let resolved_module_ids = resolved_imports
        .into_iter()
        .map(|resolved| {
            (
                resolved_import_key(Path::new(&resolved.importerFilePath), &resolved.specifier),
                resolved.moduleId,
            )
        })
        .collect::<HashMap<_, _>>();
    let external_specifiers = external_boundaries
        .into_iter()
        .map(|boundary| {
            (
                resolved_import_key(Path::new(&boundary.importerFilePath), &boundary.specifier),
                boundary.specifier,
            )
        })
        .collect::<HashMap<_, _>>();
    let preserves_node_import_meta = target == "node";
    let file_metadata = load_closure_metadata(&metadata_path)?;
    let bundler_module_slots = if chunk_mode == ChunkMode::BundlerRuntime {
        collect_bundler_module_slots(
            &compiled_file_names,
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
            &compiled_file_names,
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
    } = collect_extern_property_names_with_externs(&compiled_file_names, &explicit_extern_paths)?;
    // Decorator metadata carries property keys as string literals; preserving
    // those keys keeps the literals valid instead of rewriting Closure output.
    preserved_property_names.extend(collect_decorated_metadata_property_names(&file_metadata)?);
    // Inputs can also arrive already lowered by another tool (Vite lowers
    // `experimentalDecorators` before this stage sees the module), in which
    // case there is no decorator metadata and the literals live in the source
    // itself: `__decorateClass([property(...)], MyElement.prototype, "count")`.
    preserved_property_names.extend(collect_prelowered_decorator_property_names(
        &compiled_file_names,
    )?);
    // `classMapCalls` rules with `keySource: "pairArray"` pin keys that a
    // helper splats onto a target by string while the runtime reads them as
    // dot properties.
    preserved_property_names.extend(collect_pair_array_property_names(
        &compiled_file_names,
        &class_map_calls,
    )?);
    if preserves_node_import_meta {
        // `import.meta` is a host-provided Node ESM object. Quote its standard
        // `url` member before Closure so the envelope contract survives ADVANCED.
        preserved_property_names.insert("url".to_string());
    }
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
        vendor_module_ids: collect_vendor_module_ids(&chunk_graph, &workspace_dir),
        workspace_dir: workspace_dir.clone(),
    };
    let emitted_outputs = compiled_file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let emitted = transform_source_file(&file_path, &context)?;

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
    let mut externs_text = render_generated_externs(
        &preserved_property_names,
        &context.static_property_names,
        &ambient_global_names,
    );
    let preserved_extern_lines = emitted_outputs
        .iter()
        .flat_map(|(_, _, emitted)| emitted.preserved_extern_lines.iter().cloned())
        .collect::<BTreeSet<_>>();
    if !preserved_extern_lines.is_empty() {
        externs_text.push_str("\n// Preserved ESM import bindings.\n");
        externs_text.push_str(
            &preserved_extern_lines
                .into_iter()
                .collect::<Vec<_>>()
                .join("\n"),
        );
        externs_text.push('\n');
    }
    fs::write(&externs_path, externs_text).map_err(|error| error.to_string())?;

    let shared_helper_prefixes =
        plan_shared_helper_placement(&emitted_outputs, &chunk_graph, &out_dir, &workspace_dir);

    let mut runtime_module_source_map = BTreeMap::new();
    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    let mut emitted_type_metadata = Vec::with_capacity(emitted_outputs.len());
    let mut preserved_imports = Vec::new();
    for (file_path, output_path, emitted) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        preserved_imports.extend(emitted.preserved_imports.iter().map(|import| {
            PreservedImportOutput {
                boundaryExports: import.boundary_exports.clone(),
                boundaryNames: import.boundary_names.clone(),
                externalSpecifier: import.external_specifier.clone(),
                importClause: import.import_clause.clone(),
                importerFilePath: file_path.to_string_lossy().to_string(),
                targetModuleId: import.target_module_id.clone(),
            }
        }));
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
    preserved_imports.sort_by(|left, right| {
        left.importerFilePath
            .cmp(&right.importerFilePath)
            .then(left.targetModuleId.cmp(&right.targetModuleId))
            .then(left.importClause.cmp(&right.importClause))
            .then(left.boundaryNames.cmp(&right.boundaryNames))
    });
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
        preservedImports: preserved_imports,
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
        let allocator = oxc_allocator::Allocator::default();
        let path = PathBuf::from(metadata_key).with_extension("js");
        let program = parse_oxc_program(&allocator, &path, lowered_source)?;
        names.extend(emit_helpers_oxc::collect_decorator_metadata_property_names(
            &program,
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
        let source = fs::read_to_string(file_name).map_err(|error| error.to_string())?;
        let allocator = oxc_allocator::Allocator::default();
        let program = parse_oxc_program(&allocator, Path::new(file_name), &source)?;
        names.extend(emit_helpers_oxc::collect_decorator_metadata_property_names(
            &program,
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

fn group_lazy_imports_by_file(
    lazy_imports: Vec<LazyImportInput>,
) -> HashMap<String, Vec<LazyImportInput>> {
    let mut grouped = HashMap::<String, Vec<LazyImportInput>>::new();
    for entry in lazy_imports {
        grouped
            .entry(entry.importerFilePath.clone())
            .or_default()
            .push(entry);
    }
    for entries in grouped.values_mut() {
        entries.sort_by(|left, right| left.specifier.cmp(&right.specifier));
    }
    grouped
}

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

fn append_extension(base: &Path, extension: &str) -> PathBuf {
    let mut appended = base.as_os_str().to_owned();
    appended.push(".");
    appended.push(extension);
    PathBuf::from(appended)
}

fn parse_oxc_program<'a>(
    allocator: &'a oxc_allocator::Allocator,
    file_path: &Path,
    source: &'a str,
) -> Result<oxc_ast::ast::Program<'a>, String> {
    let source_type = oxc_span::SourceType::from_path(file_path)
        .unwrap_or_else(|_| oxc_span::SourceType::mjs())
        .with_module(true);
    let parsed = oxc_parser::Parser::new(allocator, source, source_type).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{}: {}", file_path.display(), error.message));
    }
    Ok(parsed.program)
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
    let decorated_output_text = file_metadata
        .as_ref()
        .and_then(|metadata| metadata.decorated_output_text.as_deref());
    let effective_path = if decorated_output_text.is_some() {
        file_path.with_extension("js")
    } else {
        file_path.to_path_buf()
    };
    let emitted_source = decorated_output_text.unwrap_or(&source_text);
    let commonjs_analysis = analyze_commonjs_source(&effective_path, emitted_source)?;
    if should_normalize_commonjs(file_path, &commonjs_analysis) {
        let normalized = commonjs_oxc::normalize_source(
            &effective_path,
            emitted_source,
            &commonjs_analysis,
            context.opaque_commonjs.file_is_opaque(file_path),
        )?;
        return transform_source_with_oxc(
            &file_path.with_extension("js"),
            &normalized,
            context,
            file_metadata.as_ref(),
            Some("__cjsExports"),
        );
    }
    transform_source_with_oxc(
        &effective_path,
        emitted_source,
        context,
        file_metadata.as_ref(),
        None,
    )
}

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
        let source = fs::read_to_string(file_name).map_err(|error| error.to_string())?;
        let allocator = oxc_allocator::Allocator::default();
        let program = parse_oxc_program(&allocator, Path::new(file_name), &source)?;
        names.extend(
            compat_properties_oxc::collect_pair_array_class_map_property_names(
                &program,
                class_map_calls,
            )?,
        );
    }
    Ok(names)
}
