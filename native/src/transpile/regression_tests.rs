use super::*;
use crate::module_cache::parse_module;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use swc_core::common::{Globals, GLOBALS};

fn empty_context() -> TranspileContext {
    TranspileContext {
        bundler_module_slots: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: ChunkMode::Off,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        file_metadata: HashMap::new(),
        hoist_plan: None,
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        resolved_module_ids: HashMap::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: true,
        vendor_module_ids: HashSet::new(),
        workspace_dir: PathBuf::from("/tmp"),
    }
}

#[test]
fn commonjs_lowering_keeps_original_binding_ids_and_fresh_helpers() {
    use swc_core::ecma::visit::{Visit, VisitWith};

    let source = concat!(
        "const __cjs_import_0 = 7;\n",
        "import { answer as local } from 'demo-pkg';\n",
        "globalThis.result = local;\n",
    );
    let ids = GLOBALS.set(&Globals::new(), || {
        let mut program = Program::Module(parse_module(Path::new("fixture.js"), source).unwrap());
        apply_resolver_and_global_this_compat(&mut program, true).unwrap();
        let mut context = empty_context();
        context.commonjs_specifiers.insert("demo-pkg".to_string());
        apply_program_compat_transforms(&mut program, &context);

        struct LocalIds(BindingKeySet);
        impl Visit for LocalIds {
            fn visit_ident(&mut self, ident: &Ident) {
                if ident.sym == *"local" {
                    self.0.insert(BindingKey::of(&ident));
                }
            }
        }
        let mut collector = LocalIds(HashSet::new());
        program.visit_with(&mut collector);
        let output = print_program(&program).unwrap();
        assert!(output.contains("__cjs_import_0_1"), "{output}");
        collector.0
    });
    assert_eq!(ids.len(), 1, "{ids:?}");
}

#[test]
fn import_lowering_uses_authoritative_graph_module_ids() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-resolved-import-{unique}"));
    let package = root.join("node_modules/demo-pkg");
    fs::create_dir_all(&package).unwrap();
    let importer = package.join("index.js");
    let original = package.join("feature.js");
    let resolved = package.join("feature-browser.js");
    fs::write(
        &importer,
        "import { feature } from './feature.js'; globalThis.result = feature;\n",
    )
    .unwrap();
    fs::write(&original, "export const feature = 'node';\n").unwrap();
    fs::write(&resolved, "export const feature = 'browser';\n").unwrap();

    let mut context = empty_context();
    context.workspace_dir = root.clone();
    let resolved_module_id = to_goog_module_id(&resolved, &root);
    context.resolved_module_ids.insert(
        resolved_import_key(&importer, "./feature.js"),
        resolved_module_id.clone(),
    );
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&importer, &context)
        })
        .unwrap();
    assert!(
        output.contains(&format!("goog.require({resolved_module_id:?})")),
        "{output}"
    );
    let original_module_id = to_goog_module_id(&original, &root);
    assert!(
        !output.contains(&format!("goog.require({original_module_id:?})")),
        "{output}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn class_map_import_aliases_match_ids_not_shadowed_spellings() {
    let source = concat!(
        "import { jsx as _jsx } from 'demo-pkg';\n",
        "const host = _jsx('button', { onClick: handle });\n",
        "function render(_jsx) { return _jsx('button', { localOnly: handle }); }\n",
    );
    let mut context = empty_context();
    context.commonjs_specifiers.insert("demo-pkg".to_string());
    context.class_map_calls = vec![ClassMapCallInput {
        argIndex: 1,
        calleeModulePattern: None,
        keySource: None,
        callee: "jsx".to_string(),
        keyExcludePattern: None,
        keyPattern: None,
        stringLiteralArgIndex: Some(0),
    }];
    let output = transform_js_pass_through_module(
        parse_module(Path::new("fixture.js"), source).unwrap(),
        source.to_string(),
        Path::new("fixture.js"),
        &context,
    )
    .unwrap();
    assert!(output.contains("\"onClick\": handle"), "{output}");
    assert!(output.contains("localOnly: handle"), "{output}");
    assert!(!output.contains("\"localOnly\""), "{output}");
}

#[test]
fn generated_component_parameter_is_fresh_against_outer_bindings() {
    let source = concat!(
        "const __props = { sentinel: 42 };\n",
        "function Button({ value }) { return __props.sentinel; }\n",
        "globalThis.run = () => Button({ value: 1 });\n",
    );
    let transformed = transform_js_pass_through_module(
        parse_module(Path::new("fixture.js"), source).unwrap(),
        source.to_string(),
        Path::new("fixture.js"),
        &empty_context(),
    )
    .unwrap();
    assert!(transformed.contains("Button(__props_1)"), "{transformed}");
    assert!(
        transformed.contains("return __props.sentinel"),
        "{transformed}"
    );
}

