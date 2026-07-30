use super::super::emit_hoist::emit_hoist_text_for_test;
use super::*;
use crate::closure_metadata::{
    ClosureEnumDeclaration, ClosureEnumMember, ClosureFileMetadata, ClosureTypeSymbol,
};
use oxc_codegen::{CodegenOptions, CommentOptions, LegalComment};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

fn root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("gcc-emit-hoist-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn parse<'a>(allocator: &'a Allocator, source: &'a str) -> (Program<'a>, ModuleIdentity) {
    let parsed = oxc_parser::Parser::new(allocator, source, SourceType::mjs()).parse();
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let identity = ModuleIdentity::new(
        SemanticBuilder::new()
            .with_build_nodes(true)
            .with_enum_eval(true)
            .build(&parsed.program)
            .semantic
            .into_scoping(),
    );
    (parsed.program, identity)
}

fn normalize(source: &str) -> String {
    let allocator = Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::mjs()).parse();
    assert!(
        !parsed.panicked && parsed.diagnostics.is_empty(),
        "{source}\n{:?}",
        parsed.diagnostics
    );
    Codegen::new()
        .with_options(CodegenOptions {
            comments: CommentOptions {
                normal: false,
                jsdoc: false,
                annotation: false,
                legal: LegalComment::None,
            },
            ..CodegenOptions::default()
        })
        .build(&parsed.program)
        .code
}

fn slots(names: &[&str]) -> super::super::BundlerModuleSlots {
    super::super::BundlerModuleSlots::from_export_names(
        &names
            .iter()
            .map(|name| name.to_string())
            .collect::<BTreeSet<_>>(),
    )
}

#[allow(clippy::too_many_arguments)]
fn context(
    root: &Path,
    files: &[PathBuf],
    chunk_graph: Vec<super::super::TranspileChunkInput>,
    lazy_imports: Vec<super::super::LazyImportInput>,
    file_metadata: HashMap<String, ClosureFileMetadata>,
    slots: HashMap<String, super::super::BundlerModuleSlots>,
    vendor_module_ids: HashSet<String>,
) -> (TranspileContext, HoistPlan) {
    let file_names = files
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let plan = super::super::build_hoist_plan(
        &file_names,
        root,
        &[],
        &HashMap::new(),
        &chunk_graph,
        &lazy_imports,
        &file_metadata,
    )
    .unwrap()
    .expect("hoist plan");
    let bundler_runtime_logical_ids = slots
        .keys()
        .map(|module_id| (to_bundler_runtime_module_id(module_id), module_id.clone()))
        .collect();
    let context = TranspileContext {
        bundler_module_slots: slots,
        bundler_runtime_logical_ids,
        chunk_mode: super::super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        file_metadata,
        hoist_plan: Some(Arc::new(plan.clone())),
        lazy_imports_by_file: super::super::group_lazy_imports_by_file(lazy_imports.clone()),
        lazy_target_module_ids: lazy_imports
            .iter()
            .map(|lazy| lazy.moduleId.clone())
            .collect(),
        package_aliases: Vec::new(),
        resolved_module_ids: HashMap::new(),
        preserved_property_names: HashSet::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: true,
        vendor_module_ids,
        workspace_dir: root.to_path_buf(),
    };
    (context, plan)
}

fn oxc_emit(
    file_path: &Path,
    source: &str,
    context: &TranspileContext,
    plan: &HoistPlan,
    metadata: Option<&ClosureFileMetadata>,
) -> std::result::Result<EmittedProgram, String> {
    let allocator = Allocator::default();
    let (mut program, mut identity) = parse(&allocator, source);
    emit_hoisted_module_text(
        &allocator,
        file_path,
        &mut program,
        &mut identity,
        context,
        plan,
        metadata,
        None,
    )
}

