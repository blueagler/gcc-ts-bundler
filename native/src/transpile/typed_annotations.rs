//! Typed JSDoc re-attachment for hoisted bundler-runtime emission.
//!
//! The TypeScript checker lives in the JS layer (`src/vite/typed-annotations.ts`),
//! so the types it derives reach Rust as pre-rendered JSDoc blocks keyed by
//! source file and top-level binding name. This module matches those bindings
//! against the statements the hoisted emitter is about to print and hands
//! back the block to prepend, plus any per-member blocks to render inside a
//! class body.
//!
//! Why this channel exists at all: `emit_hoist` prints plain top-level
//! statements and never sees `ClosureFileMetadata`, so the `Off`/`Split`
//! JSDoc path (`attach_top_level_docs`) cannot serve it — see
//! docs/research/typed-input.md §3. Annotations are what unlock Closure's
//! type-based passes, which are otherwise inert on our input (§4a/§4c).
//!
//! Soundness rule inherited from the contract: absence of an annotation is
//! always safe, a wrong annotation breaks output silently. Nothing here
//! invents a type; it only relocates blocks the checker produced, and it
//! drops any block whose type names it cannot resolve.

use std::collections::HashMap;
use std::path::Path;

use swc_core::ecma::ast::{Decl, Pat, Stmt};

use crate::pathing::normalize_path;
use crate::transpile::TypedAnnotationFileInput;

/// One annotated top-level binding: the block for the declaring statement,
/// plus per-member blocks when the binding is a class.
#[derive(Clone, Debug, Default)]
pub(crate) struct TypedBindingAnnotation {
    /// Complete JSDoc block, or empty when the binding itself takes none.
    /// Classes take none: `/** @constructor */ class Foo {}` is a
    /// `JSC_MISPLACED_ANNOTATION` and ES6 `class` is already fully typed to
    /// Closure without help (docs/research/typed-input.md, v1 scope).
    pub(crate) jsdoc: String,
    /// Member key name to its complete JSDoc block.
    pub(crate) members: HashMap<String, String>,
}

/// Top-level binding name (pre-`$$ordinal`) to its annotation.
pub(crate) type TypedAnnotationsByName = HashMap<String, TypedBindingAnnotation>;

/// Indexes the flat napi payload by normalized file path so lookup during
/// emission is a single map hit. Paths are normalized on both sides because
/// the JS layer names files as it materialized them and Rust re-derives them
/// from the walked file list.
pub(crate) fn index_typed_annotations(
    files: Vec<TypedAnnotationFileInput>,
) -> HashMap<String, TypedAnnotationsByName> {
    files
        .into_iter()
        .map(|file| {
            let bindings = file
                .bindings
                .into_iter()
                .map(|binding| {
                    let members = binding
                        .members
                        .unwrap_or_default()
                        .into_iter()
                        .map(|member| (member.name, member.jsdoc))
                        .collect();
                    (
                        binding.name,
                        TypedBindingAnnotation {
                            jsdoc: binding.jsdoc,
                            members,
                        },
                    )
                })
                .collect();
            (annotation_key(Path::new(&file.filePath)), bindings)
        })
        .collect()
}

/// The lookup key for a source file's annotations.
pub(crate) fn annotation_key(file_path: &Path) -> String {
    normalize_path(file_path).to_string_lossy().to_string()
}

/// Returns the annotation for `statement`, if it declares a binding the
/// checker annotated.
///
/// Restricted to the three declaration forms JSDoc can attach to
/// unambiguously: a single-declarator `var`/`let`/`const`, a function
/// declaration, and a class declaration. A multi-declarator statement is
/// skipped because the block would claim every declarator, exactly as in
/// `pure_calls::pure_annotation_for_statement`.
pub(crate) fn typed_annotation_for_statement<'a>(
    statement: &Stmt,
    annotations: &'a TypedAnnotationsByName,
    original_name_of: impl Fn(&str) -> Option<String>,
) -> Option<&'a TypedBindingAnnotation> {
    if annotations.is_empty() {
        return None;
    }
    let declared_name = declared_binding_name(statement)?;
    let original_name =
        original_name_of(&declared_name).unwrap_or_else(|| declared_name.to_string());
    annotations.get(&original_name)
}

