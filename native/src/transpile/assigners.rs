//! Finds vendor-chunk functions that mutate their module's own state.
//!
//! Under ES module chunk output a cross-chunk reference becomes a real
//! `import` binding, and an import binding is immutable. Closure is free to
//! inline a small function into its caller and to cross-chunk-motion whatever
//! survives, so a vendor function that assigns a module-top-level binding can
//! end up executing *in the base chunk* while the binding it writes still
//! lives in vendor — which the compiler then rejects outright:
//!
//! ```text
//! ERROR - [JSC_IMPORT_ASSIGN] Imported symbol "Xa" in chunk "main.js"
//!         cannot be assigned (defined in "vendor.js")
//! ```
//!
//! Svelte's `update_version` is the canonical case. Neither half of the fix
//! is sufficient alone, measured on the real failing job:
//!
//! | applied | result |
//! |---|---|
//! | `@noinline` only | still fails — `CrossChunkCodeMotion` moves the whole function |
//! | runtime pin only | still fails — the function is inlined before motion runs |
//! | both | exit 0 |
//!
//! So this module marks the functions and `closure_jobs` appends the pin.
//! Both are scoped strictly to vendor chunks: motion out of base and lazy
//! chunks is legal and is how those chunks stay small.

use std::collections::HashSet;

use swc_core::ecma::ast::{AssignTarget, Decl, Expr, SimpleAssignTarget, Stmt};
use swc_core::ecma::visit::{Visit, VisitWith};

/// The Closure annotation that keeps a function out of its call sites.
pub(crate) const NOINLINE_TAG: &str = "@noinline";

/// Returns the name of the top-level function `statement` declares when its
/// body writes one of `module_bindings`.
///
/// `module_bindings` holds the *suffixed* top-level names of the module being
/// emitted (`update_version$$10`), which is what makes a plain name match
/// sound: hoisting has already given every top-level binding a per-module
/// ordinal suffix, so a local variable cannot collide with one, and an
/// assignment to a local therefore never matches.
pub(crate) fn assigner_function_name(
    statement: &Stmt,
    module_bindings: &HashSet<String>,
) -> Option<String> {
    let Stmt::Decl(Decl::Fn(fn_decl)) = statement else {
        return None;
    };
    if module_bindings.is_empty() {
        return None;
    }
    let mut visitor = ModuleStateAssignmentVisitor {
        module_bindings,
        found: false,
    };
    // Visits nested functions too, on purpose: a closure that writes the
    // module's state carries its enclosing declaration into the caller when
    // that declaration is inlined, so the enclosing one is what must be
    // pinned.
    fn_decl.function.visit_with(&mut visitor);
    visitor
        .found
        .then(|| fn_decl.ident.sym.as_ref().to_string())
}

struct ModuleStateAssignmentVisitor<'a> {
    module_bindings: &'a HashSet<String>,
    found: bool,
}

impl ModuleStateAssignmentVisitor<'_> {
    fn note(&mut self, name: &str) {
        if self.module_bindings.contains(name) {
            self.found = true;
        }
    }
}

impl Visit for ModuleStateAssignmentVisitor<'_> {
    fn visit_assign_expr(&mut self, node: &swc_core::ecma::ast::AssignExpr) {
        node.visit_children_with(self);
        // Covers `=` and every compound form (`+=`, `??=`, ...): each one
        // writes the binding, which is all `JSC_IMPORT_ASSIGN` cares about.
        // A member write (`obj.x = 1`) mutates the object, not the binding,
        // so only a bare identifier target counts.
        if let AssignTarget::Simple(SimpleAssignTarget::Ident(ident)) = &node.left {
            self.note(ident.id.sym.as_ref());
        }
    }

    fn visit_update_expr(&mut self, node: &swc_core::ecma::ast::UpdateExpr) {
        node.visit_children_with(self);
        if let Expr::Ident(ident) = node.arg.as_ref() {
            self.note(ident.sym.as_ref());
        }
    }
}

/// Extracts the pin list from an assembled vendor chunk's text: every
/// function this module annotated.
///
/// Reading the annotation back out of the text is deliberate. The transpiler
/// writes one file per module and `closure_jobs` concatenates them, so the
/// marker we already emit is the only thing that crosses that boundary — and
/// it keeps the pin list exactly in step with what was annotated, which a
/// second independent detection pass could not guarantee.
pub(crate) fn collect_annotated_assigner_names(chunk_text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for (index, _) in chunk_text.match_indices(NOINLINE_TAG) {
        let Some(block_end) = chunk_text[index..].find("*/") else {
            continue;
        };
        let after_block = chunk_text[index + block_end + 2..].trim_start();
        let Some(rest) = after_block.strip_prefix("function") else {
            continue;
        };
        let name = identifier_prefix(rest.trim_start());
        if let Some(name) = name {
            if seen.insert(name.to_string()) {
                names.push(name.to_string());
            }
        }
    }
    names
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

/// The statement appended to a vendor chunk that makes its mutating functions
/// immovable.
///
/// A property write on the loader object is an effect Closure cannot prove
/// away and cannot relocate, and naming the functions in it keeps live
/// references in the chunk that defines them. It uses the chunk's own
/// per-chunk runtime alias, so it is scoped exactly like the alias line above
/// it.
pub(crate) fn render_assigner_pin(runtime_alias: &str, names: &[String]) -> Option<String> {
    (!names.is_empty()).then(|| format!("{runtime_alias}.v=[{}];", names.join(",")))
}
