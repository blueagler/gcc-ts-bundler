//! The oxc implementation of the identity API (`identity.rs`'s contract).
//!
//! Milestone 1 of the atomic swap. `identity.rs` documented what each member
//! becomes; this is that, compiled against oxc 0.142, so the shape differences
//! are facts rather than predictions.
//!
//! # The two shape changes the swap forces on every call site
//!
//! 1. **A key is no longer derivable from a node alone.** swc carries identity
//!    inside `Ident` (`ident.to_id()`); oxc keeps it in `Scoping`, so every
//!    lookup needs the model. That is why the constructors below are methods on
//!    `ModuleIdentity` rather than associated functions on `BindingKey`.
//!
//! 2. **A reference may have no key at all.** `Scoping::get_reference(..)
//!    .symbol_id()` returns `Option<SymbolId>`: `None` means the reference
//!    resolves to no declaration in this file (a global). swc gave those an `Id`
//!    like any other, distinguished only by the unresolved `SyntaxContext`.
//!
//!    This is *stricter* than what it replaces: under swc, a synthesised
//!    identifier with an empty context could compare equal to an authored
//!    binding of the same name. Under oxc it cannot, because it has no symbol.
//!    But it means `set.contains(&key_of(ident))` becomes
//!    `key_of(ident).is_some_and(|key| set.contains(&key))` at every membership
//!    site, and a site that *wants* the global case has to say so.
//!
//! A third difference is not about identity but hits the same call sites: oxc
//! splits swc's single `Ident` into `IdentifierReference` (a read),
//! `BindingIdentifier` (a declaration) and `IdentifierName` (a property name),
//! so the surrounding match arms change too.

use oxc_ast::ast::{BindingIdentifier, IdentifierReference};
use oxc_semantic::{Scoping, SymbolId};
use oxc_str::Ident;

use std::collections::{HashMap, HashSet};

/// A stable key for one binding. `SymbolId` is already exactly that.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct BindingKey(SymbolId);

impl BindingKey {
    #[cfg(test)]
    pub(crate) fn into_symbol_id_for_test(self) -> SymbolId {
        self.0
    }
}

pub(crate) type BindingKeySet = HashSet<BindingKey>;
pub(crate) type BindingKeyMap<V> = HashMap<BindingKey, V>;

/// The per-module semantic model: built once, asked many times.
///
/// Holds `Scoping` rather than the whole `Semantic` because identity is all this
/// API answers; passes that walk nodes take `Semantic` themselves.
pub(crate) struct ModuleIdentity {
    scoping: Scoping,
}

impl ModuleIdentity {
    pub(crate) fn new(scoping: Scoping) -> Self {
        Self { scoping }
    }

    /// The binding this reference resolves to, or `None`.
    ///
    /// `None` covers two cases that must both be safe, because the port hits
    /// both: a free reference to a global, and a node this pipeline
    /// *synthesised* after the model was built.
    ///
    /// Note `reference_id()` is deliberately not used: it is documented
    /// "only use on a post-semantic AST" and `unwrap()`s internally, so a
    /// synthesised node **panics** rather than reporting absence (measured — it
    /// took down the flagged-site test below before this accessor was made
    /// total). Every emission pass builds nodes, so the total form is the only
    /// safe one.
    pub(crate) fn key_of_reference(&self, ident: &IdentifierReference<'_>) -> Option<BindingKey> {
        let reference_id = ident.reference_id.get()?;
        self.scoping
            .get_reference(reference_id)
            .symbol_id()
            .map(BindingKey)
    }

    /// True only for a node built after semantic analysis. Authored unresolved
    /// globals still have a reference id whose symbol is `None`.
    pub(crate) fn is_synthesized_reference(&self, ident: &IdentifierReference<'_>) -> bool {
        ident.reference_id.get().is_none()
    }

