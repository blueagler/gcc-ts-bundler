//! `/*#__PURE__*/` propagation into Closure's `@pureOrBreakMyCode`.
//!
//! Closure's `CrossChunkCodeMotion` only relocates a declaration when
//! `CrossChunkReferenceCollector.canMoveValue` accepts its initializer, and
//! that check is purely syntactic: literals, functions and classes move,
//! call expressions never do — unless the declaration carries the
//! `@pureOrBreakMyCode` JSDoc annotation.
//!
//! The wider JS ecosystem already records exactly this fact as
//! `/*#__PURE__*/` (or `/*@__PURE__*/`) leading annotations, which Rollup,
//! esbuild and Vite emit and honor. Closure's JSDoc parser does not read
//! them, and swc drops comments entirely (the lexer and emitter are both
//! built without a comment store), so the information never reaches the
//! compiler.
//!
//! This module recovers it: annotated top-level declarations are collected
//! from the original source text by binding name, and the emitter re-attaches
//! the equivalent Closure annotation. Declarations initialized by a pure call
//! then become movable, so code reachable only from a lazy chunk sinks out of
//! the entry chunk.

use std::collections::HashSet;

use swc_core::ecma::ast::{Callee, Decl, Expr, Pat, Stmt};

/// Collects names of top-level bindings whose initializer carries a
/// `/*#__PURE__*/` or `/*@__PURE__*/` annotation.
///
/// Deliberately source-text driven: comments are gone by the time the module
/// reaches any AST pass, and the annotation is only ever meaningful in the
/// exact position it was written.
pub(crate) fn collect_pure_annotated_binding_names(source: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (index, _) in source.match_indices("__PURE__") {
        let Some(binding) = pure_annotated_binding_before(source, index) else {
            continue;
        };
        names.insert(binding);
    }
    names
}

/// Walks back from a `__PURE__` occurrence over `<comment open> = <name>
/// <declaration keyword>` and returns the declared binding name.
fn pure_annotated_binding_before(source: &str, pure_index: usize) -> Option<String> {
    let prefix = &source[..pure_index];
    let comment_start = prefix.rfind("/*")?;
    // Only `/*#__PURE__*/` and `/*@__PURE__*/` count; anything else between
    // the comment open and the marker means this is prose.
    let marker = prefix[comment_start + 2..].trim();
    if marker != "#" && marker != "@" {
        return None;
    }
    let before_comment = prefix[..comment_start].trim_end();
    let equals_index = before_comment.strip_suffix('=')?.trim_end().len();
    let before_equals = &before_comment[..equals_index];
    let name_start = before_equals
        .rfind(|character: char| !is_identifier_char(character))
        .map(|index| index + 1)
        .unwrap_or(0);
    let name = &before_equals[name_start..];
    if name.is_empty() || name.starts_with(|character: char| character.is_ascii_digit()) {
        return None;
    }
    let keyword = before_equals[..name_start].trim_end();
    if !matches!(
        keyword.rsplit(|c: char| c.is_whitespace()).next(),
        Some("var") | Some("let") | Some("const")
    ) {
        return None;
    }
    Some(name.to_string())
}

fn is_identifier_char(character: char) -> bool {
    character.is_alphanumeric() || character == '_' || character == '$'
}

/// The Closure annotation that makes a call-initialized declaration movable.
pub(crate) const PURE_JSDOC: &str = "/** @pureOrBreakMyCode */\n";

/// Returns the annotation to emit before `statement`, if its declaration was
/// `__PURE__`-annotated in the original source.
///
/// Restricted to single-declarator declarations: JSDoc attaches to the whole
/// statement, so annotating `var a = pure(), b = impure()` would wrongly
/// claim `b` is movable too.
pub(crate) fn pure_annotation_for_statement(
    statement: &Stmt,
    pure_names: &HashSet<String>,
    pure_callees: &HashSet<String>,
    original_name_of: impl Fn(&str) -> Option<String>,
) -> &'static str {
    if pure_names.is_empty() && pure_callees.is_empty() {
        return "";
    }
    let Stmt::Decl(Decl::Var(var_decl)) = statement else {
        return "";
    };
    let [declarator] = var_decl.decls.as_slice() else {
        return "";
    };
    let Some(init) = &declarator.init else {
        return "";
    };
    let Pat::Ident(binding) = &declarator.name else {
        return "";
    };
    let to_original = |name: &str| original_name_of(name).unwrap_or_else(|| name.to_string());

    if pure_names.contains(&to_original(binding.id.sym.as_ref())) {
        return PURE_JSDOC;
    }
    // Configured pure callees (framework template builders and the like)
    // supplied by presets; the core knows no callee names of its own.
    // The callee is usually imported, so it carries the *defining* module's
    // ordinal suffix rather than this module's.
    if let Expr::Call(call) = init.as_ref() {
        if let Callee::Expr(callee) = &call.callee {
            if let Expr::Ident(callee_ident) = callee.as_ref() {
                if pure_callees.contains(strip_module_ordinal(callee_ident.sym.as_ref())) {
                    return PURE_JSDOC;
                }
            }
        }
    }
    ""
}

/// Strips a `$$<ordinal>` hoist suffix, whichever module it came from.
fn strip_module_ordinal(name: &str) -> &str {
    let Some((base, ordinal)) = name.rsplit_once("$$") else {
        return name;
    };
    if !ordinal.is_empty() && ordinal.bytes().all(|byte| byte.is_ascii_digit()) {
        base
    } else {
        name
    }
}
