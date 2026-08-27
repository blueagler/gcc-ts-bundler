use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::closure_metadata::{closure_metadata_key, ClosureFileMetadata};
use crate::commonjs::analyze_commonjs_source;
use crate::pathing::to_goog_module_id;

use super::commonjs;
use super::context::TranspileContext;
use super::emit::EmittedProgram;
use super::emit_helpers;
use super::js_compat::should_normalize_commonjs;
use super::napi::{LazyImportInput, TranspileChunkInput};
use super::transform::transform_source_with_oxc;

/// Places each pooled lowering-helper declaration exactly once.
///
/// Every pooled helper moves to the first file of the first chunk — the chunk
/// every other chunk transitively depends on — so one definition dominates
/// every use. Closure compiles all chunks as one job and sinks the definition
/// back down if only one chunk turns out to use it.
///
/// Leaving a helper where it was declared is not an option even when exactly
/// one module declares it: the *users* are what the placement has to dominate,
/// and a helper reference is a bare identifier with no import edge behind it,
/// so nothing orders the declaring file before a sibling that uses it.
pub(super) fn plan_shared_helper_placement(
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
        if let Some(owner) = program_owner
            .clone()
            .or_else(|| claimants.into_iter().next())
        {
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
pub(crate) fn collect_decorated_metadata_property_names(
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
        names.extend(emit_helpers::collect_decorator_metadata_property_names(
            &program,
        ));
    }
    Ok(names)
}

/// Module ids whose state-mutating exported functions must stay put.
///
/// A function that writes hoisted module state has to execute in the chunk that
/// owns that state: `CrossChunkCodeMotion` relocating it into its only consumer
/// turns the write into an assignment to an ES-module import, which is illegal
/// and which Closure rejects outright. The `@noinline` tag this set drives is
/// half the guard; `render_assigner_pin` is the other half.
///
/// Any chunk boundary at all is enough to create the hazard, so a plan with
/// more than one chunk pins every module. A single-chunk plan has nowhere to
/// move anything and is left exactly as it was.
pub(crate) fn collect_assigner_pin_module_ids(
    chunk_graph: &[TranspileChunkInput],
    workspace_dir: &Path,
) -> HashSet<String> {
    if chunk_graph.len() < 2 {
        return HashSet::new();
    }
    chunk_graph
        .iter()
        .flat_map(|chunk| chunk.files.iter())
        .map(|relative_file| to_goog_module_id(&workspace_dir.join(relative_file), workspace_dir))
        .collect()
}

pub(crate) fn group_lazy_imports_by_file(
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

pub(crate) fn append_extension(base: &Path, extension: &str) -> PathBuf {
    let mut appended = base.as_os_str().to_owned();
    appended.push(".");
    appended.push(extension);
    PathBuf::from(appended)
}

pub(crate) fn parse_oxc_program<'a>(
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

pub(super) fn transform_source_file(
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
        let normalized = commonjs::normalize_source(
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