#[test]
fn bundler_exports_rewrite_skips_literals_and_authored_shadows() {
    let source = concat!(
        "function run(exports) { exports.local = 1; }\n",
        "globalThis.label = 'exports.literal =';\n",
        "exports.generated = 2;\n",
    );
    let output = emit_runtime::rewrite_bundler_exports(source);
    assert!(output.contains("exports.local = 1"), "{output}");
    assert!(output.contains("'exports.literal ='"), "{output}");
    assert!(output.contains("__exports[\"generated\"] = 2"), "{output}");
}

#[test]
fn dynamic_import_carriers_kill_unknown_writes_and_ignore_arbitrary_calls() {
    let source = concat!(
        "const load = () => __dynamicImport('gcc.src.feature');\n",
        "const unrelated = Promise.resolve({ default: () => 'unrelated' });\n",
        "observe(unrelated, load());\n",
        "let stale = load();\n",
        "stale = Promise.resolve({ default: () => 'stale' });\n",
        "let destructured = load();\n",
        "[destructured] = [Promise.resolve({ default: () => 'destructured' })];\n",
    );
    let module = parse_module(Path::new("fixture.js"), source).unwrap();
    let wrappers = collect_dynamic_import_wrappers(&module);
    let objects = collect_dynamic_import_object_carriers(&module, &wrappers);
    let promises = collect_dynamic_import_promise_carriers(&module, &objects, &wrappers);
    assert!(!promises.keys().any(|id| id.symbol() == "unrelated"));
    assert!(!promises.keys().any(|id| id.symbol() == "stale"));
    assert!(!promises.keys().any(|id| id.symbol() == "destructured"));
}

#[test]
fn authored_dynamic_import_name_is_not_the_injected_loader_binding() {
    let source = concat!(
        "function __dynamicImport(value) {",
        "return Promise.resolve({ default: () => value });",
        "}\n",
        "const load = () => __dynamicImport('gcc.src.feature');\n",
    );
    let wrappers = GLOBALS.set(&Globals::new(), || {
        let mut program = Program::Module(parse_module(Path::new("fixture.js"), source).unwrap());
        apply_resolver_and_global_this_compat(&mut program, true).unwrap();
        let Program::Module(module) = program else {
            unreachable!()
        };
        collect_dynamic_import_wrappers(&module)
    });
    assert!(wrappers.function_wrappers.is_empty(), "{wrappers:?}");
}

#[test]
fn dynamic_import_templates_use_cooked_specifiers() {
    let file_path = PathBuf::from("/tmp/src/main.js");
    let source = r"globalThis.load = () => import(`./\u0066eature.js`);";
    let mut module = parse_module(&file_path, source).unwrap();
    module.visit_mut_with(&mut DynamicImportRewriteVisitor::new(
        &file_path,
        &[LazyImportInput {
            importerFilePath: file_path.to_string_lossy().to_string(),
            moduleId: "gcc.src.feature".to_string(),
            specifier: "./feature.js".to_string(),
            targetPath: "/tmp/src/feature.js".to_string(),
        }],
    ));
    let output = print_program(&Program::Module(module)).unwrap();
    assert!(output.contains("__dynamicImport"), "{output}");
    assert!(!output.contains("import("), "{output}");
}

#[test]
fn normalized_commonjs_preserves_shadowed_process_env() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-cjs-process-shadow-{unique}"));
    let package = root.join("node_modules/demo-pkg");
    fs::create_dir_all(&package).unwrap();
    let entry = package.join("index.js");
    fs::write(
        &entry,
        "module.exports = function read(process) { return process.env.NODE_ENV; };\n",
    )
    .unwrap();
    let mut context = empty_context();
    context.workspace_dir = root.clone();
    let output = GLOBALS
        .set(&Globals::new(), || transform_source_file(&entry, &context))
        .unwrap();
    assert!(output.contains("process.env.NODE_ENV"), "{output}");
    fs::remove_dir_all(root).unwrap();
}

fn assigner_names_of(source: &str, bindings: &[&str]) -> Vec<String> {
    let module = parse_module(Path::new("fixture.js"), source).unwrap();
    let bindings = bindings
        .iter()
        .map(|name| name.to_string())
        .collect::<HashSet<_>>();
    module
        .body
        .iter()
        .filter_map(|item| match item {
            ModuleItem::Stmt(statement) => assigners::assigner_function_name(statement, &bindings),
            _ => None,
        })
        .collect()
}

