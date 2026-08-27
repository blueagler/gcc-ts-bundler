use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::closure_metadata::EmittedTypeMetadata;
use crate::pathing::{normalize_path, to_bundler_runtime_module_id, to_goog_module_id};
use crate::support_files::emit_package_support_files;

use super::context::TranspileContext;
use super::externs::{is_valid_js_identifier, render_generated_externs};
use super::napi::{PreservedImportOutput, TranspileChunkInput, TranspileOutput};
use super::transpile_plan::{plan_shared_helper_placement, transform_source_file};

/// Transform compiled sources, place pooled helpers, and write artifacts.
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_and_write_transpile_outputs(
    compiled_file_names: &[String],
    context: &TranspileContext,
    chunk_graph: &[TranspileChunkInput],
    out_dir: &Path,
    program_declared_names: &HashSet<String>,
    explicit_extern_property_count: u32,
    externs_path: String,
    runtime_module_source_map_file: Option<String>,
    package_json_files: &[String],
) -> std::result::Result<TranspileOutput, String> {
    let workspace_dir = &context.workspace_dir;
    let emitted_outputs = compiled_file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let emitted = transform_source_file(&file_path, context)?;

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
    let preserved_extern_lines = reconcile_preserved_extern_lines(
        emitted_outputs
            .iter()
            .flat_map(|(_, _, emitted)| emitted.preserved_extern_lines.iter().map(String::as_str)),
    );
    if !preserved_extern_lines.is_empty() {
        externs_text.push_str("\n// Preserved ESM import bindings.\n");
        externs_text.push_str(&preserved_extern_lines.join("\n"));
        externs_text.push('\n');
    }
    fs::write(&externs_path, externs_text).map_err(|error| error.to_string())?;

    let shared_helper_prefixes =
        plan_shared_helper_placement(&emitted_outputs, chunk_graph, out_dir, workspace_dir);
    let mut reification_warnings = BTreeMap::<String, String>::new();
    for reification in emitted_outputs
        .iter()
        .flat_map(|(_, _, emitted)| &emitted.reifications)
    {
        reification_warnings
            .entry(reification.module_id.clone())
            .and_modify(|warning| {
                if reification.warning < *warning {
                    warning.clone_from(&reification.warning);
                }
            })
            .or_insert_with(|| reification.warning.clone());
    }

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
                to_bundler_runtime_module_id(&to_goog_module_id(&output_path, out_dir));
            runtime_module_source_map.insert(
                runtime_module_id,
                normalize_path(&file_path).to_string_lossy().to_string(),
            );
        }
        let emitted_file = output_path.to_string_lossy().to_string();
        emitted_type_metadata.push(EmittedTypeMetadata::new(
            emitted_file.clone(),
            emitted.type_metadata.counts,
            emitted.type_metadata.declarations,
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
        out_dir,
        workspace_dir,
        context.chunk_mode,
        &context.package_aliases,
        package_json_files,
    )?;
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        explicitExternPropertyCount: explicit_extern_property_count,
        externsPath: externs_path,
        preservedImports: preserved_imports,
        supportFiles: support_files,
        typeMetadata: emitted_type_metadata,
        warnings: reification_warnings.into_values().collect(),
    })
}

/// Name of the variable a preserved-boundary extern line declares, or `None`
/// when the line is an additive member reference such as `binding.member;`.
///
/// The leading JSDoc comment is discarded without being read: the statement
/// decides the form, so `/** @type {?} */ var x;`, `/** @const */ var x = {};`
/// and `var x;` all report `x`. Any initializer is accepted, because what makes
/// a line a declaration is the `var` binding, not the value it is given.
fn declared_extern_name(line: &str) -> Option<&str> {
    let mut statement = line.trim();
    if let Some(comment) = statement.strip_prefix("/**") {
        statement = comment.split_once("*/")?.1.trim();
    }
    let declarator = statement.strip_prefix("var")?;
    if !declarator.starts_with(|character: char| character.is_ascii_whitespace()) {
        // A binding whose own name starts with `var`, e.g. `variant.member;`.
        return None;
    }
    let declarator = declarator.trim_start();
    let name_end = declarator
        .find(|character: char| {
            !(character.is_ascii_alphanumeric() || character == '_' || character == '$')
        })
        .unwrap_or(declarator.len());
    let (name, tail) = declarator.split_at(name_end);
    if !is_valid_js_identifier(name) {
        return None;
    }
    let tail = tail.trim();
    if tail == ";" || (tail.starts_with('=') && tail.ends_with(';')) {
        Some(name)
    } else {
        None
    }
}

/// Collapse every module's preserved-boundary extern lines into one declaration
/// per variable, followed by the additive member lines.
///
/// A boundary name is deliberately shared by every module importing the same
/// export from the same external specifier — that shared name *is* the shared
/// boundary global. Those modules can still render it differently, so deduping
/// by line text left the same variable declared more than once, which Closure
/// rejects with `JSC_VAR_MULTIPLY_DECLARED_ERROR`.
///
/// When the renderings disagree the survivor is the most permissive one,
/// `/** @type {?} */ var x;`. `/** @const */ var x = {};` asserts the boundary
/// value is a plain object, which lets Closure conclude that properties it
/// cannot see are absent; that is unsound as soon as another module treats the
/// same boundary as opaque. Unknown can never license a wrong conclusion, so it
/// is the safe join. Member lines are not declarations — they are what pins
/// those property names as rename barriers — so they are kept additively and
/// deduped on their own, independent of which declaration form wins.
fn reconcile_preserved_extern_lines<'line>(lines: impl Iterator<Item = &'line str>) -> Vec<String> {
    // `Some(line)` while every declaration of the name has rendered it
    // identically; `None` once any two disagree.
    let mut declarations = BTreeMap::<&'line str, Option<&'line str>>::new();
    let mut additive_lines = BTreeSet::<&'line str>::new();
    for line in lines {
        match declared_extern_name(line) {
            Some(name) => {
                declarations
                    .entry(name)
                    .and_modify(|agreed| {
                        if *agreed != Some(line) {
                            *agreed = None;
                        }
                    })
                    .or_insert(Some(line));
            }
            None => {
                additive_lines.insert(line);
            }
        }
    }
    declarations
        .into_iter()
        .map(|(name, agreed)| match agreed {
            Some(line) => line.to_string(),
            None => format!("/** @type {{?}} */ var {name};"),
        })
        .chain(additive_lines.into_iter().map(str::to_string))
        .collect()
}
