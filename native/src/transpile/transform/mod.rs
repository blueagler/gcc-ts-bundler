use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use crate::commonjs::analyze_commonjs_program;

use super::commonjs;
use super::emit::{emit_module_program_oxc, EmittedProgram};
use super::js_compat::should_normalize_commonjs;
use super::{ClosureFileMetadata, TranspileContext};

mod prepare;
mod rewrite;
mod visitors;

use prepare::rewrite_commonjs_imports;
use rewrite::{
    collect_imported_enum_values, quote_opaque_commonjs_members, quote_runtime_enum_members,
    remove_unused_imported_enums, rewrite_dynamic_imports, rewrite_ts_export_assignments,
};
use visitors::preserve_property_names;

pub(super) fn transform_source_with_oxc(
    file_path: &Path,
    source: &str,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    authored_path: &Path,
) -> Result<EmittedProgram, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    let mut program = parse_program(&allocator, source, source_type, file_path)?;
    let commonjs_analysis = analyze_commonjs_program(&program);
    let commonjs_export_name = if should_normalize_commonjs(authored_path, &commonjs_analysis) {
        commonjs::normalize_program(
            &allocator,
            file_path,
            &mut program,
            &commonjs_analysis,
            context.opaque_commonjs.file_is_opaque(authored_path),
            context,
        )?;
        Some("__cjsExports")
    } else {
        None
    };
    // AST edits retain authored spans, including moved arrow bodies and throw
    // arguments. External member metadata stays in that coordinate system:
    // no generated-source offsets or remapping table are needed.
    let opaque_commonjs_bindings = rewrite_commonjs_imports(&allocator, &mut program, context);
    rewrite_ts_export_assignments(&allocator, &mut program);
    let mut enum_values = collect_imported_enum_values(file_path, &program, context);
    let local_enum_values = super::lowering::collect_enum_values(&program);
    let imported_enum_names = enum_values.keys().cloned().collect::<HashSet<_>>();
    let safe_enums = file_metadata
        .into_iter()
        .flat_map(|metadata| metadata.enums.iter())
        .map(|declaration| declaration.binding_name.clone())
        .collect::<HashSet<_>>();
    if !safe_enums.is_empty() {
        for name in &safe_enums {
            if let Some(members) = local_enum_values.get(name) {
                enum_values.insert(name.clone(), members.clone());
            }
        }
        super::lowering::remove_enum_declarations(&mut program, &safe_enums);
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(false)
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let scoping = semantic.semantic.into_scoping();
    let mut identity = super::lowering::transform_program_with_enum_values(
        &allocator,
        file_path,
        &mut program,
        scoping,
        matches!(
            file_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("jsx" | "tsx")
        ),
        enum_values,
    )?;

    remove_unused_imported_enums(&mut program, &identity, &imported_enum_names)?;
    quote_runtime_enum_members(&allocator, &mut program, &identity, &local_enum_values)?;
    quote_opaque_commonjs_members(
        &allocator,
        &mut program,
        &identity,
        &opaque_commonjs_bindings,
    )?;
    super::js_compat::apply_program_transforms(&allocator, &mut program, &identity, source)?;
    super::emit_helpers::rewrite_this_field_helper_assignments(&allocator, &mut program);

    rewrite_dynamic_imports(&allocator, &mut program, authored_path, context);
    preserve_property_names(&allocator, &mut program, context);
    let class_map_property_names = super::compat_properties::apply(
        &allocator,
        &mut program,
        &identity,
        &context.class_map_calls,
    )?;
    let mut emitted = emit_module_program_oxc(
        &allocator,
        file_path,
        &mut program,
        &mut identity,
        context,
        file_metadata,
        commonjs_export_name,
    )?;
    emitted.code = super::lowering::materialize_closure_casts(&emitted.code);
    // Symmetry: a key pinned as a literal on the write side must also be
    // pinned on every dot-access read side, or the two halves disagree.
    emitted
        .reflective_property_names
        .extend(class_map_property_names);
    // Retained enum objects expose their member names to runtime consumers.
    // Generated declarations are inserted after AST reflection analysis.
    emitted.reflective_property_names.extend(
        file_metadata
            .into_iter()
            .flat_map(|metadata| &metadata.enums)
            .flat_map(|declaration| declaration.members.iter().map(|member| member.name.clone())),
    );
    Ok(emitted)
}

