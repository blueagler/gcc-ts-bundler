//! Binding identity for the transpile monolith.
//!
//! Every correctness-critical decision in `hoist`, `emit_hoist`,
//! `namespace/flow`, `global_this` and `type_metadata` rests on one question:
//! *are these two identifiers the same binding?* Getting it wrong does not fail
//! to compile — it emits a direct binding to the wrong declaration, which is the
//! top silent-miscompile risk in the swc -> oxc port (`/tmp/gcc-o1-oxc.md`,
//! risk 3).
//!
//! Today that question is answered by the swc resolver: it stamps every
//! identifier with a `SyntaxContext` derived from per-scope `Mark`s, and
//! `(Atom, SyntaxContext)` — swc's `Id` — is the key. Under oxc it is answered
//! by `oxc_semantic`: `SemanticBuilder` builds a real scope tree and every
//! binding gets a `SymbolId`.
//!
//! # Why this module exists
//!
//! Those two models are not interchangeable at the call site. swc carries
//! identity *inside the node* (`ident.to_id()` needs nothing else), while oxc
//! keeps it *beside* the AST (you carry `Scoping` and ask it). 162 sites in 18
//! files spell the swc form out inline, so a direct swap would be 162
//! simultaneous edits across every lane's files, with no compiler help on the
//! ones where the shape genuinely changes.
//!
//! So identity becomes an API first, with the swc form as its current
//! implementation:
//!
//! * `BindingKey` — the stable per-binding key. Constructed only from an
//!   identifier node; nothing outside this module may spell out what it wraps.
//! * `BindingKeySet` / `BindingKeyMap` — the two collections every caller
//!   actually wants (`HashSet<Id>` / `HashMap<Id, V>` today).
//! * `GlobalScope` — "does this identifier resolve to a module binding, or is it
//!   a free reference to a global?", which is the *other* thing the resolver's
//!   Marks are used for (`globalThis` detection, `process.env` folding).
//!
//! The conversion turned out to need no escape hatch: after it, no file outside
//! this module spells out swc's `Id` at all, so the port's identity surface is
//! this file plus the `identity:`-commented sites, not 162 scattered ones.
//!
//! # The oxc mapping, member by member
//!
//! | this API | swc today | oxc after the AST swap |
//! |---|---|---|
//! | `BindingKey` | `Id` = `(Atom, SyntaxContext)` | `SymbolId` |
//! | `BindingKey::of(ident)` | `ident.to_id()` | `scoping.get_reference(ident.reference_id()).symbol_id()` |
//! | `BindingKey::of_binding(binding)` | `binding.id.to_id()` | `binding.symbol_id.get()` |
//! | `BindingKey::symbol()` | `id.0.as_ref()` | `scoping.symbol_name(symbol_id)` |
//! | `GlobalScope::contains(ident)` | `ident.ctxt == unresolved_ctxt` | `scoping.root_unresolved_references().contains_key(name)` |
//! | `ModuleIdentity` | `(Mark, Mark)` from `resolver(..)` | the `Scoping` from `SemanticBuilder::build` |
//!
//! The unresolved-reference form is already in the tree: `closure_jobs/jobs/`
//! `bundler_runtime.rs` replaced its unresolved-`Mark` test with exactly that
//! query when it moved to oxc (`/tmp/gcc-oxb-islands.md`, island 3).
//!
//! # What the swap will and will not be
//!
//! Mechanical, once the AST is oxc: every `BindingKey::of` grows a `&Scoping`
//! argument (or `ModuleIdentity` is threaded where the visitor already carries
//! state) and this file's body changes. The *judgment* is elsewhere and is
//! flagged where it lives, with `identity:` comments on the sites where the two
//! models could plausibly disagree:
//!
//! * a key built from an identifier the resolver never visited (a node this
//!   pipeline *synthesised*) has an empty `SyntaxContext` today and no
//!   `SymbolId` at all under oxc — those sites must not silently collide;
//! * `emit_hoist`'s rename map is keyed per binding and applied to every
//!   reference, which is where a wrong key becomes a wrong direct binding.
//!
//! The gate for all of it is the executing cross-chunk identity test in
//! `test/oxc-migration-safety.test.mjs` ("a dependent chunk binds the hoisted
//! import, not the shadowing base-chunk name"), which asserts *which* binding
//! each chunk references at runtime rather than any emitted text.

use std::collections::{HashMap, HashSet};

use swc_core::common::SyntaxContext;
use swc_core::ecma::ast::{BindingIdent, Id, Ident};

use super::ResolverMarks;

/// A stable key for one binding, comparable across every reference to it.
///
/// Deliberately opaque: the inner representation is what changes in the port, so
/// only this module may construct or destructure one. `Ord` is derived so
/// key-driven output stays deterministic without callers reaching inside.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct BindingKey(Id);

impl BindingKey {
    /// The key for the binding this identifier refers to.
    ///
    /// oxc: resolve the reference through `Scoping` to its `SymbolId`.
    pub(crate) fn of(ident: &Ident) -> Self {
        Self(ident.to_id())
    }

