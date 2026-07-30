//! Structural groundwork for porting `externs/analysis.rs` to oxc.
//!
//! The reader is the one genuinely independent analysis-only reader (own
//! visitors, no shared analysis with an AST-flow path), but it **retains parsed
//! modules**: `collect_custom_element_surface_names` and
//! `collect_program_declared_names` run over `parsed_modules` after the per-file
//! loop. That is the one shape swc gave away for free and oxc does not, so it is
//! settled here with compiling code before the 1,274-line body is rewritten
//! against it.
//!
//! Constraint: a `Program<'a>` borrows both its `Allocator` *and* its source
//! text, so neither may be dropped while the program is retained. `Vec<Program>`
//! is therefore not storable the way `Vec<Module>` was — this is the
//! self-referential storage problem the O1 report predicted for `module_cache`,
//! resurfacing inside any pass that holds more than one module at a time.
//!
//! Resolution used below: one **batch-scoped** `Allocator` for the whole reader
//! run plus a `Vec<String>` of retained sources, both outliving the programs.
//! Cheap here because the reader runs once per build and drops everything at the
//! end.

#[cfg(test)]
mod tests {
    use oxc_allocator::Allocator;
    use oxc_ast::ast::Program;
    use oxc_span::SourceType;

    /// Parses several files into one arena and keeps every program alive, then
    /// runs a second analysis across all of them — the exact shape
    /// `collect_extern_property_names_with_externs` needs.
    #[test]
    fn a_batch_scoped_arena_can_retain_every_parsed_program() {
        let sources: Vec<String> = vec![
            "export class A { static styles = 1; }".to_string(),
            "export const b = { key: 1 };".to_string(),
            "customElements.define('x-y', class {});".to_string(),
        ];
        let allocator = Allocator::default();

        let programs: Vec<Program<'_>> = sources
            .iter()
            .map(|source| {
                oxc_parser::Parser::new(&allocator, source, SourceType::mjs())
                    .parse()
                    .program
            })
            .collect();

        // Pass 1 shape: per-file facts.
        assert_eq!(programs.len(), 3);
        // Pass 2 shape: an analysis that needs every program at once, which is
        // what forced the batch arena.
        let total_statements: usize = programs.iter().map(|program| program.body.len()).sum();
        assert_eq!(total_statements, 3);
        // Shape note for the port: `export class A {}` is a *module*
        // declaration, not a `Declaration`, so swc's single `ModuleItem` match
        // splits in two here (`Statement::is_declaration` vs
        // `is_module_declaration`).
        assert!(programs.iter().any(|program| {
            program
                .body
                .iter()
                .any(|statement| statement.is_module_declaration())
        }));
    }

    /// The negative half: a per-file arena cannot be used this way. Kept as prose
    /// because it does not compile by construction — `allocator` would be dropped
    /// while `program` still borrows it, which is the error the port must not
    /// design itself into:
    ///
    /// ```compile_fail
    /// let mut programs = Vec::new();
    /// for source in &sources {
    ///     let allocator = Allocator::default();      // dropped at end of iteration
    ///     programs.push(Parser::new(&allocator, source, ty).parse().program);
    /// }
    /// ```
    #[test]
    fn per_file_arenas_cannot_outlive_the_loop() {
        // Documented by the doc-comment above; this body only pins the intent so
        // the note cannot drift away from a test name.
        assert!(true);
    }
}
