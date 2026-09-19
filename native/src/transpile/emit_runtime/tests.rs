use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_span::SourceType;

use super::super::context::collect_raw_bundler_exports;
use super::super::{ChunkMode, TranspileContext};

fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> Result<Program<'a>, String> {
    let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return Err(format!(
            "Failed to parse runtime fixture: {:?}",
            parsed.diagnostics
        ));
    }
    Ok(parsed.program)
}

fn context(workspace_dir: &Path) -> TranspileContext {
    TranspileContext {
        bundler_module_slots: HashMap::new(),
        goog_live_modules: HashMap::new(),
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
fn namespace_reexport_does_not_flatten_star_exports() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!(
        "gcc-ns-reexport-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    std::fs::create_dir_all(&root)?;
    let dep = root.join("dep.js");
    let ns_entry = root.join("ns.js");
    let star_entry = root.join("star.js");
    std::fs::write(&dep, "export const named = 1; export default 2;\n")?;
    std::fs::write(&ns_entry, "export * as ns from \"./dep.js\";\n")?;
    std::fs::write(&star_entry, "export * from \"./dep.js\";\n")?;

    let allocator = Allocator::default();
    let ns_source = std::fs::read_to_string(&ns_entry)?;
    let star_source = std::fs::read_to_string(&star_entry)?;
    let ns_program = parse(&allocator, &ns_source)?;
    let star_program = parse(&allocator, &star_source)?;
    let resolution = context(&root);

    let ns_raw = collect_raw_bundler_exports(&ns_program, &ns_entry, &resolution)?;
    assert_eq!(ns_raw.explicit_exports, BTreeSet::from(["ns".to_string()]));
    assert!(ns_raw.export_all_modules.is_empty());

    let star_raw = collect_raw_bundler_exports(&star_program, &star_entry, &resolution)?;
    assert!(star_raw.explicit_exports.is_empty());
    assert_eq!(star_raw.export_all_modules.len(), 1);

    std::fs::remove_dir_all(root)?;
    Ok(())
}