fn metadata(file_path: &Path) -> ClosureFileMetadata {
    ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: vec![crate::closure_metadata::ClosureAnnotation {
            references: Vec::new(),
            target: crate::closure_metadata::ClosureAnnotationTarget::Binding {
                binding_name: "read".to_string(),
            },
            template: "/** @return {number} */\n".to_string(),
            type_bearing: true,
        }],
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        erased_const_enums: Vec::new(),
        file_path: file_path.to_string_lossy().to_string(),
        runtime_module_id: None,
        source_file_path: file_path.to_string_lossy().to_string(),
        symbols: Vec::new(),
    }
}

#[test]
fn hoisted_text_matches_swc_for_renames_direct_and_registry_imports() {
    let root = root("module");
    let entry = root.join("entry.js");
    let origin = root.join("origin.js");
    let registry = root.join("registry.js");
    let origin_source = concat!(
        "export const value = 2;\n",
        "export let live = 1;\n",
        "export function bump() { live++; }\n",
        "export default function render() { return value; }\n",
    );
    let registry_source = "export const remote = 7;\n";
    let entry_source = concat!(
        "import render, { value, live } from './origin.js';\n",
        "import * as ns from './origin.js';\n",
        "import { remote } from './registry.js';\n",
        "const source = { renamed: 4 };\n",
        "const { renamed = 0 } = source;\n",
        "const importedShape = { value };\n",
        "export let state = 0;\n",
        "export const pureValue = /*#__PURE__*/ makeValue();\n",
        "export function mutate() { state += value; }\n",
        "export function read() { return render() + value + live + ns.value + remote + renamed + importedShape.value; }\n",
    );
    std::fs::write(&origin, origin_source).unwrap();
    std::fs::write(&registry, registry_source).unwrap();
    std::fs::write(&entry, entry_source).unwrap();
    let entry_id = to_goog_module_id(&entry, &root);
    let origin_id = to_goog_module_id(&origin, &root);
    let registry_id = to_goog_module_id(&registry, &root);
    let metadata = metadata(&entry);
    let metadata_map = HashMap::from([(
        crate::closure_metadata::closure_metadata_key(&entry),
        metadata.clone(),
    )]);
    let (context, plan) = context(
        &root,
        &[entry.clone(), origin.clone(), registry.clone()],
        vec![
            super::super::TranspileChunkInput {
                dependencies: vec!["shared".to_string()],
                files: vec!["entry.js".to_string()],
                name: "main".to_string(),
            },
            super::super::TranspileChunkInput {
                dependencies: Vec::new(),
                files: vec!["origin.js".to_string()],
                name: "shared".to_string(),
            },
        ],
        Vec::new(),
        metadata_map,
        HashMap::from([
            (
                entry_id.clone(),
                slots(&["mutate", "pureValue", "read", "state"]),
            ),
            (
                origin_id.clone(),
                slots(&["bump", "default", "live", "value"]),
            ),
            (registry_id.clone(), slots(&["remote"])),
        ]),
        HashSet::from([entry_id.clone()]),
    );
    let swc =
        emit_hoist_text_for_test(&entry, entry_source, &context, &plan, Some(&metadata), None)
            .unwrap();
    let oxc = oxc_emit(&entry, entry_source, &context, &plan, Some(&metadata)).unwrap();
    assert_eq!(
        normalize(&oxc.code),
        normalize(&swc.code),
        "swc:\n{}\noxc:\n{}",
        swc.code,
        oxc.code
    );
    assert_eq!(oxc.type_metadata.counts, swc.type_metadata.counts);
    assert_eq!(oxc.type_metadata.diagnostics, swc.type_metadata.diagnostics);
    assert_eq!(oxc.type_metadata.counts.annotationCount, 1);
    let entry_ordinal = plan.ordinal_of(&entry_id).unwrap();
    let origin_ordinal = plan.ordinal_of(&origin_id).unwrap();
    assert!(
        oxc.code
            .contains(&format!("renamed: renamed$${entry_ordinal} = 0")),
        "{}",
        oxc.code
    );
    assert!(
        oxc.code
            .contains(&format!("value: value$${origin_ordinal}")),
        "{}",
        oxc.code
    );
    assert!(oxc.code.contains(PURE_TAG), "{}", oxc.code);
    assert!(oxc.code.contains(NOINLINE_TAG), "{}", oxc.code);
    assert!(
        oxc.code
            .contains(&to_bundler_runtime_module_id(&registry_id)),
        "{}",
        oxc.code
    );
    assert!(!oxc.code.contains("ns."), "{}", oxc.code);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn lazy_reexport_facade_and_dynamic_namespace_match_swc() {
    let root = root("facade");
    let main = root.join("main.js");
    let origin = root.join("origin.js");
    let reexport = root.join("reexport.js");
    std::fs::write(
        &origin,
        "export default function render() { return value; } export let value = 1; export function bump() { value++; }",
    )
    .unwrap();
    let reexport_source = "export { default, value, bump } from './origin.js';";
    std::fs::write(&reexport, reexport_source).unwrap();
    let main_id = to_goog_module_id(&main, &root);
    let origin_id = to_goog_module_id(&origin, &root);
    let reexport_id = to_goog_module_id(&reexport, &root);
    let runtime_reexport_id = to_bundler_runtime_module_id(&reexport_id);
    let main_source = format!(
        "export const load = () => __dynamicImport({runtime_reexport_id:?}).then(ns => ns.default() + ns.value);"
    );
    std::fs::write(&main, &main_source).unwrap();
    let lazy_imports = vec![super::super::LazyImportInput {
        importerFilePath: main.to_string_lossy().to_string(),
        moduleId: reexport_id.clone(),
        specifier: "./reexport.js".to_string(),
        targetPath: reexport.to_string_lossy().to_string(),
    }];
    let (context, plan) = context(
        &root,
        &[main.clone(), origin.clone(), reexport.clone()],
        vec![
            super::super::TranspileChunkInput {
                dependencies: vec!["shared".to_string()],
                files: vec!["main.js".to_string()],
                name: "main".to_string(),
            },
            super::super::TranspileChunkInput {
                dependencies: Vec::new(),
                files: vec!["origin.js".to_string(), "reexport.js".to_string()],
                name: "shared".to_string(),
            },
        ],
        lazy_imports,
        HashMap::new(),
        HashMap::from([
            (main_id, slots(&["load"])),
            (origin_id, slots(&["bump", "default", "value"])),
            (reexport_id.clone(), slots(&["bump", "default", "value"])),
        ]),
        HashSet::new(),
    );
    for (file, source) in [(&main, main_source.as_str()), (&reexport, reexport_source)] {
        let swc = emit_hoist_text_for_test(file, source, &context, &plan, None, None).unwrap();
        let oxc = oxc_emit(file, source, &context, &plan, None).unwrap();
        assert_eq!(
            normalize(&oxc.code),
            normalize(&swc.code),
            "{}\nswc:\n{}\noxc:\n{}",
            file.display(),
            swc.code,
            oxc.code
        );
    }
    let main_output = oxc_emit(&main, &main_source, &context, &plan, None).unwrap();
    assert!(main_output.code.contains("[0]"), "{}", main_output.code);
    assert!(
        !main_output.code.contains(".default"),
        "{}",
        main_output.code
    );
    let facade = oxc_emit(&reexport, reexport_source, &context, &plan, None).unwrap();
    assert!(facade.code.contains("__register("), "{}", facade.code);
    assert!(
        facade.code.contains("Object.defineProperties(__exports"),
        "{}",
        facade.code
    );
    assert!(facade.code.contains("__exports.__esModule = true"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn lexical_collision_forces_registry_fallback_like_swc() {
    let root = root("collision");
    let entry = root.join("entry.js");
    let origin = root.join("origin.js");
    std::fs::write(&origin, "export const value = 1;").unwrap();
    let entry_id = to_goog_module_id(&entry, &root);
    let origin_id = to_goog_module_id(&origin, &root);
    let mut ids = [entry_id.clone(), origin_id.clone()];
    ids.sort();
    let origin_ordinal = ids.iter().position(|id| id == &origin_id).unwrap();
    let direct_name = suffixed_name("value", origin_ordinal);
    let source = format!(
        "import {{ value }} from './origin.js'; import * as ns from './origin.js'; function local({direct_name}) {{ return {direct_name}; }} export function read() {{ return value + ns.value + local(0); }}"
    );
    std::fs::write(&entry, &source).unwrap();
    let (context, plan) = context(
        &root,
        &[entry.clone(), origin.clone()],
        vec![
            super::super::TranspileChunkInput {
                dependencies: vec!["shared".to_string()],
                files: vec!["entry.js".to_string()],
                name: "main".to_string(),
            },
            super::super::TranspileChunkInput {
                dependencies: Vec::new(),
                files: vec!["origin.js".to_string()],
                name: "shared".to_string(),
            },
        ],
        Vec::new(),
        HashMap::new(),
        HashMap::from([(entry_id, slots(&["read"])), (origin_id, slots(&["value"]))]),
        HashSet::new(),
    );
    let swc = emit_hoist_text_for_test(&entry, &source, &context, &plan, None, None).unwrap();
    let oxc = oxc_emit(&entry, &source, &context, &plan, None).unwrap();
    assert_eq!(normalize(&oxc.code), normalize(&swc.code));
    assert!(oxc.code.contains("__require("), "{}", oxc.code);
    assert!(oxc.code.contains("[0]"), "{}", oxc.code);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn anonymous_default_enum_and_shared_helper_keep_consistent_names() {
    let root = root("helper");
    let entry = root.join("entry.js");
    let source = concat!(
        "var __runInitializers = function(value) { return value; };\n",
        "export default function() { return __runInitializers(1); }\n",
    );
    std::fs::write(&entry, source).unwrap();
    let entry_id = to_goog_module_id(&entry, &root);
    let enum_metadata = ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: vec![ClosureEnumDeclaration {
            binding_name: "Kind".to_string(),
            exported: true,
            members: vec![ClosureEnumMember {
                name: "Ready".to_string(),
                value: serde_json::json!(1),
            }],
            symbol_id: "enum:kind".to_string(),
            value_type: "number".to_string(),
        }],
        erased_const_enums: Vec::new(),
        file_path: entry.to_string_lossy().to_string(),
        runtime_module_id: None,
        source_file_path: entry.to_string_lossy().to_string(),
        symbols: vec![ClosureTypeSymbol {
            builtin_name: None,
            declaration_file_path: None,
            declaration_id: None,
            declaration_start: None,
            diagnostic_name: "Kind".to_string(),
            id: "enum:kind".to_string(),
            kind: "runtime".to_string(),
            local_name: Some("Kind".to_string()),
        }],
    };
    let metadata_map = HashMap::from([(
        crate::closure_metadata::closure_metadata_key(&entry),
        enum_metadata.clone(),
    )]);
    let lazy_imports = vec![super::super::LazyImportInput {
        importerFilePath: entry.to_string_lossy().to_string(),
        moduleId: entry_id.clone(),
        specifier: "./entry.js".to_string(),
        targetPath: entry.to_string_lossy().to_string(),
    }];
    let (context, plan) = context(
        &root,
        std::slice::from_ref(&entry),
        vec![super::super::TranspileChunkInput {
            dependencies: Vec::new(),
            files: vec!["entry.js".to_string()],
            name: "main".to_string(),
        }],
        lazy_imports,
        metadata_map,
        HashMap::from([(entry_id, slots(&["Kind", "default"]))]),
        HashSet::new(),
    );
    let swc = emit_hoist_text_for_test(&entry, source, &context, &plan, Some(&enum_metadata), None)
        .unwrap();
    let oxc = oxc_emit(&entry, source, &context, &plan, Some(&enum_metadata)).unwrap();
    assert_eq!(swc.shared_helpers.len(), 1);
    assert_eq!(oxc.shared_helpers.len(), 1);
    let swc_name = &swc.shared_helpers[0].canonical_name;
    let oxc_name = &oxc.shared_helpers[0].canonical_name;
    assert_eq!(
        normalize(&oxc.code.replace(oxc_name, "__HELPER")),
        normalize(&swc.code.replace(swc_name, "__HELPER")),
        "swc:\n{}\noxc:\n{}",
        swc.code,
        oxc.code
    );
    assert!(oxc.code.contains(oxc_name), "{}", oxc.code);
    assert!(
        oxc.shared_helpers[0].text.contains(oxc_name),
        "{:?}",
        oxc.shared_helpers
    );
    assert_eq!(oxc.type_metadata.counts, swc.type_metadata.counts);
    assert_eq!(oxc.type_metadata.counts.enumDeclarationCount, 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn commonjs_lazy_facade_matches_swc() {
    let root = root("commonjs");
    let entry = root.join("node_modules/demo/index.js");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "module.exports = function demo() { return 'ok'; };").unwrap();
    let cjs_export_name = concat!("__cjs", "Exports");
    let entry_id = to_goog_module_id(&entry, &root);
    let lazy_imports = vec![super::super::LazyImportInput {
        importerFilePath: entry.to_string_lossy().to_string(),
        moduleId: entry_id.clone(),
        specifier: "./node_modules/demo/index.js".to_string(),
        targetPath: entry.to_string_lossy().to_string(),
    }];
    let (context, plan) = context(
        &root,
        std::slice::from_ref(&entry),
        vec![super::super::TranspileChunkInput {
            dependencies: Vec::new(),
            files: vec!["node_modules/demo/index.js".to_string()],
            name: "main".to_string(),
        }],
        lazy_imports,
        HashMap::new(),
        HashMap::from([(entry_id, slots(&[cjs_export_name, "default"]))]),
        HashSet::new(),
    );
    let emitted_source = format!("const {cjs_export_name} = function demo() {{ return 'ok'; }};");
    let swc = emit_hoist_text_for_test(
        &entry,
        &emitted_source,
        &context,
        &plan,
        None,
        Some(cjs_export_name),
    )
    .unwrap();
    let allocator = Allocator::default();
    let (mut program, mut identity) = parse(&allocator, &emitted_source);
    let oxc = emit_hoisted_module_text(
        &allocator,
        &entry,
        &mut program,
        &mut identity,
        &context,
        &plan,
        None,
        Some(cjs_export_name),
    )
    .unwrap();
    assert_eq!(normalize(&oxc.code), normalize(&swc.code));
    assert!(oxc.code.contains("Object.defineProperties"), "{}", oxc.code);
    assert!(
        oxc.code.contains("__exports.__esModule = true"),
        "{}",
        oxc.code
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn computed_direct_namespace_error_matches_swc() {
    let root = root("namespace-error");
    let entry = root.join("entry.js");
    let origin = root.join("origin.js");
    std::fs::write(&origin, "export const value = 1;").unwrap();
    let source = "import * as ns from './origin.js'; export function read(key) { return ns[key]; }";
    std::fs::write(&entry, source).unwrap();
    let entry_id = to_goog_module_id(&entry, &root);
    let origin_id = to_goog_module_id(&origin, &root);
    let (context, plan) = context(
        &root,
        &[entry.clone(), origin.clone()],
        vec![super::super::TranspileChunkInput {
            dependencies: Vec::new(),
            files: vec!["entry.js".to_string(), "origin.js".to_string()],
            name: "main".to_string(),
        }],
        Vec::new(),
        HashMap::new(),
        HashMap::from([(entry_id, slots(&["read"])), (origin_id, slots(&["value"]))]),
        HashSet::new(),
    );
    let swc_error =
        emit_hoist_text_for_test(&entry, source, &context, &plan, None, None).unwrap_err();
    let oxc_error = oxc_emit(&entry, source, &context, &plan, None).unwrap_err();
    assert_eq!(oxc_error, swc_error);
    assert!(oxc_error.contains("computed namespace property access"));
    std::fs::remove_dir_all(root).unwrap();
}
