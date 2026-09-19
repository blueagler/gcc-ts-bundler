use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use super::super::identity::ModuleIdentity;
use super::super::{resolved_import_key, ChunkMode, TranspileContext};
use super::external::allocate_boundary_identity_tokens_with;
use super::live_bindings::live_export_bindings_of_program;
use super::print::{emit_goog_module_program, emit_goog_module_text};
use crate::closure_metadata::ClosureFileMetadata;

fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
    parse_with_source_type(allocator, source, SourceType::mjs())
}

fn parse_with_source_type<'a>(
    allocator: &'a Allocator,
    source: &'a str,
    source_type: SourceType,
) -> (Program<'a>, ModuleIdentity) {
    let parsed = Parser::new(allocator, source, source_type).parse();
    assert!(
        !parsed.fatal_error && parsed.diagnostics.is_empty(),
        "{:?}",
        parsed.diagnostics
    );
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&parsed.program);
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    (parsed.program, identity)
}

fn context(workspace_dir: &Path) -> TranspileContext {
    TranspileContext {
        bundler_module_slots: HashMap::new(),
        goog_live_modules: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: ChunkMode::Off,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        boundary_identity_tokens: HashMap::new(),
        external_specifiers: HashMap::new(),
        opaque_external_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        authored_enum_values: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: Vec::new(),
        preserved_modules: HashMap::new(),
        resolved_module_ids: HashMap::new(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: false,
        pin_cross_chunk_assigners: false,
        workspace_dir: workspace_dir.to_path_buf(),
    }
}

#[test]
fn object_assign_result_keeps_copied_properties_renameable(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!(
        "gcc-emit-goog-external-object-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.js");
    let source = "const assign = Object.assign; const record = {}; const matcher = assign({}, { record }); matcher.record;";
    std::fs::write(&entry, source)?;
    let allocator = Allocator::default();
    let (mut program, identity) = parse(&allocator, source);
    let metadata = ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        external_global_member_accesses: vec![source
            .find("Object.assign")
            .map(|start| start + "Object.".len())
            .ok_or("Object.assign member is missing")?
            .try_into()?],
        external_owned_member_accesses: Vec::new(),
        file_path: entry.to_string_lossy().into_owned(),
        source_file_path: entry.to_string_lossy().into_owned(),
        symbols: Vec::new(),
    };
    let oxc = emit_goog_module_program(
        &allocator,
        &entry,
        &mut program,
        &identity,
        &context(&root),
        Some(&metadata),
        None,
    )?
    .code;
    assert!(oxc.contains("{ record }"), "{oxc}");
    assert!(oxc.contains("matcher.record"), "{oxc}");
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn external_owned_optional_chain_member_is_quoted() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!(
        "gcc-emit-goog-optional-external-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.js");
    let source = "const value = input?.resolvedFileName;";
    std::fs::write(&entry, source)?;
    let allocator = Allocator::default();
    let (mut program, identity) = parse(&allocator, source);
    let metadata = ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        external_global_member_accesses: Vec::new(),
        external_owned_member_accesses: vec![source
            .find("resolvedFileName")
            .ok_or("resolvedFileName member is missing")?
            .try_into()?],
        file_path: entry.to_string_lossy().into_owned(),
        source_file_path: entry.to_string_lossy().into_owned(),
        symbols: Vec::new(),
    };
    let oxc = emit_goog_module_program(
        &allocator,
        &entry,
        &mut program,
        &identity,
        &context(&root),
        Some(&metadata),
        None,
    )?
    .code;
    assert!(oxc.contains("input?.[\"resolvedFileName\"]"), "{oxc}");
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn boundary_identity_tokens_are_order_independent_and_extend_collisions() {
    let first =
        allocate_boundary_identity_tokens_with(["zeta".to_string(), "alpha".to_string()], |_| {
            "0000000000".to_string()
        });
    let second =
        allocate_boundary_identity_tokens_with(["alpha".to_string(), "zeta".to_string()], |_| {
            "0000000000".to_string()
        });
    assert_eq!(first, second);
    assert_eq!(first["alpha"], "0000000000z0");
    assert_eq!(first["zeta"], "0000000000z1");
}

#[test]
fn external_boundary_names_are_workspace_relative() -> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::temp_dir().join(format!(
        "gcc-emit-goog-path-independent-{}",
        std::process::id()
    ));
    let source = r#"import external from "external-package"; export default external;"#;
    let mut outputs = Vec::new();
    for stage in ["stage-1", "stage-2"] {
        let workspace = base.join(stage);
        let entry = workspace.join("src/entry.ts");
        std::fs::create_dir_all(entry.parent().ok_or("entry parent is missing")?)?;
        std::fs::write(&entry, source)?;
        let allocator = Allocator::default();
        let source_type = SourceType::from_path(Path::new("entry.ts"))?.with_module(true);
        let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
        let mut transpile_context = context(&workspace);
        transpile_context.external_specifiers.insert(
            resolved_import_key(&entry, "external-package"),
            "external-package".to_string(),
        );
        outputs.push(
            emit_goog_module_program(
                &allocator,
                &entry,
                &mut program,
                &identity,
                &transpile_context,
                None,
                None,
            )?
            .code,
        );
    }
    assert_eq!(outputs[0], outputs[1]);
    assert!(outputs[0].contains('e'));
    assert!(!outputs[0].contains("__gcc_external_"));
    std::fs::remove_dir_all(base)?;
    Ok(())
}