    /// The binding this declaration introduces.
    ///
    /// Infallible: a `BindingIdentifier` always has a symbol once the semantic
    /// model is built (the panic path means the model was not built for this
    /// program, which is a programming error, not input-dependent).
    pub(crate) fn key_of_binding(&self, binding: &BindingIdentifier<'_>) -> BindingKey {
        BindingKey(binding.symbol_id())
    }

    /// The source-level name of a binding. Renders and name-based lookups only.
    pub(crate) fn symbol(&self, key: BindingKey) -> &str {
        self.scoping.symbol_name(key.0)
    }

    /// True when this reference resolves to no declaration in this file: oxc's
    /// replacement for "carries the unresolved mark", and the same query island
    /// 3 already uses.
    pub(crate) fn is_global(&self, ident: &IdentifierReference<'_>) -> bool {
        self.key_of_reference(ident).is_none()
    }

    #[cfg(test)]
    pub(crate) fn scoping_for_test(&self) -> &Scoping {
        &self.scoping
    }

    /// Renaming under oxc: the key does not change, only the name in `Scoping`.
    ///
    /// This is the member `identity.rs` flagged as collapsing — `type_metadata`'s
    /// key re-spelling and `remap_id_keyed_map` exist only because a swc key
    /// contains its own name, and both should be *deleted* rather than ported.
    ///
    /// Note the signature: `set_symbol_name` takes an arena-interned
    /// `oxc_str::Ident`, not a `&str`, so a rename needs the `Allocator` in hand.
    /// Every pass that renames (`emit_hoist`) therefore has to thread the arena
    /// as well as the model — one of the measured shape changes, not a detail.
    pub(crate) fn rename(&mut self, key: BindingKey, name: Ident<'_>) {
        self.scoping.set_symbol_name(key.0, name);
    }
}

#[cfg(test)]
mod flagged_sites {
    //! The five sites `identity.rs` flagged as judgment rather than mechanics,
    //! settled against the real oxc model before 20k lines are rewritten around
    //! them. Each test names the site it retires.

    use super::*;
    use oxc_allocator::{Allocator, FromIn};
    use oxc_ast::ast::Statement;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    fn model(source: &str) -> (Allocator, String) {
        (Allocator::default(), source.to_string())
    }

    /// Site 3 (highest severity): the cross-chunk direct-binding decision.
    ///
    /// `emit_hoist` renames each module's top-level bindings with the module's
    /// ordinal so a chunk can concatenate them, then rewrites every reference
    /// through the same key. A wrong key here is a silently wrong direct binding
    /// — the OX-A executing test exists for exactly this.
    ///
    /// The property it needs from the model: within a module, an *imported*
    /// binding and a same-named *local* binding of another module are different
    /// symbols, and every reference resolves to the one that is in scope. oxc
    /// gives this per-module, which matches `emit_hoist`'s per-module renaming —
    /// no global identity space is required, which was the open question.
    #[test]
    fn an_imported_binding_and_a_shadowing_local_are_different_symbols() {
        // feature.ts from the OX-A fixture: `label` here is the import.
        let (allocator, source) = model(
            "import { label } from './shared';\nconst inner = 'FEATURE_LOCAL';\nexport function describe() { return label() + inner; }\n",
        );
        let parsed = oxc_parser::Parser::new(&allocator, &source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let scoping = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&parsed.program)
            .semantic
            .into_scoping();
        let identity = ModuleIdentity::new(scoping);

        // The import's local binding.
        let Statement::ImportDeclaration(import) = &parsed.program.body[0] else {
            panic!("expected an import declaration");
        };
        let specifiers = import.specifiers.as_ref().expect("named import");
        let imported_local = specifiers[0].local();
        let imported_key = identity.key_of_binding(imported_local);

        // The module's own top-level const.
        let Statement::VariableDeclaration(inner_decl) = &parsed.program.body[1] else {
            panic!("expected a variable declaration");
        };
        let inner_key = identity.key_of_binding(
            inner_decl.declarations[0]
                .id
                .get_binding_identifier()
                .expect("plain binding"),
        );

        assert_ne!(imported_key, inner_key);
        assert_eq!(identity.symbol(imported_key), "label");
        assert_eq!(identity.symbol(inner_key), "inner");
        // And the reference inside `describe` resolves to the import, not to
        // anything named `label` in another module.
        assert_eq!(
            identity
                .scoping_for_test()
                .get_resolved_references(imported_key.into_symbol_id_for_test())
                .count(),
            1,
        );
    }