/// The single top-level binding a statement declares, if it declares exactly
/// one in a JSDoc-attachable position.
fn declared_binding_name(statement: &Stmt) -> Option<String> {
    match statement {
        Stmt::Decl(Decl::Var(var_decl)) => {
            let [declarator] = var_decl.decls.as_slice() else {
                return None;
            };
            let Pat::Ident(binding) = &declarator.name else {
                return None;
            };
            Some(binding.id.sym.as_ref().to_string())
        }
        Stmt::Decl(Decl::Fn(fn_decl)) => Some(fn_decl.ident.sym.as_ref().to_string()),
        Stmt::Decl(Decl::Class(class_decl)) => Some(class_decl.ident.sym.as_ref().to_string()),
        _ => None,
    }
}

/// JSDoc type keywords that are never binding references.
const JSDOC_PRIMITIVE_NAMES: [&str; 8] = [
    "boolean",
    "null",
    "number",
    "string",
    "undefined",
    "void",
    "Object",
    "Array",
];

/// Rewrites type references inside a JSDoc block to the names the emitted
/// code actually uses, or returns `None` when it cannot.
///
/// Two things rename a type's declaration out from under a JSDoc block in
/// hoisted emission, and `type_names` is the union of both: top-level
/// bindings get a `$$ordinal` suffix, and an imported binding is rewritten to
/// the *origin* module's suffixed name. Both maps are keyed by the name as
/// written in the annotated module, which is exactly what the checker emitted.
///
/// **Drop rule.** A non-primitive name that resolves through neither map is
/// unresolvable, and the whole block is dropped. This is the only sound
/// choice: the JS side cannot predict which imports survive as direct
/// bindings, because that depends on the hoist plan (chunk assignment, scan
/// failures, the typed-metadata veto) which is decided here, much later. A
/// dropped block costs optimisation; a block naming the wrong declaration —
/// or a stale unsuffixed one that resolves to something else entirely — is
/// silently unsound.
pub(crate) fn rewrite_type_names(
    jsdoc: &str,
    type_names: &HashMap<String, String>,
) -> Option<String> {
    if !jsdoc.contains('{') {
        return Some(jsdoc.to_string());
    }
    let mut result = String::with_capacity(jsdoc.len() + 8);
    let mut rest = jsdoc;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else {
            break;
        };
        result.push_str(&rest[..=open]);
        result.push_str(&rewrite_type_expression(
            &rest[open + 1..open + close],
            type_names,
        )?);
        result.push('}');
        rest = &rest[open + close + 1..];
    }
    result.push_str(rest);
    Some(result)
}

fn rewrite_type_expression(
    type_expression: &str,
    type_names: &HashMap<String, String>,
) -> Option<String> {
    let mut out = String::with_capacity(type_expression.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| -> Option<()> {
        if word.is_empty() {
            return Some(());
        }
        if JSDOC_PRIMITIVE_NAMES.contains(&word.as_str()) {
            out.push_str(word);
        } else {
            out.push_str(type_names.get(word.as_str())?);
        }
        word.clear();
        Some(())
    };
    for character in type_expression.chars() {
        if character.is_alphanumeric() || character == '_' || character == '$' {
            word.push(character);
        } else {
            flush(&mut word, &mut out)?;
            out.push(character);
        }
    }
    flush(&mut word, &mut out)?;
    Some(out)
}

/// Renders each member's JSDoc immediately before that member inside an
/// already-printed class declaration.
///
/// Works on the printed text rather than the AST because swc's codegen runs
/// with `comments: None` and every synthesized node carries `DUMMY_SP`, so
/// there is no distinct position to hang a leading comment on (see
/// `print.rs`). The printed form is fully deterministic — one member per
/// line, one indent step per nesting level — so the anchors below are exact:
///
/// - a **class-body member** is a line at exactly the body indent whose first
///   token is the member name followed by `(`, `=`, `;` or whitespace;
/// - a **constructor-assigned field** is a line one indent step deeper
///   beginning `this.<name>` followed by an assignment.
///
/// Deeper nesting always means deeper indentation, so no line inside a nested
/// function, object literal or class can be mistaken for a member. Each
/// member is annotated at most once, at its first match, so a field that is
/// both declared and constructor-assigned cannot produce a duplicate
/// declaration. Anything that does not match is simply left alone.
pub(crate) fn insert_member_annotations(
    printed: &str,
    members: &HashMap<String, String>,
) -> String {
    if members.is_empty() {
        return printed.to_string();
    }
    let lines: Vec<&str> = printed.split('\n').collect();
    // The body indent is whatever the first line after the class header uses;
    // reading it rather than assuming a width keeps this independent of the
    // codegen config.
    let Some(body_indent) = lines.get(1).map(|line| indent_width(line)) else {
        return printed.to_string();
    };
    if body_indent == 0 {
        return printed.to_string();
    }
    let member_indent = body_indent * 2;

    let mut annotated = std::collections::HashSet::new();
    let mut in_constructor = false;
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        let indent = indent_width(line);
        let text = line.trim_start();
        if indent == body_indent {
            // Any body-indent line starts a new member, so it also ends the
            // previous one.
            in_constructor = text.starts_with("constructor(");
        }
        let name = if indent == body_indent {
            leading_member_name(text)
        } else if indent == member_indent && in_constructor {
            // Only inside the constructor: a `this.x =` one step deep in some
            // other member could sit in a nested `function () {}`, where
            // `this` is not the instance and the type would be a lie.
            assigned_member_name(text)
        } else {
            None
        };
        if let Some(name) = name {
            if let Some(jsdoc) = members.get(name) {
                if annotated.insert(name.to_string()) {
                    for block_line in jsdoc.trim_end().split('\n') {
                        out.push(format!("{}{block_line}", " ".repeat(indent)));
                    }
                }
            }
        }
        out.push(line.to_string());
    }
    out.join("\n")
}