#[test]
fn detects_function_valued_and_pattern_assigners() {
    let source = concat!(
        "const update$$1 = () => ++state$$1;\n",
        "const destructure$$1 = function() { [state$$1] = [1]; };\n",
        "const loop$$1 = () => { for (state$$1 of [1]) {} };\n",
    );
    assert_eq!(
        assigner_names_of(source, &["state$$1"]),
        vec!["update$$1", "destructure$$1", "loop$$1"],
    );
}

#[test]
fn pin_extraction_understands_function_valued_declarations() {
    let chunk = concat!(
        "/** @noinline */\nconst update$$1=()=>++state$$1;\n",
        "/** @noinline */\nlet reset$$1=function(){state$$1=0};\n",
    );
    assert_eq!(
        assigners::collect_annotated_assigner_names(chunk),
        vec!["update$$1", "reset$$1"],
    );
}

#[test]
fn runtime_wrapper_and_import_temporaries_are_fresh() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-runtime-fresh-{unique}"));
    let src = root.join("src");
    fs::create_dir_all(&src).unwrap();
    let dependency = src.join("dependency.ts");
    let main = src.join("main.ts");
    fs::write(&dependency, "export const value = 1;\n").unwrap();
    fs::write(
        &main,
        concat!(
            "import { value } from './dependency';\n",
            "const __require = 42;\n",
            "const __gcc_import_0 = 7;\n",
            "globalThis.result = value + __require + __gcc_import_0;\n",
        ),
    )
    .unwrap();

    let dependency_id = to_goog_module_id(&dependency, &root);
    let main_id = to_goog_module_id(&main, &root);
    let mut context = empty_context();
    context.workspace_dir = root.clone();
    context.chunk_mode = ChunkMode::BundlerRuntime;
    context.bundler_module_slots = HashMap::from([
        (
            dependency_id,
            BundlerModuleSlots::from_export_names(&BTreeSet::from(["value".to_string()])),
        ),
        (
            main_id,
            BundlerModuleSlots::from_export_names(&BTreeSet::new()),
        ),
    ]);

    let output = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();
    assert!(output.contains("function(__require_1"), "{output}");
    assert!(
        output.contains("const __gcc_import_0_1 = __require_1("),
        "{output}"
    );
    assert!(output.contains("const __require = 42"), "{output}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn direct_hoist_binding_falls_back_when_a_nested_binding_would_capture_it() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-hoist-capture-{unique}"));
    let src = root.join("src");
    fs::create_dir_all(&src).unwrap();
    let main = src.join("main.ts");
    let dependency = src.join("dependency.ts");
    fs::write(&dependency, "export const value = 42;\n").unwrap();
    fs::write(&main, "import { value } from './dependency';\n").unwrap();
    let files = vec![
        main.to_string_lossy().to_string(),
        dependency.to_string_lossy().to_string(),
    ];
    let chunks = vec![TranspileChunkInput {
        dependencies: vec![],
        files: vec!["src/main.ts".to_string(), "src/dependency.ts".to_string()],
        name: "main".to_string(),
    }];
    let initial_plan = build_hoist_plan(
        &files,
        &root,
        &[],
        &HashMap::new(),
        &chunks,
        &[],
        &HashMap::new(),
    )
    .unwrap()
    .expect("plan");
    let dependency_id = to_goog_module_id(&dependency, &root);
    let dependency_ordinal = initial_plan.ordinal_of(&dependency_id).unwrap();
    fs::write(
        &main,
        format!(
            "import {{ value }} from './dependency';\nfunction run(value$${dependency_ordinal}) {{ return value; }}\nglobalThis.result = run(7);\n"
),
    )
    .unwrap();
    let plan = std::sync::Arc::new(
        build_hoist_plan(
            &files,
            &root,
            &[],
            &HashMap::new(),
            &chunks,
            &[],
            &HashMap::new(),
        )
        .unwrap()
        .expect("plan"),
    );
    let main_id = to_goog_module_id(&main, &root);
    let mut context = empty_context();
    context.workspace_dir = root.clone();
    context.chunk_mode = ChunkMode::BundlerRuntime;
    context.hoist_plan = Some(plan);
    context.bundler_module_slots = HashMap::from([
        (
            dependency_id,
            BundlerModuleSlots::from_export_names(&BTreeSet::from(["value".to_string()])),
        ),
        (
            main_id,
            BundlerModuleSlots::from_export_names(&BTreeSet::new()),
        ),
    ]);

    let output = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();
    assert!(output.contains("__require("), "{output}");
    assert!(
        !output.contains(&format!("return value$${dependency_ordinal};")),
        "{output}"
    );
    fs::remove_dir_all(root).unwrap();
}
