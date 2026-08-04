//! `global_this.rs`, ported to oxc: the vertical slice of the atomic swap.
//!
//! Chosen because 149 lines of it exercise four of the port's cost drivers at
//! once: the identity API, a read visitor, a *mutating* visitor that replaces an
//! expression node, and one of the 15 generated-snippet parses. What it cost and
//! what it forced is recorded in `/tmp/gcc-oxd2.md`.

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::{Expression, IdentifierName, MemberExpression, Program, VariableDeclarator};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_span::SPAN;
use oxc_str::Ident;

use std::collections::HashSet;

use super::identity_oxc::{BindingKeySet, ModuleIdentity};

pub(crate) fn collect_global_this_compat_property_names(
    program: &Program<'_>,
    identity: &ModuleIdentity,
) -> HashSet<String> {
    let mut collector = GlobalThisCompatCollector {
        aliases: BindingKeySet::new(),
        identity,
        properties: HashSet::new(),
    };
    collector.visit_program(program);
    collector.properties
}

struct GlobalThisCompatCollector<'i> {
    aliases: BindingKeySet,
    identity: &'i ModuleIdentity,
    properties: HashSet<String>,
}

impl GlobalThisCompatCollector<'_> {
    fn is_global_object_expr(&self, expr: &Expression<'_>) -> bool {
        let Expression::Identifier(ident) = expr else {
            return false;
        };
        // swc: `ident.sym == "globalThis" && ident.ctxt == unresolved_ctxt`.
        // oxc: a free reference *is* the unresolved case, and an alias is a
        // resolved one, so the two arms split on `key_of_reference`.
        match self.identity.key_of_reference(ident) {
            None => ident.name == "globalThis",
            Some(key) => self.aliases.contains(&key),
        }
    }
}

impl<'a> Visit<'a> for GlobalThisCompatCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (Some(binding), Some(init)) = (
            declarator.id.get_binding_identifier(),
            declarator.init.as_ref(),
        ) {
            if self.is_global_object_expr(init) {
                self.aliases.insert(self.identity.key_of_binding(binding));
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        if self.is_global_object_expr(member.object()) {
            if let Some(name) = member.static_property_name() {
                self.properties.insert(name.to_string());
            }
        }
        walk::walk_member_expression(self, member);
    }
}

/// Replaces a free `globalThis.<name>`-shaped read with the member expression.
///
/// The swc version parsed a generated snippet (`globalThis.foo;`) and cloned the
/// resulting node in. That does not port: an oxc node belongs to the arena it was
/// parsed in, so a snippet parsed with its own `Allocator` cannot be spliced into
/// this program. It is built with `AstBuilder` on the program's own arena
/// instead — which is the shape all 15 snippet sites have to take.
pub(crate) struct GlobalThisCompatVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
    property_names: HashSet<String>,
}

impl<'a, 'i> GlobalThisCompatVisitor<'a, 'i> {
    pub(crate) fn new(
        allocator: &'a Allocator,
        identity: &'i ModuleIdentity,
        property_names: HashSet<String>,
    ) -> Self {
        Self {
            allocator,
            builder: AstBuilder::new(allocator),
            identity,
            property_names,
        }
    }

    fn global_this_property(&self, allocator: &'a Allocator, name: &str) -> Expression<'a> {
        // Any string our passes carry (analysis results, metadata) lives outside
        // the arena and has to be interned before it can enter the AST.
        let name: Ident<'a> = Ident::from_in(name, allocator);
        // 0.142 builds nodes through associated `new_*` constructors that take
        // the builder (the AST structs are `#[non_exhaustive]`, so struct
        // literals are not an option). Every synthesised node in the port has to
        // be written this way, against the program's own arena.
        let object = Expression::new_identifier(SPAN, "globalThis", &self.builder);
        if is_valid_identifier(name.as_str()) {
            Expression::new_static_member_expression(
                SPAN,
                object,
                IdentifierName::new(SPAN, name, &self.builder),
                false,
                &self.builder,
            )
        } else {
            let key = Expression::new_string_literal(SPAN, name, None, &self.builder);
            Expression::new_computed_member_expression(SPAN, object, key, false, &self.builder)
        }
    }
}

impl<'a> VisitMut<'a> for GlobalThisCompatVisitor<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr);
        let Expression::Identifier(ident) = expr else {
            return;
        };
        if !self.identity.is_global(ident) {
            return;
        }
        if !self.property_names.contains(ident.name.as_str()) {
            return;
        }
        *expr = self.global_this_property(self.allocator, ident.name.as_str());
    }
}