fn parse_program<'a>(
    allocator: &'a Allocator,
    source: &'a str,
    source_type: SourceType,
    file_path: &Path,
) -> Result<oxc_ast::ast::Program<'a>, String> {
    let parsed = Parser::new(allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(parsed.program)
}

#[cfg(test)]
mod tests {
    use super::visitors::PreservedPropertyVisitor;
    use oxc_allocator::Allocator;
    use oxc_ast::ast::Program;
    use oxc_ast::builder::AstBuilder;
    use oxc_ast_visit::VisitMut;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;
    use std::collections::HashSet;
    use std::path::Path;

    fn lowered(source: &str) -> Result<String, String> {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program: Program<'_> = parsed.program;
        let semantic = SemanticBuilder::new()
            .with_build_nodes(false)
            .with_enum_eval(true)
            .build(&program);
        assert!(
            semantic.diagnostics.is_empty(),
            "{:?}",
            semantic.diagnostics
        );
        let scoping = semantic.semantic.into_scoping();
        super::super::lowering::transform_program(
            &allocator,
            Path::new("fixture.ts"),
            &mut program,
            scoping,
            false,
        )?;
        Ok(Codegen::new().build(&program).code)
    }

    #[test]
    fn oxc_codegen_owns_namespace_iife_precedence() -> Result<(), String> {
        // Literal-only unread namespaces flatten; keep a local read so the IIFE
        // remains and codegen still parenthesizes call/init correctly.
        let output = lowered(
            "namespace Outer { export const x = 1; export const z = x; }\nexport const y = Outer.x;\n",
        )?;
        assert!(output.contains("(function("), "{output}");
        assert!(output.contains("(Outer = {})"), "{output}");
        Ok(())
    }

    #[test]
    fn unread_literal_namespace_keeps_init_and_writes_without_iife() -> Result<(), String> {
        let output =
            lowered("namespace Outer { export const x = 1; }\nexport const y = Outer.x;\n")?;
        assert!(!output.contains("(function("), "{output}");
        assert!(output.contains("Outer || (Outer = {});"), "{output}");
        assert!(output.contains("Outer.x = 1;"), "{output}");
        Ok(())
    }

    #[test]
    fn ordinary_iifes_and_binaries_keep_their_shape() -> Result<(), String> {
        let output =
            lowered("export const a = (function () { return 1; })();\nexport const b = 1 || 2;\n")?;
        assert!(!output.contains("((function"), "{output}");
        assert!(output.contains("1 || 2"), "{output}");
        Ok(())
    }

    #[test]
    fn preserved_static_field_name_stays_dotted() {
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            "class Schema { static warning = 1; rules = null; }",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        PreservedPropertyVisitor {
            allocator: &allocator,
            builder: AstBuilder::new(&allocator),
            names: &HashSet::from(["warning".to_string(), "rules".to_string()]),
        }
        .visit_program(&mut program);
        let output = Codegen::new().build(&program).code;
        // Quoting the static field is what crashes Closure; the instance field
        // is unaffected.
        assert!(output.contains("static warning = 1"), "{output}");
        assert!(output.contains("\"rules\" = null"), "{output}");
    }

    #[test]
    fn preserved_constructor_name_stays_class_syntax() {
        let allocator = Allocator::default();
        let parsed = Parser::new(
            &allocator,
            "class Child extends Error { constructor() { super('x'); } }",
            SourceType::mjs(),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let mut program = parsed.program;
        PreservedPropertyVisitor {
            allocator: &allocator,
            builder: AstBuilder::new(&allocator),
            names: &HashSet::from(["constructor".to_string()]),
        }
        .visit_program(&mut program);
        let output = Codegen::new().build(&program).code;
        assert!(output.contains("constructor()"), "{output}");
        assert!(!output.contains("\"constructor\"()"), "{output}");
    }
}
