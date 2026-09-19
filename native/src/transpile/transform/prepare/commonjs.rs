use std::collections::HashSet;

use oxc_allocator::{Allocator, FromIn, Vec};
use oxc_ast::ast::{
    BindingPattern, Expression, ImportDeclarationSpecifier, ImportOrExportKind, Program, Statement,
    VariableDeclarationKind,
};
use oxc_ast::builder::AstBuilder;
use oxc_span::SPAN;
use oxc_str::{Ident, Str};

use super::helpers::{apply_compatibility_transforms, fresh_name, module_export_name};
use crate::transpile::commonjs::variable_statement;
use crate::transpile::fresh::collect_lexical_binding_names;
use crate::transpile::TranspileContext;

pub(crate) fn rewrite_commonjs_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    context: &TranspileContext,
) -> HashSet<String> {
    let builder = AstBuilder::new(allocator);
    let mut used = collect_lexical_binding_names(program);
    apply_compatibility_transforms(allocator, program, context.chunk_mode, &mut used);
    let mut import_counter = 0usize;
    let mut opaque_bindings = HashSet::new();
    let mut body = Vec::with_capacity_in(program.body.len(), &allocator);
    for statement in program.body.drain(..) {
        let Statement::ImportDeclaration(mut import) = statement else {
            body.push(statement);
            continue;
        };
        let specifier = import.source.value.as_str();
        if import.import_kind == ImportOrExportKind::Type
            || !context.commonjs_specifiers.contains(specifier)
        {
            body.push(Statement::ImportDeclaration(import));
            continue;
        }
        let quoted = context.opaque_commonjs.specifier_is_opaque(specifier);
        let mut default_local = None;
        let mut namespace_local = None;
        let mut named = std::vec::Vec::new();
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    default_local = Some(default.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    namespace_local = Some(namespace.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.import_kind != ImportOrExportKind::Type =>
                {
                    named.push((
                        module_export_name(&specifier.imported),
                        specifier.local.name.to_string(),
                    ));
                }
                ImportDeclarationSpecifier::ImportSpecifier(_) => {}
            }
        }
        if namespace_local.is_none() && named.is_empty() {
            if quoted {
                opaque_bindings.extend(default_local);
            }
            body.push(Statement::ImportDeclaration(import));
            continue;
        }
        let helper = default_local.unwrap_or_else(|| {
            let preferred = format!("__cjs_import_{import_counter}");
            import_counter += 1;
            fresh_name(&mut used, &preferred)
        });
        let identifier = |name: &str| {
            Expression::new_identifier(SPAN, Ident::from_in(name, allocator), &builder)
        };
        // Reuse the import node, including its attributes and source span. All
        // authored member nodes elsewhere keep their original metadata offsets.
        import.specifiers = Some(Vec::from_value_in(
            ImportDeclarationSpecifier::new_import_default_specifier(
                SPAN,
                oxc_ast::ast::BindingIdentifier::new(
                    SPAN,
                    Ident::from_in(helper.as_str(), allocator),
                    &builder,
                ),
                &builder,
            ),
            &allocator,
        ));
        body.push(Statement::ImportDeclaration(import));
        if quoted {
            opaque_bindings.insert(helper.clone());
        }
        if let Some(namespace) = namespace_local {
            if namespace != helper {
                body.push(variable_statement(
                    &builder,
                    SPAN,
                    VariableDeclarationKind::Const,
                    BindingPattern::new_binding_identifier(
                        SPAN,
                        Ident::from_in(namespace.as_str(), allocator),
                        &builder,
                    ),
                    identifier(&helper),
                ));
            }
            if quoted {
                opaque_bindings.insert(namespace);
            }
        }
        for (imported, local) in named {
            // String-named ESM imports may not be valid dotted identifiers.
            let access = if quoted || !oxc_syntax::identifier::is_identifier_name(&imported) {
                Expression::new_computed_member_expression(
                    SPAN,
                    identifier(&helper),
                    Expression::new_string_literal(
                        SPAN,
                        Str::from_in(imported.as_str(), allocator),
                        None,
                        &builder,
                    ),
                    false,
                    &builder,
                )
            } else {
                Expression::new_static_member_expression(
                    SPAN,
                    identifier(&helper),
                    oxc_ast::ast::IdentifierName::new(
                        SPAN,
                        Ident::from_in(imported.as_str(), allocator),
                        &builder,
                    ),
                    false,
                    &builder,
                )
            };
            body.push(variable_statement(
                &builder,
                SPAN,
                VariableDeclarationKind::Const,
                BindingPattern::new_binding_identifier(
                    SPAN,
                    Ident::from_in(local.as_str(), allocator),
                    &builder,
                ),
                access,
            ));
        }
    }
    program.body = body;
    opaque_bindings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transpile::context::analysis_resolution_context;
    use crate::transpile::emit_goog::{quote_external_boundary_accesses, ExternalBoundaryEvidence};
    use crate::transpile::identity::ModuleIdentity;
    use crate::transpile::ChunkMode;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn commonjs_imports_and_moved_component_bodies_keep_runtime_and_metadata(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let allocator = Allocator::default();
        let specifier = "data:text/javascript,export default {amount:4,'dash-name':7}";
        let source = format!(
            r#"
            import pkg, {{ amount as count, "dash-name" as dash }} from "{specifier}";
            import * as namespace from "{specifier}";
            const __cjs_import_0 = "occupied";
            const foreign = {{ result: 11, failure: "boom" }};
            const Component = ({{ item, ...rest }}) => [
                foreign.result, item, rest.other, count, dash, namespace.amount, pkg.amount
            ];
            const Nested = ({{ inner: {{ item = foreign.result }} }}) => item;
            function fail() {{ throw foreign.failure; }}
            let caught;
            try {{ fail(); }} catch (error) {{ caught = error; }}
            const probe = [Component({{ item: 2, other: 3 }}), Nested({{ inner: {{}} }}), caught];
        "#
        );
        let parsed = Parser::new(&allocator, &source, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        let path = Path::new("/work/entry.js");
        let mut context = analysis_resolution_context(Path::new("/work"), &[], &HashMap::new());
        context.chunk_mode = ChunkMode::Off;
        context.commonjs_specifiers.insert(specifier.to_string());
        rewrite_commonjs_imports(&allocator, &mut program, &context);
        let semantic = SemanticBuilder::new().build(&program);
        assert!(
            semantic.diagnostics.is_empty(),
            "{:?}",
            semantic.diagnostics
        );
        let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
        let offsets = source
            .match_indices("foreign.")
            .map(|(start, _)| u32::try_from(start + "foreign.".len()))
            .collect::<Result<std::vec::Vec<_>, _>>()?;
        let metadata = serde_json::from_value(serde_json::json!({
            "filePath": path,
            "sourceFilePath": path,
            "externalOwnedMemberAccesses": offsets,
        }))?;
        quote_external_boundary_accesses(
            &allocator,
            path,
            &mut program,
            &identity,
            &context,
            Some(&metadata),
            ExternalBoundaryEvidence::All,
        )?;
        let code = Codegen::new().build(&program).code;
        // These authored members moved into generated arrow/throw bodies. Their
        // external evidence must still protect the emitted property access.
        assert!(code.contains("foreign[\"result\"]"), "{code}");
        assert!(code.contains("foreign[\"failure\"]"), "{code}");
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "--eval"])
            .arg(format!(
                "const goog = {{ reflect: {{ objectProperty: key => key }} }};\n{code}\nconsole.log(JSON.stringify(probe));"
            ))
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            r#"[[11,2,3,4,7,4,4],11,"boom"]"#,
        );
        Ok(())
    }
}