    /// Site 2: keys built from *synthesised* identifiers.
    ///
    /// `emit_runtime` mints generated runtime bindings (`__require`,
    /// `__exports`, …) and keys a rename map on them. Under swc a synthesised
    /// `Ident` still produced an `Id` — an empty `SyntaxContext` plus the name —
    /// which is why it could compare equal to an authored binding of the same
    /// name. Under oxc a builder-made node carries no `reference_id` at all, so
    /// the question is what the model does when asked.
    ///
    /// Answer, measured: `IdentifierReference::reference_id()` is documented
    /// "only use on a post-semantic AST" and `unwrap()`s internally, so the
    /// first version of this test **panicked** instead of reporting absence.
    /// `key_of_reference` now reads the `Cell` directly and is total, so a
    /// synthesised node returns `None` and `is_global` reports true. That is a
    /// safe failure — a synthesised node can never be mistaken for an authored
    /// binding — but it also means **identity is not the tool for tracking
    /// generated bindings**. The contract for the port: a pass that synthesises
    /// names either (a) tracks them out of band by name, as `emit_runtime`
    /// already effectively does through its allocator, or (b) re-runs
    /// `SemanticBuilder` after synthesis if it needs real symbols. It must not
    /// ask this API about a node it just built.
    #[test]
    fn a_synthesised_identifier_has_no_key_and_reads_as_global() {
        let (allocator, source) = model("const authored = 1;\n");
        let parsed = oxc_parser::Parser::new(&allocator, &source, SourceType::mjs()).parse();
        let scoping = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&parsed.program)
            .semantic
            .into_scoping();
        let identity = ModuleIdentity::new(scoping);
        let builder = oxc_ast::builder::AstBuilder::new(&allocator);

        // Built after the model, exactly as an emission pass would.
        let synthesised = IdentifierReference::new(oxc_span::SPAN, "authored", &builder);

        assert!(identity.key_of_reference(&synthesised).is_none());
        assert!(identity.is_global(&synthesised));
    }

    /// Site 1: `type_metadata`'s key re-spelling, and `remap_id_keyed_map`.
    ///
    /// They exist only because a swc key *contains* its name. If a `SymbolId`
    /// survives a rename then both are dead code under oxc rather than work to
    /// port — this test is the evidence for deleting them.
    #[test]
    fn a_symbol_keeps_its_key_across_a_rename() {
        let (allocator, source) =
            model("let value = 1;\nexport function read() { return value; }\n");
        let parsed = oxc_parser::Parser::new(&allocator, &source, SourceType::mjs()).parse();
        let scoping = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&parsed.program)
            .semantic
            .into_scoping();
        let mut identity = ModuleIdentity::new(scoping);

        let Statement::VariableDeclaration(decl) = &parsed.program.body[0] else {
            panic!("expected a variable declaration");
        };
        let key =
            identity.key_of_binding(decl.declarations[0].id.get_binding_identifier().unwrap());
        assert_eq!(identity.symbol(key), "value");

        identity.rename(key, FromIn::from_in("value_3", &allocator));

        // Same key, new name: nothing keyed on it needs remapping.
        assert_eq!(identity.symbol(key), "value_3");
        let key_again =
            identity.key_of_binding(decl.declarations[0].id.get_binding_identifier().unwrap());
        assert_eq!(key, key_again);
    }
}
