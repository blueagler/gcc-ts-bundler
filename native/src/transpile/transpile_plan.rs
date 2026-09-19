use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::closure_metadata::closure_metadata_key;

use super::context::TranspileContext;
use super::emit::EmittedProgram;
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
    let mut claims: BTreeMap<String, (String, PathBuf)> = BTreeMap::new();
    for (_, output_path, emitted) in emitted_outputs {
        for helper in &emitted.shared_helpers {
            claims
                .entry(helper.canonical_name.clone())
                .and_modify(|(_, path)| {
                    if output_path < path {
                        path.clone_from(output_path);
                    }
                })
                .or_insert_with(|| (helper.text.clone(), output_path.clone()));
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
    for (_, (text, claimant)) in claims {
        let owner = program_owner.clone().unwrap_or(claimant);
        prefixes.entry(owner).or_default().push(text);
    }
    prefixes
        .into_iter()
        .map(|(path, texts)| (path, texts.join("\n")))
        .collect()
}

pub(crate) fn group_lazy_imports_by_file(
    lazy_imports: Vec<LazyImportInput>,
) -> HashMap<String, Vec<LazyImportInput>> {
    let mut grouped = HashMap::<String, Vec<LazyImportInput>>::new();
    for entry in lazy_imports {
        grouped
            .entry(entry.importer_file_path.clone())
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
    let file_metadata = context.file_metadata.get(&closure_metadata_key(file_path));
    let decorated_output_text =
        file_metadata.and_then(|metadata| metadata.decorated_output_text.as_deref());
    let effective_path = if decorated_output_text.is_some() {
        file_path.with_extension("js")
    } else {
        file_path.to_path_buf()
    };
    let emitted_source = decorated_output_text.unwrap_or(&source_text);
    transform_source_with_oxc(
        &effective_path,
        emitted_source,
        context,
        file_metadata,
        file_path,
    )
}
