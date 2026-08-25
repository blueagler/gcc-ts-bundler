use super::*;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use super::super::context::collect_raw_bundler_exports;
use super::super::identity::ModuleIdentity;
use super::super::{to_goog_module_id, BundlerModuleSlots, ChunkMode, TranspileContext};

fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
    let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
    assert!(
        !parsed.panicked && parsed.diagnostics.is_empty(),
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
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        boundary_identity_tokens: HashMap::new(),
        external_specifiers: HashMap::new(),
        opaque_external_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        hoist_plan: None,
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: Vec::new(),
        preserved_modules: HashMap::new(),
        resolved_module_ids: HashMap::new(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: false,
        assigner_pin_module_ids: HashSet::new(),
        workspace_dir: workspace_dir.to_path_buf(),
    }
}

#[test]
fn namespace_reexport_is_one_name_and_includes_default() {
    let root = std::env::temp_dir().join(format!(
        "gcc-ns-reexport-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let dep = root.join("dep.js");
    let ns_entry = root.join("ns.js");
    let star_entry = root.join("star.js");
    std::fs::write(&dep, "export const named = 1; export default 2;\n").unwrap();
    std::fs::write(&ns_entry, "export * as ns from \"./dep.js\";\n").unwrap();
    std::fs::write(&star_entry, "export * from \"./dep.js\";\n").unwrap();

    let allocator = Allocator::default();
    let ns_source = std::fs::read_to_string(&ns_entry).unwrap();
    let star_source = std::fs::read_to_string(&star_entry).unwrap();
    let (ns_program, _) = parse(&allocator, &ns_source);
    let (star_program, _) = parse(&allocator, &star_source);
    let resolution = context(&root);

    let ns_raw = collect_raw_bundler_exports(&ns_program, &ns_entry, &resolution).unwrap();
    assert_eq!(ns_raw.explicit_exports, BTreeSet::from(["ns".to_string()]));
    assert!(ns_raw.export_all_modules.is_empty());

    let star_raw = collect_raw_bundler_exports(&star_program, &star_entry, &resolution).unwrap();
    assert!(star_raw.explicit_exports.is_empty());
    assert_eq!(star_raw.export_all_modules.len(), 1);

    let dep_id = to_goog_module_id(&dep, &root);
    let ns_id = to_goog_module_id(&ns_entry, &root);
    let star_id = to_goog_module_id(&star_entry, &root);
    let dep_slots = BundlerModuleSlots::from_export_names(&BTreeSet::from([
        "default".to_string(),
        "named".to_string(),
    ]));
    let ns_slots = BundlerModuleSlots::from_export_names(&BTreeSet::from(["ns".to_string()]));
    let star_slots = BundlerModuleSlots::from_export_names(&BTreeSet::from(["named".to_string()]));

    let mut ns_context = context(&root);
    ns_context.bundler_module_slots =
        HashMap::from([(dep_id.clone(), dep_slots.clone()), (ns_id, ns_slots)]);
    let (mut ns_emit_program, ns_identity) = parse(&allocator, &ns_source);
    let ns_emitted = emit_bundler_runtime_module_text(
        &allocator,
        &ns_entry,
        &mut ns_emit_program,
        &ns_identity,
        &ns_context,
        None,
        None,
    )
    .unwrap()
    .code;
    assert!(
        ns_emitted.contains("get default(){return ") && ns_emitted.contains("get named(){return "),
        "{ns_emitted}"
    );
    assert!(
        !ns_emitted.contains("\"default\"") && !ns_emitted.contains("\"named\""),
        "{ns_emitted}"
    );

    let mut star_context = context(&root);
    star_context.bundler_module_slots = HashMap::from([(dep_id, dep_slots), (star_id, star_slots)]);
    let (mut star_emit_program, star_identity) = parse(&allocator, &star_source);
    let star_emitted = emit_bundler_runtime_module_text(
        &allocator,
        &star_entry,
        &mut star_emit_program,
        &star_identity,
        &star_context,
        None,
        None,
    )
    .unwrap()
    .code;
    assert!(
        !star_emitted.contains("get default") && !star_emitted.contains("default()"),
        "{star_emitted}"
    );
    assert!(
        star_emitted.contains("__live") || star_emitted.contains("function(){return "),
        "{star_emitted}"
    );

    std::fs::remove_dir_all(root).unwrap();
}