fn is_valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    /// Parse -> semantic -> our ported passes -> print, on the real oxc stack.
    fn run(source: &str) -> (Vec<String>, String) {
        let allocator = Allocator::default();
        let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        let scoping = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&program)
            .semantic
            .into_scoping();
        let identity = ModuleIdentity::new(scoping);

        let mut names = collect_global_this_compat_property_names(&program, &identity)
            .into_iter()
            .collect::<Vec<_>>();
        names.sort();

        let mut visitor =
            GlobalThisCompatVisitor::new(&allocator, &identity, names.iter().cloned().collect());
        visitor.visit_program(&mut program);
        (names, Codegen::new().build(&program).code)
    }

    #[test]
    fn collects_properties_through_globalthis_and_its_aliases() {
        // The swc original keyed "is this globalThis" on the unresolved mark and
        // an alias set. Same two arms here, split on whether the reference
        // resolves to a symbol at all.
        let (names, _) = run("const g = globalThis;\ng.myFlag;\nglobalThis.other;\n");
        assert_eq!(names, vec!["myFlag".to_string(), "other".to_string()]);
    }

    #[test]
    fn a_shadowing_local_is_not_globalthis() {
        // The property of the whole exercise: a *bound* `globalThis` is not the
        // global one. Under swc this needed the resolver's contexts; here the
        // reference simply resolves to a symbol.
        let (names, _) = run("function f(globalThis) { return globalThis.shadowed; }\n");
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn rewrites_a_free_reference_to_a_globalthis_property_read() {
        // The mutating half: a free `myFlag` becomes `globalThis.myFlag`, built
        // with the builder on the program's own arena (a snippet parsed in a
        // separate arena could not be spliced in).
        let (_, code) = run("const g = globalThis;\ng.myFlag;\nmyFlag;\n");
        assert!(code.contains("globalThis.myFlag"), "{code}");
    }

    #[test]
    fn a_non_identifier_property_becomes_a_computed_read() {
        let (_, code) = run("globalThis[\"has-dash\"];\n");
        assert!(code.contains("globalThis[\"has-dash\"]"), "{code}");
    }
}

#[cfg(test)]
mod print_granularity {
    //! Load-bearing check for `emit_goog`/`emit_hoist`/`emit_runtime` (2,215
    //! lines): they assemble output as *text*, printing individual statements
    //! and interleaving generated `goog.module` scaffolding. That architecture
    //! only ports if a single statement can be printed on its own.
    use oxc_allocator::Allocator;
    use oxc_codegen::{Codegen, Gen};
    use oxc_span::SourceType;

    #[test]
    fn a_single_statement_can_be_printed_on_its_own() {
        let allocator = Allocator::default();
        let parsed = oxc_parser::Parser::new(
            &allocator,
            "const a = 1;\nfunction f() { return a; }\n",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty());
        let program = parsed.program;

        // Print statement 1 alone by moving it into a fresh Program in the SAME
        // arena -- the swc `print_module_item` trick, one arena constraint added.
        let printed: Vec<String> = program
            .body
            .iter()
            .map(|statement| {
                // 0.142 exposes `print_expression` but no `print_statement`, so
                // a statement is printed through the `Gen` trait the codegen
                // implements for every node.
                let mut single = Codegen::new();
                statement.print(&mut single, oxc_codegen::Context::default());
                single.into_source_text()
            })
            .collect();

        assert_eq!(printed.len(), 2);
        assert!(printed[0].contains("const a = 1"), "{printed:?}");
        assert!(printed[1].contains("function f()"), "{printed:?}");
    }
}