fn indent_width(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// The member key a class-body line declares: a bare identifier followed by
/// `(` (method), `=` (field with initializer), `;` (bare field) or a space.
/// Computed (`['x']`) and quoted (`"x"`) keys never start with an identifier
/// character, so they are skipped for free, as the contract requires.
fn leading_member_name(text: &str) -> Option<&str> {
    let name = identifier_prefix(text)?;
    // `static`, `get`, `set` and `async` are prefixes, not the key; the key
    // that follows is what a member annotation would name, and v2's payload
    // only ever names plain fields, so stopping here is the conservative
    // reading.
    let rest = text[name.len()..].trim_start();
    matches!(rest.chars().next(), Some('(' | '=' | ';') | None).then_some(name)
}

/// The member key a `this.<name> = ...` line assigns.
fn assigned_member_name(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("this.")?;
    let name = identifier_prefix(rest)?;
    let after = rest[name.len()..].trim_start();
    // Plain `=` (but not the `==`/`===` comparisons) and the logical
    // assignments, which also establish the property.
    let assigns = (after.starts_with('=') && !after.starts_with("=="))
        || ["??=", "||=", "&&="]
            .iter()
            .any(|operator| after.starts_with(operator));
    assigns.then_some(name)
}

fn identifier_prefix(text: &str) -> Option<&str> {
    let end = text
        .find(|character: char| {
            !(character.is_alphanumeric() || character == '_' || character == '$')
        })
        .unwrap_or(text.len());
    (end > 0 && !text.starts_with(|character: char| character.is_ascii_digit()))
        .then(|| &text[..end])
}

/// Combines the `@pureOrBreakMyCode` annotation with a typed block.
///
/// Closure keeps only the JSDoc block *nearest* the declaration and silently
/// drops any earlier one (verified: two adjacent `@type` blocks report a
/// mismatch against the second only). So the two annotations cannot simply be
/// concatenated — they are merged into one block by splicing the pure tag in
/// after the opening `/**`, which is valid for both the single-line
/// (`/** @constructor */`) and multi-line rendered forms.
pub(crate) fn compose_annotations(pure: &str, typed: Option<&str>) -> String {
    match (pure.is_empty(), typed.filter(|block| !block.is_empty())) {
        (true, None) => String::new(),
        (true, Some(typed)) => typed.to_string(),
        (false, None) => pure.to_string(),
        (false, Some(typed)) => splice_pure_tag(typed),
    }
}

/// Inserts `@pureOrBreakMyCode` as the first tag of an existing JSDoc block.
/// Falls back to the typed block alone if it is not a recognizable block, so
/// a malformed annotation can never corrupt the emitted statement.
fn splice_pure_tag(typed: &str) -> String {
    const OPENING: &str = "/**";
    let Some(rest) = typed.strip_prefix(OPENING) else {
        // Not a block we can splice: prefer the typed annotation, since
        // losing a movability hint costs bytes while losing a type can
        // change behaviour.
        return typed.to_string();
    };
    format!("{OPENING} {PURE_TAG}{rest}")
}

/// The single tag carried by `pure_calls::PURE_JSDOC`, spliced into typed
/// blocks. `pure_calls` owns the standalone block; a test pins the two
/// together so they cannot drift.
pub(crate) const PURE_TAG: &str = "@pureOrBreakMyCode";