#[test]
fn external_owned_spread_clone_assignment_is_quoted() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!(
        "gcc-emit-goog-spread-clone-assignment-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.ts");
    let source = r#"
        import external from "external-package";
        const clone = { ...external };
        clone.value = 1;
    "#;
    std::fs::write(&entry, source)?;
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new("entry.ts"))?.with_module(true);
    let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
    let metadata = ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        external_global_member_accesses: Vec::new(),
        external_owned_member_accesses: vec![source
            .rfind("value")
            .ok_or("value member is missing")?
            .try_into()?],
        file_path: entry.to_string_lossy().into_owned(),
        source_file_path: entry.to_string_lossy().into_owned(),
        symbols: Vec::new(),
    };
    let mut transpile_context = context(&root);
    transpile_context.external_specifiers.insert(
        resolved_import_key(&entry, "external-package"),
        "external-package".to_string(),
    );
    let oxc = emit_goog_module_program(
        &allocator,
        &entry,
        &mut program,
        &identity,
        &transpile_context,
        Some(&metadata),
        None,
    )?
    .code;
    assert!(oxc.contains("clone[\"value\"] = 1"), "{oxc}");
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn external_boundary_value_forms_quote_following_members() -> Result<(), Box<dyn std::error::Error>>
{
    let root = std::env::temp_dir().join(format!(
        "gcc-emit-goog-external-forms-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.ts");
    let source = r#"
        import * as external from "external-package";
        let assigned;
        const direct = external.value;
        external.value = 1;
        external.value++;
        const element = external["value"];
        const called = external.make().value;
        const chainedCall = external.make?.().value;
        const parenthesized = (external).value;
        const sequenced = (0, external).value;
        const conditional = (true ? external : external).value;
        const logical = (false || external).value;
        const tagged = external.tag`x`.value;
        const assignment = (assigned = external).value;
        const awaited = (await external.make()).value;
        const constructed = (new external.Factory()).value;
        const asExpression = (external as unknown).value;
        const satisfiesExpression = (external satisfies unknown).value;
        const asserted = (<unknown>external).value;
        const nonNull = external!.value;
        const instantiated = external.make<string>().value;
    "#;
    std::fs::write(&entry, source)?;
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new("entry.ts"))?.with_module(true);
    let (mut program, identity) = parse_with_source_type(&allocator, source, source_type);
    let mut transpile_context = context(&root);
    transpile_context.external_specifiers.insert(
        resolved_import_key(&entry, "external-package"),
        "external-package".to_string(),
    );
    let oxc = emit_goog_module_program(
        &allocator,
        &entry,
        &mut program,
        &identity,
        &transpile_context,
        None,
        None,
    )?
    .code;
    assert!(!oxc.contains(".value"), "{oxc}");
    assert!(oxc.matches("[\"value\"]").count() >= 19, "{oxc}");
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn anonymous_default_forms_are_exported() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("gcc-emit-goog-default-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.js");
    for source in [
        "export default () => 1;",
        "export default function() { return 2; }",
        "export default class { method() { return 3; } }",
    ] {
        std::fs::write(&entry, source)?;
        let allocator = Allocator::default();
        let (mut program, identity) = parse(&allocator, source);
        let oxc = emit_goog_module_text(
            &allocator,
            &entry,
            &mut program,
            &identity,
            &context(&root),
            None,
        )?;
        assert!(oxc.contains("exports.default ="), "source: {source}\n{oxc}");
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn statement_printing_keeps_only_the_allowed_pure_annotation(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("gcc-emit-goog-comments-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let entry = root.join("entry.js");
    let source = r"
        /** @const HOSTILE */ const value = 1;
        /*#__PURE__*/ make();
        function make() { return value; }
    ";
    std::fs::write(&entry, source)?;
    let allocator = Allocator::default();
    let (mut program, identity) = parse(&allocator, source);
    let oxc = emit_goog_module_text(
        &allocator,
        &entry,
        &mut program,
        &identity,
        &context(&root),
        None,
    )?;
    assert!(!oxc.contains("HOSTILE"), "{oxc}");
    assert!(oxc.contains("@__PURE__"), "{oxc}");
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn live_export_facts_cover_aliases_and_invalidations() -> Result<(), String> {
    let source = r#"
        let direct = 0, local = 1, stable = 2;
        export { local as renamed, stable };
        export let exported = 3;
        direct += 1;
        local++;
        exported = 4;
        export { direct as "not-valid-name" };
    "#;
    let allocator = Allocator::default();
    let (program, identity) = parse(&allocator, source);
    let oxc = live_export_bindings_of_program(&program, &identity)?;
    assert_eq!(
        oxc,
        BTreeMap::from([
            ("exported".to_string(), "exported".to_string()),
            ("renamed".to_string(), "local".to_string()),
        ])
    );
    Ok(())
}