    /// The key for the binding this declaration introduces.
    ///
    /// Separate from `of` because it is a *declaration* site: under oxc this
    /// reads `binding.symbol_id`, which is populated by the semantic builder,
    /// rather than resolving a reference.
    pub(crate) fn of_binding(binding: &BindingIdent) -> Self {
        Self(binding.id.to_id())
    }

    /// The source-level name. Only for rendering and for name-based lookups
    /// that are *not* identity decisions.
    pub(crate) fn symbol(&self) -> &str {
        self.0 .0.as_ref()
    }

    /// The same binding under a new spelling.
    ///
    /// `emit_hoist` renames hoisted bindings to keep a single module scope
    /// collision-free, and `type_metadata` follows those renames through its
    /// key-driven maps. That only needs to exist because a swc key *contains*
    /// its name: under oxc a `SymbolId` is stable across a rename (the name
    /// lives in `Scoping`), so every caller of this collapses to a no-op when
    /// the AST swaps. Marked `identity:` at each call site.
    pub(crate) fn renamed_to(&self, name: &str) -> Self {
        Self((name.into(), self.0 .1))
    }

}

pub(crate) type BindingKeySet = HashSet<BindingKey>;
pub(crate) type BindingKeyMap<V> = HashMap<BindingKey, V>;

/// The set of identifiers that resolve to no module binding — free references to
/// globals (`globalThis`, `process`).
///
/// swc answers this with the resolver's unresolved `Mark`; oxc answers it with
/// `Scoping::root_unresolved_references`. Both are per-module facts, so this is
/// a value handed to visitors rather than a global.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GlobalScope {
    unresolved_ctxt: SyntaxContext,
}

impl GlobalScope {
    /// A module the resolver did run on: `marks` carries its unresolved mark.
    ///
    /// `None` means the resolver was skipped for this file (plain JS
    /// pass-through), where every identifier keeps the empty context — which is
    /// exactly `SyntaxContext::empty()`, so the test below still answers
    /// correctly.
    pub(crate) fn from_resolver_marks(marks: Option<&ResolverMarks>) -> Self {
        Self {
            unresolved_ctxt: marks
                .map(|(unresolved_mark, _)| SyntaxContext::empty().apply_mark(*unresolved_mark))
                .unwrap_or_default(),
        }
    }

    /// True when this identifier is a free reference to a global.
    pub(crate) fn contains(&self, ident: &Ident) -> bool {
        ident.ctxt == self.unresolved_ctxt
    }
}

/// The per-module semantic model, built once and asked many times.
///
/// Today it is the pair of resolver `Mark`s, which is all swc keeps; under oxc
/// it owns the `Scoping` produced by `SemanticBuilder` and every identity query
/// goes through it. It exists now so the threading is already in place: the
/// call sites that will need the model are the ones that take this.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ModuleIdentity {
    marks: Option<ResolverMarks>,
}

impl ModuleIdentity {
    pub(crate) fn from_resolver_marks(marks: Option<ResolverMarks>) -> Self {
        Self { marks }
    }

    pub(crate) fn global_scope(&self) -> GlobalScope {
        GlobalScope::from_resolver_marks(self.marks.as_ref())
    }

    /// The raw marks, for the swc passes that still take them directly (`jsx`,
    /// `strip`). Gone with the AST swap: oxc's transformer takes `Scoping`.
    pub(crate) fn resolver_marks(&self) -> Option<ResolverMarks> {
        self.marks
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use swc_core::common::{Globals, Mark, GLOBALS};

    #[test]
    fn keys_separate_same_named_bindings_from_different_scopes() {
        // The whole point of the type: two identifiers spelled the same are only
        // the same binding when their scope agrees. This is the property the
        // cross-chunk direct-binding decisions rest on.
        GLOBALS.set(&Globals::new(), || {
            let outer = SyntaxContext::empty().apply_mark(Mark::new());
            let inner = SyntaxContext::empty().apply_mark(Mark::new());
            let of = |ctxt| BindingKey::of(&Ident::new("label".into(), Default::default(), ctxt));

            assert_eq!(of(outer), of(outer));
            assert_ne!(of(outer), of(inner));
            assert_eq!(of(outer).symbol(), "label");
        });
    }

    #[test]
    fn global_scope_matches_only_unresolved_identifiers() {
        GLOBALS.set(&Globals::new(), || {
            let unresolved_mark = Mark::new();
            let top_level_mark = Mark::new();
            let scope = GlobalScope::from_resolver_marks(Some(&(unresolved_mark, top_level_mark)));

            let free = Ident::new(
                "globalThis".into(),
                Default::default(),
                SyntaxContext::empty().apply_mark(unresolved_mark),
            );
            let bound = Ident::new(
                "globalThis".into(),
                Default::default(),
                SyntaxContext::empty().apply_mark(top_level_mark),
            );

            assert!(scope.contains(&free));
            assert!(!scope.contains(&bound));
        });
    }

    #[test]
    fn a_skipped_resolver_leaves_every_identifier_in_the_global_scope() {
        // Plain-JS pass-through files never run the resolver, so every
        // identifier keeps the empty context. The compat visitors rely on this
        // reading as "unresolved" rather than panicking or matching nothing.
        let scope = GlobalScope::from_resolver_marks(None);
        let ident = Ident::new("process".into(), Default::default(), SyntaxContext::empty());
        assert!(scope.contains(&ident));
    }
}
