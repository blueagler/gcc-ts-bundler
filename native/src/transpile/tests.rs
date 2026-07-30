use super::{
    apply_js_compat_text_fixes, collect_commonjs_extern_names, collect_enum_extern_names,
    collect_extern_property_names, collect_extern_property_names_with_externs,
    collect_preserved_property_names, collect_protocol_extern_names,
    collect_static_property_names_from_text, print_program, render_externs,
    render_generated_externs, transform_js_pass_through_module, transform_program,
    transform_source_file,
};
use crate::module_cache::parse_module;
use crate::pathing::to_goog_module_id;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use swc_core::common::{Globals, GLOBALS};

fn empty_context() -> super::TranspileContext {
    super::TranspileContext {
        bundler_module_slots: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::Off,
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

struct JsPassThroughFixture {
    context: super::TranspileContext,
    file_path: PathBuf,
}

fn make_js_pass_through_fixture(label: &str, source_text: &str) -> JsPassThroughFixture {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace_dir = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let file_path = workspace_dir.join("node_modules/demo/index.js");
    fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    fs::write(&file_path, source_text).unwrap();

    JsPassThroughFixture {
        context: super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
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
            package_aliases: vec![super::PackageAliasInput {
                packageName: "react".to_string(),
                subpath: ".".to_string(),
                targetPath: workspace_dir
                    .join("node_modules/react/index.js")
                    .to_string_lossy()
                    .to_string(),
            }],
            static_property_names: HashSet::new(),
            type_metadata_enabled: true,
            vendor_module_ids: HashSet::new(),
            workspace_dir,
        },
        file_path,
    }
}

#[test]
fn rewrites_global_property_accesses_to_global_this() {
    let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
    let module = parse_module(
            &file_path,
            "const value = globalThis.sharedRegistry ?? new WeakMap(); const item = sharedRegistry.get(meta);",
        )
        .unwrap();

    let program = GLOBALS
        .set(&Globals::new(), || {
            transform_program(module, &file_path, &empty_context(), None)
        })
        .unwrap();
    let output = print_program(&program).unwrap();

    assert!(output.contains("globalThis.sharedRegistry.get(meta)"));
}

#[test]
fn leaves_unrelated_identifiers_alone() {
    let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
    let module = parse_module(&file_path, "const value = registry.get(meta);").unwrap();

    let program = GLOBALS
        .set(&Globals::new(), || {
            transform_program(module, &file_path, &empty_context(), None)
        })
        .unwrap();
    let output = print_program(&program).unwrap();

    assert!(output.contains("registry.get(meta)"));
    assert!(!output.contains("globalThis.registry.get(meta)"));
}

#[test]
fn preserves_js_source_verbatim() {
    let source_text = "/** @nocollapse */\nconst JSCompiler_renameProperty=(prop,_obj)=>prop;\n";
    let fixture = make_js_pass_through_fixture("js-compat", source_text);

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap();

    assert!(output.contains("goog.module("), "{output}");
    assert!(output.contains("JSCompiler_renameProperty"), "{output}");
}

#[test]
fn wraps_commonjs_body_to_preserve_top_level_this() {
    let fixture = make_js_pass_through_fixture(
        "commonjs-wrapper",
        "(function (global) { module.exports = global; })(this);\n",
    );

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap();

    assert!(output.contains(".call(module.exports)"), "{output}");
    assert!(output.contains("})(this)"), "{output}");
}

#[test]
fn leaves_non_platform_static_fallbacks_renamable() {
    let source_text = "class Demo {}\nDemo.enabledWarnings = [\"x\"];\nfunction run(){ return this.constructor.enabledWarnings.includes(\"x\"); }\n";
    let fixture = make_js_pass_through_fixture("js-static", source_text);

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap();

    assert!(
        output.contains("this.constructor.enabledWarnings.includes(\"x\")"),
        "{output}"
    );
    assert!(
        !output.contains("this.constructor[\"enabledWarnings\"]"),
        "{output}"
    );
}

#[test]
fn rewrites_global_alias_property_accesses_in_js_pass_through() {
    let source_text = "const global = globalThis;\nglobal.sharedRegistry ??= new WeakMap();\nconst item = sharedRegistry.get(meta);\n";
    let fixture = make_js_pass_through_fixture("js-alias", source_text);

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap();

    assert!(
        output.contains("globalThis.sharedRegistry.get(meta)"),
        "{output}"
    );
}

#[test]
fn leaves_non_platform_static_property_names_renamable() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path =
        std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-quote-{unique}.js"));
    let source_text = "let Demo = class Demo {};\nDemo.styles = theme;\n";
    fs::write(&file_path, source_text).unwrap();

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&file_path, &empty_context())
        })
        .unwrap();

    assert!(output.contains("Demo.styles = theme;"), "{output}");
    assert!(!output.contains("Demo[\"styles\"] = theme;"), "{output}");
}

#[test]
fn annotates_static_class_members_with_nocollapse() {
    let transformed = apply_js_compat_text_fixes(
        "class Demo {\n  static styles = theme;\n}\nDemo.styles = theme;\n".to_string(),
    );

    assert!(
        transformed.contains("/** @nocollapse */\n  static styles = theme;"),
        "{transformed}"
    );
    assert!(
        transformed.contains("/** @nocollapse */\nDemo.styles = theme;"),
        "{transformed}"
    );
}

#[test]
fn generated_externs_include_preserved_instance_and_hard_static_protocols() {
    let externs = render_generated_externs(
        &HashSet::from(["letters".to_string()]),
        &HashSet::from([
            "formAssociated".to_string(),
            "observedAttributes".to_string(),
        ]),
        &HashSet::from(["ambientGlobal".to_string()]),
    );

    // Ambient declarations are environment, not program code: they belong in
    // the externs channel, typed `?` because the author's claim about a global
    // we do not control is not something to assert to Closure.
    assert!(externs.contains("var ambientGlobal;"), "{externs}");
    assert!(externs.contains("Object.prototype.letters;"), "{externs}");
    assert!(
        externs.contains("Function.prototype.formAssociated;"),
        "{externs}"
    );
    assert!(
        externs.contains("Function.prototype.observedAttributes;"),
        "{externs}"
    );
    assert!(!externs.contains("Window.prototype"), "{externs}");
}

#[test]
fn rewrites_jscompiler_rename_property_protocol_accesses() {
    let transformed = apply_js_compat_text_fixes(
            "const JSCompiler_renameProperty=(prop,_obj)=>prop;\nclass Demo {\n  static check(ctor) { return ctor.elementProperties.size + this.finalized; }\n}\nconst superCtor = Demo;\nDemo[JSCompiler_renameProperty('elementProperties', Demo)] = new Map();\nDemo[JSCompiler_renameProperty('finalized', Demo)] = true;\nsuperCtor.elementProperties;\n".to_string(),
        );

    assert!(
        transformed.contains("ctor[\"elementProperties\"].size"),
        "{transformed}"
    );
    assert!(transformed.contains("this[\"finalized\"]"), "{transformed}");
    assert!(
        transformed.contains("superCtor[\"elementProperties\"]"),
        "{transformed}"
    );
}

#[test]
fn rewrites_directory_import_specifiers_to_explicit_index_files() {
    let source = "import item from '.';\nexport { other } from '..';\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(transformed.contains("./index.js"), "{transformed}");
    assert!(transformed.contains("../index.js"), "{transformed}");
}

#[test]
fn moves_jsdoc_ahead_of_async_function_keyword() {
    let transformed = apply_js_compat_text_fixes(
        "async /** @param {?} arg */ function load(arg) { await arg; }\n".to_string(),
    );

    assert!(
        transformed.contains("/** @param {?} arg */\nasync function load(arg)"),
        "{transformed}"
    );
}

#[test]
fn rewrites_throw_statements_for_goog_module_output() {
    let source = "if (typeof globalThis.document === 'undefined') throw new Error('missing');\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(transformed.contains("(()=>{"), "{transformed}");
    assert!(
        transformed.contains("throw new Error('missing')"),
        "{transformed}"
    );
}

#[test]
fn simplifies_literal_conditional_expressions_in_js_pass_through() {
    let source =
        "const value = false ? missing() : fallback();\nconst other = true ? keep() : drop();\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(
        transformed.contains("const value = fallback();"),
        "{transformed}"
    );
    assert!(
        transformed.contains("const other = keep();"),
        "{transformed}"
    );
}

#[test]
fn rewrites_undeclared_placeholder_returns_to_void_zero() {
    let source = "var RETURN = () => T;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(
        transformed.contains("var RETURN = ()=>void 0;"),
        "{transformed}"
    );
}

#[test]
fn folds_process_env_node_env_for_browser_packages() {
    let source = concat!(
        "if (process.env.NODE_ENV !== 'production') console.warn('dev');\n",
        "globalThis.literal = 'process.env.NODE_ENV';\n",
    );
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(!transformed.contains("console.warn"), "{transformed}");
    assert!(
        transformed.contains("literal = 'process.env.NODE_ENV'"),
        "{transformed}"
    );

    let local_source =
        "function read(process) { return process.env.NODE_ENV; }\nglobalThis.read = read;\n";
    let local = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), local_source).expect("module"),
        local_source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");
    assert!(local.contains("process.env.NODE_ENV"), "{local}");
}

#[test]
fn rewrites_commonjs_namespace_imports_in_native_stage() {
    let file_path = PathBuf::from("/tmp/src/index.js");
    let source = "import * as demo from \"demo-pkg\";\nexport default demo.answer;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(&file_path, source).expect("module"),
        source.to_string(),
        &file_path,
        &super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::from(["demo-pkg".to_string()]),
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
        },
    )
    .expect("transform");

    assert!(
        transformed.contains("import __cjs_import_0 from \"demo-pkg\";"),
        "{transformed}"
    );
    assert!(
        transformed.contains("const demo = __cjs_import_0;"),
        "{transformed}"
    );
    // Transparent package: the read is an ordinary property access, so Closure
    // renames it with the producer's write.
    assert!(transformed.contains("demo.answer"), "{transformed}");
    assert!(!transformed.contains("demo[\"answer\"]"), "{transformed}");
}

#[test]
fn preserves_module_exports_member_names_in_commonjs_normalization() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir()
        .join(format!("gcc-ts-bundler-cjs-export-{unique}"))
        .join("node_modules/demo/index.js");
    let source_text =
        "module.exports.Component = Component;\nmodule.exports.createContext = createContext;\n";
    fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    fs::write(&file_path, source_text).unwrap();

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&file_path, &empty_context())
        })
        .unwrap();

    // Transparent module: export names are ordinary properties.
    assert!(
        output.contains("module[\"exports\"].Component = Component;"),
        "{output}"
    );
    assert!(
        output.contains("module[\"exports\"].createContext = createContext;"),
        "{output}"
    );
    // The scratch `module` slot itself stays quoted; dotting it makes Closure's
    // checkTypes reject the assignment (JSC_TYPE_MISMATCH).
    assert!(output.contains("module[\"exports\"] = {}"), "{output}");
}

#[test]
fn preserves_commonjs_alias_member_reads() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir()
        .join(format!("gcc-ts-bundler-cjs-alias-{unique}"))
        .join("node_modules/demo/index.js");
    let source_text = "const React = require(\"react\");\nmodule.exports = React.Component;\n";
    fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    fs::write(&file_path, source_text).unwrap();

    let context = super::TranspileContext {
        bundler_module_slots: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::Off,
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
        package_aliases: vec![super::PackageAliasInput {
            packageName: "react".to_string(),
            subpath: ".".to_string(),
            targetPath: file_path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("react/index.js")
                .to_string_lossy()
                .to_string(),
        }],
        workspace_dir: file_path
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: true,
        vendor_module_ids: HashSet::new(),
    };
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&file_path, &context)
        })
        .unwrap();

    assert!(
        output.contains("const React = __cjs_require_0;"),
        "{output}"
    );
    assert!(
        output.contains("module[\"exports\"] = React.Component;"),
        "{output}"
    );
}

#[test]
fn rewrites_component_props_to_runtime_object_reads() {
    let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
    let source = "export function RouterProvider({ router, children, ...rest }) { return render(router, children, rest); }\n";
    let transformed = transform_js_pass_through_module(
        parse_module(&file_path, source).expect("module"),
        source.to_string(),
        &file_path,
        &empty_context(),
    )
    .expect("transform");

    assert!(
        transformed.contains("function RouterProvider(__props)"),
        "{transformed}"
    );
    assert!(
        transformed
            .contains("const router = __props[goog.reflect.objectProperty(\"router\", __props)];"),
        "{transformed}"
    );
    assert!(
        transformed.contains(
            "const children = __props[goog.reflect.objectProperty(\"children\", __props)];"
        ),
        "{transformed}"
    );
    assert!(
            transformed.contains(
                "key !== goog.reflect.objectProperty(\"router\", __props) && key !== goog.reflect.objectProperty(\"children\", __props)"
            ),
            "{transformed}"
        );
}

#[test]
fn preserves_uppercase_static_member_names_with_bracket_access() {
    let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.ts");
    let source = "export const enum Flags { None = 0, Dirty = 1 }\nexport const value = Flags.None | Flags.Dirty;\n";
    let transformed = GLOBALS.set(&Globals::new(), || {
        let program = transform_program(
            parse_module(&file_path, source).expect("module"),
            &file_path,
            &empty_context(),
            None,
        )
        .expect("transform");
        print_program(&program).expect("print")
    });

    assert!(
        transformed.contains("const value = 0 | 1;"),
        "{transformed}"
    );
}

#[test]
fn collects_only_hard_static_interop_names() {
    let names = collect_static_property_names_from_text(
            "class Demo { static styles = theme; static get observedAttributes() { return []; } static formAssociated = true; }\nlet Other = class Other {};\nOther.shadowRootOptions = {};\n",
        );

    assert!(names.contains("observedAttributes"));
    assert!(names.contains("formAssociated"));
    assert!(!names.contains("styles"));
    assert!(!names.contains("shadowRootOptions"));
}

#[test]
fn collects_hard_static_interop_names_from_static_method_accesses() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir().join(format!("gcc-ts-static-interop-{unique}.js"));
    fs::write(
        &file_path,
        "class Demo { static finalize() { return this.observedAttributes && this.formAssociated; } }",
    )
    .unwrap();

    let analysis = collect_extern_property_names(&[file_path.to_string_lossy().to_string()])
        .expect("analysis");

    assert!(analysis
        .static_property_names
        .contains("observedAttributes"));
    assert!(analysis.static_property_names.contains("formAssociated"));
}

#[test]
fn leaves_constant_like_object_keys_and_member_reads_renamable() {
    let source = "const PartType = { ATTRIBUTE: 1, CHILD: 2, ELEMENT: 6 };\nconst alias = PartType;\nexport const value = alias.CHILD + PartType.ELEMENT;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(!transformed.contains("\"ATTRIBUTE\": 1"), "{transformed}");
    assert!(!transformed.contains("\"ATTRIBUTE\":1"), "{transformed}");
    assert!(transformed.contains("alias.CHILD"), "{transformed}");
    assert!(transformed.contains("PartType.ELEMENT"), "{transformed}");
}

#[test]
fn leaves_non_reflective_lit_style_members_renamable() {
    let source =
            "class Demo { constructor(){ this.hostUpdated(); this.createFinished(); this.calculateKeyframes(); this.createRenderRoot(); this._$AU = 1; this._$AM = 2; void this._$AU + this._$AM; } hostUpdated(){} createFinished(){} calculateKeyframes(){} createRenderRoot(){} }\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(transformed.contains("this.hostUpdated()"), "{transformed}");
    assert!(transformed.contains("hostUpdated()"), "{transformed}");
    assert!(
        transformed.contains("this.createFinished()"),
        "{transformed}"
    );
    assert!(transformed.contains("createFinished()"), "{transformed}");
    assert!(
        transformed.contains("this.calculateKeyframes()"),
        "{transformed}"
    );
    assert!(
        transformed.contains("calculateKeyframes()"),
        "{transformed}"
    );
    assert!(
        transformed.contains("this.createRenderRoot()"),
        "{transformed}"
    );
    assert!(transformed.contains("createRenderRoot()"), "{transformed}");
    assert!(transformed.contains("this._$AU = 1"), "{transformed}");
    assert!(transformed.contains("this._$AM = 2"), "{transformed}");
    assert!(
        transformed.contains("this._$AU + this._$AM"),
        "{transformed}"
    );
    assert!(!transformed.contains("[\"hostUpdated\"]"), "{transformed}");
    assert!(
        !transformed.contains("[\"createFinished\"]"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("[\"calculateKeyframes\"]"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("[\"createRenderRoot\"]"),
        "{transformed}"
    );
    assert!(!transformed.contains("[\"_$AU\"]"), "{transformed}");
    assert!(!transformed.contains("[\"_$AM\"]"), "{transformed}");
}

#[test]
fn rewrites_hard_static_interop_property_reads_to_bracket_access() {
    let source = "class Base { static finalize(ctor) { return ctor.observedAttributes && this.formAssociated; } }\nclass Demo extends Base {}\nDemo.observedAttributes = [];\nDemo.formAssociated = true;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: HashMap::new(),
            hoist_plan: None,
            preserved_property_names: HashSet::from([
                "formAssociated".to_string(),
                "observedAttributes".to_string(),
            ]),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            resolved_module_ids: HashMap::new(),
            package_aliases: vec![],
            static_property_names: HashSet::from([
                "formAssociated".to_string(),
                "observedAttributes".to_string(),
            ]),
            type_metadata_enabled: true,
            vendor_module_ids: HashSet::new(),
            workspace_dir: PathBuf::from("/tmp"),
        },
    )
    .expect("transform");

    assert!(
        transformed.contains("ctor[\"observedAttributes\"]"),
        "{transformed}"
    );
    assert!(
        transformed.contains("this[\"formAssociated\"]"),
        "{transformed}"
    );
    assert!(
        transformed.contains("Demo[\"observedAttributes\"] = []"),
        "{transformed}"
    );
    assert!(
        transformed.contains("Demo[\"formAssociated\"] = true"),
        "{transformed}"
    );
}

/// A preserved name must be quoted on **both** sides — the object-literal key
/// that defines it and every member access that reads it. One-sided quoting
/// pins one spelling while the other renames, which is the exact shape that
/// killed `$.Deferred`/`$.when` in the jQuery ablation: the app side was quoted
/// to the literal `"Deferred"` while the library's own definition renamed.
#[test]
fn quotes_preserved_object_literal_keys_and_their_reads_together() {
    let source = concat!(
        "const settings = { retries: 3, other: 1 };\n",
        "export function read(bag) { return bag.retries + settings.retries + settings.other; }\n",
    );
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: HashMap::new(),
            hoist_plan: None,
            preserved_property_names: HashSet::from(["retries".to_string()]),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            resolved_module_ids: HashMap::new(),
            package_aliases: vec![],
            static_property_names: HashSet::new(),
            type_metadata_enabled: true,
            vendor_module_ids: HashSet::new(),
            workspace_dir: PathBuf::from("/tmp"),
        },
    )
    .expect("transform");

    // Definition side.
    assert!(transformed.contains("\"retries\": 3"), "{transformed}");
    // Both read sides.
    assert!(transformed.contains("bag[\"retries\"]"), "{transformed}");
    assert!(
        transformed.contains("settings[\"retries\"]"),
        "{transformed}"
    );
    // A name that is not preserved keeps renaming on both sides.
    assert!(!transformed.contains("\"other\""), "{transformed}");
    assert!(transformed.contains("settings.other"), "{transformed}");
}

#[test]
fn collects_preserved_property_names_from_explicit_extern_files() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-explicit-externs-{unique}"));
    let source_file = root.join("view.js");
    let extern_file = root.join("generated.externs.js");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &source_file,
        "function view(props){return prop(props,\"variant\",3)+rest_props(props,[\"ignored\"]);}\n",
    )
    .unwrap();
    fs::write(
        &extern_file,
        [
            "/** @externs */",
            "Object.prototype.$$slots;",
            "Object.prototype.$$events;",
            "Object.prototype.$$legacy;",
            "Object.prototype.variant;",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let analysis = collect_extern_property_names_with_externs(
        &[source_file.to_string_lossy().to_string()],
        &[extern_file.to_string_lossy().to_string()],
    )
    .expect("collect extern property names");

    assert!(analysis.preserved_property_names.contains("$$slots"));
    assert!(analysis.preserved_property_names.contains("$$events"));
    assert!(analysis.preserved_property_names.contains("$$legacy"));
    assert!(analysis.preserved_property_names.contains("variant"));
    assert!(analysis.explicit_extern_property_names.contains("$$slots"));
    assert!(analysis.explicit_extern_property_names.contains("variant"));
}

#[test]
fn preserves_property_names_from_explicit_extern_files_in_precompiled_js_output() {
    let source = [
        "const attrs = { $$slots: { default: true }, $$events: null, $$legacy: true, variant: 'filled' };",
        "function read(){ return attrs.$$slots, attrs.$$events, attrs.$$legacy, attrs.variant; }",
        "",
    ]
    .join("\n");
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            preserved_property_names: HashSet::from([
                "$$slots".to_string(),
                "$$events".to_string(),
                "$$legacy".to_string(),
                "variant".to_string(),
            ]),
            ..empty_context()
        },
    )
    .expect("transform");

    assert!(transformed.contains("\"$$slots\""), "{transformed}");
    assert!(transformed.contains("\"$$events\""), "{transformed}");
    assert!(transformed.contains("\"$$legacy\""), "{transformed}");
    assert!(transformed.contains("\"variant\""), "{transformed}");
    assert!(transformed.contains("attrs[\"$$slots\"]"), "{transformed}");
    assert!(transformed.contains("attrs[\"$$events\"]"), "{transformed}");
    assert!(transformed.contains("attrs[\"$$legacy\"]"), "{transformed}");
    assert!(transformed.contains("attrs[\"variant\"]"), "{transformed}");
    assert!(!transformed.contains("attrs.$$slots"), "{transformed}");
    assert!(!transformed.contains("attrs.variant"), "{transformed}");
}

#[test]
fn class_map_calls_gate_on_string_literal_args_and_member_callees() {
    // React's shape: host elements take a string-literal type and dispatch
    // on literal prop keys; component elements rename consistently. The
    // classic JSX transform emits a member callee, and CommonJS namespace
    // quoting turns it into `React["createElement"]` before this pass.
    let source = [
        "const host = React[\"createElement\"](\"button\", { onClick: handle, children: kids });",
        "const component = React[\"createElement\"](Panel, { onClick: handle });",
        "const dotted = React.createElement((\"div\"), { className: name });",
        "",
    ]
    .join("\n");
    let context = super::TranspileContext {
        class_map_calls: vec![super::ClassMapCallInput {
            argIndex: 1,
            calleeModulePattern: None,
            keySource: None,
            callee: "createElement".to_string(),
            keyExcludePattern: Some("^(?:children|key|ref)$".to_string()),
            keyPattern: None,
            stringLiteralArgIndex: Some(0),
        }],
        ..empty_context()
    };
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &context,
    )
    .expect("transform");

    // Host element: quoted through both callee spellings.
    assert!(transformed.contains("\"onClick\": handle"), "{transformed}");
    assert!(transformed.contains("\"className\": name"), "{transformed}");
    // Excluded key stays renamable (React reads `props.children` with a dot).
    assert!(transformed.contains("children: kids"), "{transformed}");
    // Component element (identifier type) is not gated in, so it renames.
    assert!(
        transformed.contains("(Panel, {\n    onClick: handle\n})")
            || transformed.contains("(Panel, { onClick: handle })"),
        "{transformed}"
    );
}

#[test]
fn class_map_call_rules_with_unparsable_patterns_return_an_error() {
    let calls = vec![super::ClassMapCallInput {
        argIndex: 1,
        calleeModulePattern: None,
        keySource: None,
        callee: "jsx".to_string(),
        keyExcludePattern: Some("^(?!children$).+$".to_string()),
        keyPattern: None,
        stringLiteralArgIndex: Some(0),
    }];
    let error = super::validate_class_map_calls(&calls).expect_err("invalid regex");
    assert!(error.contains("compat.classMapCalls"), "{error}");
    assert!(error.contains("jsx"), "{error}");
    assert!(error.contains("keyExcludePattern"), "{error}");
    assert!(error.contains("unsupported regex syntax"), "{error}");
}

#[test]
fn class_map_calls_follow_host_value_and_static_object_provenance() {
    let source = [
        "const base = createElement((\"button\"), null);",
        "const cloned = cloneElement(base, { onClick: handle, children: kids });",
        "const component = createElement(Panel, { componentOnlyLongName: value });",
        "const hoisted = { class: 'card' };",
        "const vnode = createElementVNode('div', hoisted);",
        "",
    ]
    .join("\n");
    let host_rule = |callee: &str| super::ClassMapCallInput {
        argIndex: 1,
        calleeModulePattern: None,
        keySource: None,
        callee: callee.to_string(),
        keyExcludePattern: Some("^(?:children|key|ref)$".to_string()),
        keyPattern: None,
        stringLiteralArgIndex: Some(0),
    };
    let context = super::TranspileContext {
        class_map_calls: vec![
            host_rule("createElement"),
            host_rule("cloneElement"),
            super::ClassMapCallInput {
                argIndex: 1,
                calleeModulePattern: None,
                keySource: None,
                callee: "createElementVNode".to_string(),
                keyExcludePattern: None,
                keyPattern: None,
                stringLiteralArgIndex: None,
            },
        ],
        ..empty_context()
    };
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &context,
    )
    .expect("transform");

    assert!(transformed.contains("\"onClick\": handle"), "{transformed}");
    assert!(transformed.contains("children: kids"), "{transformed}");
    assert!(
        transformed.contains("componentOnlyLongName: value"),
        "{transformed}"
    );
    assert!(
        transformed.contains("\"class\": 'card'") || transformed.contains("\"class\": \"card\""),
        "{transformed}"
    );
}

#[test]
fn preserves_configured_class_map_call_keys() {
    let source = [
        "let classes;",
        "classes = set_class(node, 1, 'svelte-hash', null, classes, { rail: true, open: isOpen(), centered });",
        "",
    ]
    .join("\n");
    let context = super::TranspileContext {
        class_map_calls: vec![super::ClassMapCallInput {
            argIndex: 5,
            calleeModulePattern: None,
            keySource: None,
            callee: "set_class".to_string(),
            keyExcludePattern: None,
            keyPattern: None,
            stringLiteralArgIndex: None,
        }],
        ..empty_context()
    };
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source.clone(),
        std::path::Path::new("fixture.js"),
        &context,
    )
    .expect("transform");

    assert!(transformed.contains("\"rail\": true"), "{transformed}");
    assert!(transformed.contains("\"open\": isOpen()"), "{transformed}");
    assert!(
        transformed.contains("\"centered\": centered"),
        "{transformed}"
    );

    let untouched = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");
    assert!(untouched.contains("rail: true"), "{untouched}");
}

#[test]
fn quotes_member_access_on_default_only_commonjs_imports() {
    let source = [
        "import React from \"react\";",
        "export const Link = React.forwardRef(() => null);",
        "",
    ]
    .join("\n");
    let mut context = empty_context();
    context.commonjs_specifiers.insert("react".to_string());
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &context,
    )
    .expect("transform");

    // Transparent package: the namespace read renames with the producer's
    // write instead of being pinned as a literal key.
    assert!(transformed.contains("React.forwardRef"), "{transformed}");
    assert!(
        !transformed.contains("React[\"forwardRef\"]"),
        "{transformed}"
    );
}

#[test]
fn quoted_valueless_class_fields_gain_explicit_undefined() {
    // `["id"];` (computed valueless class field) is an internal compiler
    // error in Closure's ConvertToDottedProperties; preserved-property
    // quoting must not create that shape.
    let source = [
        "class Account {",
        "  variant;",
        "  other;",
        "  constructor(v) { this.variant = v; }",
        "}",
        "export const make = (v) => new Account(v);",
        "",
    ]
    .join("\n");
    let mut program = swc_core::ecma::ast::Program::Module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
    );
    use swc_core::ecma::visit::VisitMutWith;
    program.visit_mut_with(
        &mut crate::transpile::compat::PreservedPropertyCompatVisitor::new(
            ["variant".to_string()].into_iter().collect(),
        ),
    );
    let output = print_program(&program).expect("print");
    assert!(output.contains("\"variant\" = void 0"), "{output}");
    // Unquoted fields keep their valueless form.
    assert!(output.contains("other;"), "{output}");
}

#[test]
fn rewrites_quoted_exports_assignments_in_registry_modules() {
    let rewritten = crate::transpile::emit_runtime::rewrite_bundler_exports(
        "exports.plain = 1;\nexports[\"quoted\"] = 2;\nexports['single'] = 3;\nvalue[\"quoted\"] = 4;\n",
    );
    assert!(rewritten.contains("__exports[\"plain\"] ="), "{rewritten}");
    assert!(rewritten.contains("__exports[\"quoted\"] ="), "{rewritten}");
    assert!(rewritten.contains("__exports[\"single\"] ="), "{rewritten}");
    // Non-exports receivers stay untouched.
    assert!(rewritten.contains("value[\"quoted\"] = 4"), "{rewritten}");
}

#[test]
fn collects_pure_annotated_binding_names_from_source() {
    let names = crate::transpile::pure_calls::collect_pure_annotated_binding_names(
        &[
            "var template = /* @__PURE__ */ from_html(`<p></p>`);",
            "const styled = /*#__PURE__*/ makeStyles({});",
            "let plain = from_html(`<b></b>`);",
            "var assigned;",
            "assigned = /*#__PURE__*/ notADeclaration();",
            "// prose /* mentions __PURE__ */",
            "",
        ]
        .join("\n"),
    );

    assert!(names.contains("template"), "{names:?}");
    assert!(names.contains("styled"), "{names:?}");
    assert!(!names.contains("plain"), "{names:?}");
    // Only declarations carry the annotation forward; bare assignments and
    // prose mentions must not.
    assert!(!names.contains("assigned"), "{names:?}");
    assert_eq!(names.len(), 2, "{names:?}");
}

#[test]
fn preserves_statics_read_through_this_constructor() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gcc-ts-bundler-ctor-statics-{unique}"));
    std::fs::create_dir_all(&dir).expect("create dir");
    let file_path = dir.join("element.js");
    std::fs::write(
        &file_path,
        [
            "class Base {",
            "  createRenderRoot() {",
            "    return this.attachShadow(this.constructor.shadowRootOptions);",
            "  }",
            "}",
            "Base.shadowRootOptions = { mode: 'open' };",
            "Base.unrelatedStatic = 1;",
            "export { Base };",
            "",
        ]
        .join("\n"),
    )
    .expect("write");

    let analysis = collect_extern_property_names(&[file_path.to_string_lossy().to_string()])
        .expect("analysis");
    assert!(
        analysis
            .preserved_property_names
            .contains("shadowRootOptions"),
        "{:?}",
        analysis.preserved_property_names
    );
    // Statics never read dynamically stay renamable/collapsible.
    assert!(!analysis
        .preserved_property_names
        .contains("unrelatedStatic"));
}

#[test]
fn folds_dead_literal_branches_in_js_pass_through() {
    let source = [
        "export function handle(fn) {",
        "  if (typeof fn === 'function') {",
        "    return fn();",
        "  } else if (false) {",
        "    missingDevHelper('nope');",
        "  }",
        "  return (\"production\" !== \"production\") && otherMissingHelper();",
        "}",
        "if (false) { var hoisted = 1; }",
        "export const keep = typeof hoisted;",
        "",
    ]
    .join("\n");
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(!transformed.contains("missingDevHelper"), "{transformed}");
    assert!(!transformed.contains("otherMissingHelper"), "{transformed}");
    // Hoisted declarations keep their branch.
    assert!(transformed.contains("var hoisted"), "{transformed}");
}

#[test]
fn preserves_shorthand_object_property_names_from_explicit_extern_files() {
    let source = [
        "function makeEffect(fn) {",
        "  return { fn, parent: null };",
        "}",
        "function run(effect) {",
        "  return effect.fn();",
        "}",
        "",
    ]
    .join("\n");
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), &source).expect("module"),
        source,
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            preserved_property_names: HashSet::from(["fn".to_string()]),
            ..empty_context()
        },
    )
    .expect("transform");

    assert!(transformed.contains("\"fn\": fn"), "{transformed}");
    assert!(transformed.contains("effect[\"fn\"]()"), "{transformed}");
    assert!(!transformed.contains("{fn,"), "{transformed}");
    assert!(!transformed.contains("effect.fn()"), "{transformed}");
}

#[test]
fn collects_string_defined_property_hazards_without_hard_coded_framework_names() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-string-hazard-{unique}"));
    let define_file = root.join("define.js");
    let read_file = root.join("read.js");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &define_file,
        "export const tpl = { [\"_$litType$\"]: 1, values: [] };\n",
    )
    .unwrap();
    fs::write(
        &read_file,
        "export function isTemplate(value) { return value._$litType$ !== undefined; }\n",
    )
    .unwrap();

    let names = collect_preserved_property_names(
        &[
            define_file.to_string_lossy().to_string(),
            read_file.to_string_lossy().to_string(),
        ],
        &HashSet::new(),
    )
    .expect("collect preserved properties");

    assert!(names.contains("_$litType$"), "{names:?}");
    assert!(!names.contains("values"), "{names:?}");
}

#[test]
fn collects_computed_super_and_cooked_template_property_reads() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path =
        std::env::temp_dir().join(format!("gcc-ts-bundler-computed-properties-{unique}.js"));
    fs::write(
        &file_path,
        [
            "class Base { inherited() { return 41; } }",
            "class Sub extends Base { call() { return super[`inherited`](); } }",
            "class Value { constructor() { this.templated = 42; } }",
            "export const read = value => value[`templ\\u0061ted`];",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let names = collect_preserved_property_names(
        &[file_path.to_string_lossy().to_string()],
        &HashSet::new(),
    )
    .expect("collect preserved properties");
    assert!(names.contains("inherited"), "{names:?}");
    assert!(names.contains("templated"), "{names:?}");
}

#[test]
fn infers_runtime_record_contracts_from_declarations_and_callback_reads() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path =
        std::env::temp_dir().join(format!("gcc-ts-bundler-record-contract-{unique}.js"));
    fs::write(
        &file_path,
        [
            "const Child = defineComponent({",
            "  props: { msg: {} },",
            "  setup(componentProps) { return componentProps.msg; }",
            "});",
            "createVNode(Child, { msg: 'hello', componentOnlyLongName: 1 });",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let names = collect_preserved_property_names(
        &[file_path.to_string_lossy().to_string()],
        &HashSet::new(),
    )
    .expect("collect preserved properties");
    assert!(names.contains("msg"), "{names:?}");
    assert!(!names.contains("componentOnlyLongName"), "{names:?}");
}

#[test]
fn preserves_registered_custom_element_surface_and_decorated_properties() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-custom-element-{unique}.ts"));
    fs::write(
        &file_path,
        [
            "function registered(_name: string) { return (value: unknown) => value; }",
            "function reactive() { return () => {}; }",
            "class ReactiveBase {",
            "  renderRoot = {};",
            "  hasUpdated = false;",
            "  requestUpdate() {}",
            "  get updateComplete() { return Promise.resolve(this.hasUpdated); }",
            "}",
            "@registered('x-motion')",
            "export class Motion extends ReactiveBase {",
            "  @reactive() accessor letters = ['L'];",
            "  private veryLongInternalDetail = 1;",
            "  read() { return this.veryLongInternalDetail; }",
            "}",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let names = collect_preserved_property_names(
        &[file_path.to_string_lossy().to_string()],
        &HashSet::new(),
    )
    .expect("collect preserved properties");
    for name in [
        "renderRoot",
        "hasUpdated",
        "requestUpdate",
        "updateComplete",
        "letters",
    ] {
        assert!(names.contains(name), "missing {name}: {names:?}");
    }
    assert!(!names.contains("veryLongInternalDetail"), "{names:?}");
}

#[test]
fn renders_commonjs_export_externs() {
    let externs = render_externs(
        &BTreeSet::from([
            "forwardRef".to_string(),
            "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE".to_string(),
        ]),
        &BTreeMap::new(),
    );

    assert!(
        externs.contains("Object.prototype.forwardRef;"),
        "{externs}"
    );
    assert!(
        externs.contains(
            "Object.prototype.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;"
        ),
        "{externs}"
    );
}

#[test]
fn collects_object_literal_protocol_names_from_exported_bindings() {
    let file_path = PathBuf::from("/tmp/node_modules/demo/index.js");
    let source = "var Shared = { H: null, T: null, S: null };\nmodule.exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = Shared;\n";
    let module = parse_module(&file_path, source).expect("module");
    let analysis = crate::commonjs::analyze_commonjs_module(&module);
    let externs = collect_commonjs_extern_names(&module, &analysis);

    assert!(externs
        .iter()
        .any(|name| name == "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"));
    assert!(externs.iter().any(|name| name == "H"));
    assert!(externs.iter().any(|name| name == "T"));
    assert!(externs.iter().any(|name| name == "S"));
}

#[test]
fn collects_protocol_names_from_config_destructuring() {
    let file_path = PathBuf::from("/tmp/node_modules/demo/index.js");
    let source = "function build(config) { const { createMutableStore, createReadonlyStore, batch, init } = config; return { createMutableStore, createReadonlyStore, batch, init }; }\n";
    let module = parse_module(&file_path, source).expect("module");
    let externs = collect_protocol_extern_names(&module);

    assert!(externs.iter().any(|name| name == "createMutableStore"));
    assert!(externs.iter().any(|name| name == "createReadonlyStore"));
    assert!(externs.iter().any(|name| name == "batch"));
    assert!(externs.iter().any(|name| name == "init"));
}

#[test]
fn collects_enum_member_names_for_externs() {
    let file_path = PathBuf::from("/tmp/node_modules/demo/index.ts");
    let source =
        "export const enum ReactiveFlags { None = 0, Mutable = 1, Watching = 2, Dirty = 16 }\n";
    let module = parse_module(&file_path, source).expect("module");
    let externs = collect_enum_extern_names(&module);

    assert!(externs.iter().any(|name| name == "None"));
    assert!(externs.iter().any(|name| name == "Mutable"));
    assert!(externs.iter().any(|name| name == "Watching"));
    assert!(externs.iter().any(|name| name == "Dirty"));
}

#[test]
fn inlines_relative_imported_enum_members() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir()
        .join(format!("gcc-ts-bundler-imported-enum-{unique}"))
        .join("node_modules/demo");
    let dep_file = root.join("flags.ts");
    let entry_file = root.join("index.ts");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &dep_file,
        "export const enum ReactiveFlags { None = 0, Dirty = 16 }\n",
    )
    .unwrap();
    fs::write(
            &entry_file,
            "import { ReactiveFlags } from './flags';\nexport const value = ReactiveFlags.None | ReactiveFlags.Dirty;\n",
        )
        .unwrap();

    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&entry_file, &empty_context())
        })
        .unwrap();

    assert!(
        transformed.contains("const value = 0 | 16;"),
        "{transformed}"
    );
}

#[test]
fn inlines_const_enum_members_defined_by_constant_expressions() {
    // TypeScript allows a whole constant-expression grammar in enum member
    // initializers, and a `const enum` has no runtime object to fall back on:
    // a member the folder gives up on is emitted as a property read against an
    // erased object, which throws at runtime instead of failing the build.
    // Cross-module, because that is the path where the object is gone for good.
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-enum-expr-{unique}"));
    let dep_file = root.join("dir.ts");
    let entry_file = root.join("index.ts");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &dep_file,
        concat!(
            "export const enum Dir {\n",
            "  Up = 1,\n",
            "  Down = 1 + Up,\n",
            "  Both = Down << 2,\n",
            "  Neg = -Down,\n",
            "  Mask = Both | Dir.Up,\n",
            "  Half = (Both + 2) / 5,\n",
            "  Next,\n",
            "}\n",
        ),
    )
    .unwrap();
    fs::write(
        &entry_file,
        concat!(
            "import { Dir } from './dir';\n",
            "export const values = [Dir.Up, Dir.Down, Dir.Both, Dir.Neg, Dir.Mask, Dir.Half, Dir.Next];\n",
        ),
    )
    .unwrap();

    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&entry_file, &empty_context())
        })
        .unwrap();

    // Up=1, Down=2, Both=8, Neg=-2, Mask=9, Half=2, Next=3 (auto-numbering
    // resumes from the folded value, as TypeScript does).
    assert!(
        transformed.contains("[\n    1,\n    2,\n    8,\n    -2,\n    9,\n    2,\n    3\n]")
            || transformed.contains("[1, 2, 8, -2, 9, 2, 3]"),
        "{transformed}"
    );
    assert!(!transformed.contains("Dir."), "{transformed}");
}

/// A scratch directory that deletes itself.
///
/// `/tmp` is a tmpfs here and every fixture that leaks a directory costs inodes
/// for the life of the box: the pre-existing `temp_dir().join(...)` sites in
/// this file leak one per fixture per run, which measured 45,946 stale entries
/// across accumulated runs. New fixtures use this; converting the older sites is
/// tracked separately because they are load-bearing for other lanes' tests.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gcc-ts-bundler-{name}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn join(&self, relative: &str) -> PathBuf {
        self.path.join(relative)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Emits one file through the real pipeline and returns the emitted text.
fn transform_single_source(name: &str, source: &str) -> String {
    let scratch = ScratchDir::new(name);
    let file = scratch.join("index.ts");
    fs::write(&file, source).unwrap();
    GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&file, &empty_context())
        })
        .unwrap()
        .code
}

#[test]
fn lowers_an_exported_enum_to_a_hoisted_binding_not_a_dead_zone_one() {
    // An exported enum must not be lowered onto a binding with a temporal dead
    // zone. `tsc` emits `export var Kind;` and swc matches it, so a value-position
    // read *before* the declaration executes reads `undefined`. oxc 0.142 emits
    // `export let Kind`, which turns the same read into a hard
    // `ReferenceError: Cannot access 'Kind' before initialization` -- and `typeof`
    // does not protect against TDZ either (OX-D3 audit §7, with an executing
    // repro). That is a divergence from tsc's emit contract, not a style
    // difference, so the swap has to keep var semantics (or hoist the
    // initialisation equivalently).
    //
    // Stated negatively on purpose: the *shape* of the lowering is free to change
    // in the port (the goldens will be re-baselined), the dead zone is not.
    let transformed = transform_single_source(
        "enum-tdz",
        concat!(
            "export function early(): string { return typeof Kind; }\n",
            "export const probe = early();\n",
            "export enum Kind { A = 1 }\n",
        ),
    );

    assert!(transformed.contains("var Kind"), "{transformed}");
    assert!(!transformed.contains("let Kind"), "{transformed}");
    // A `const` binding has the same dead zone, so it is no safer than `let`
    // *unless* the initialiser is emitted before every reader; the metadata
    // `@enum` shape does exactly that (it is emitted at the top of the module),
    // which is why this asserts on the lowered-object shape only.
    assert!(!transformed.contains("const Kind = function"), "{transformed}");
}

#[test]
fn merges_split_namespace_declaration_blocks_before_lowering() {
    // Declaration merging: the second block's body must see the first block's
    // members. SWC's `strip` only qualifies members declared in the same block,
    // so without the pre-merge this emits bare `Inner`/`version` reads that
    // Closure rejects with JSC_UNDEFINED_VARIABLE.
    let transformed = transform_single_source(
        "merged-namespace",
        concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "  export namespace Inner {\n",
            "    export function twice(value: number): number { return value * 2; }\n",
            "  }\n",
            "}\n",
            "export namespace Outer {\n",
            "  export function versionTwice(): number { return Inner.twice(version); }\n",
            "}\n",
        ),
    );

    assert!(
        transformed.contains("Outer.Inner.twice(Outer.version)"),
        "{transformed}"
    );
    // One lowered block, so one IIFE and one `Outer ||` initializer.
    assert_eq!(transformed.matches("Outer || (Outer = {})").count(), 1, "{transformed}");
}

#[test]
fn merges_split_namespace_blocks_across_declarations_and_at_every_depth() {
    // Blocks need not be adjacent: declarations may sit between them, and a
    // nested namespace split across two *parent* blocks only becomes a sibling
    // pair after the outer merge, so the merge has to recurse afterwards.
    let transformed = transform_single_source(
        "merged-namespace-nested",
        concat!(
            "export namespace Outer {\n",
            "  export namespace Inner {\n",
            "    export const tag = \"INNER\";\n",
            "  }\n",
            "}\n",
            "export function between(): number { return 1; }\n",
            "export namespace Outer {\n",
            "  export namespace Inner {\n",
            "    export function read(): string { return tag; }\n",
            "  }\n",
            "}\n",
        ),
    );

    assert!(transformed.contains("Inner.tag"), "{transformed}");
    assert_eq!(transformed.matches("Outer || (Outer = {})").count(), 1, "{transformed}");
    assert_eq!(
        transformed.matches("Outer.Inner || (Outer.Inner = {})").count(),
        1,
        "{transformed}"
    );
}

#[test]
fn leaves_split_namespace_blocks_alone_when_merging_would_reorder_work() {
    // A statement between the blocks would run *after* the second body once the
    // bodies are merged, so this group keeps today's behaviour rather than
    // silently changing evaluation order.
    let transformed = transform_single_source(
        "merged-namespace-reorder",
        concat!(
            "export namespace Outer {\n",
            "  export const version = 3;\n",
            "}\n",
            "console.log(\"between\");\n",
            "export namespace Outer {\n",
            "  export function read(): number { return 7; }\n",
            "}\n",
        ),
    );

    assert_eq!(transformed.matches("Outer || (Outer = {})").count(), 2, "{transformed}");
    let between = transformed.find("between").expect("{transformed}");
    let second = transformed.rfind("Outer || (Outer = {})").expect("{transformed}");
    assert!(between < second, "{transformed}");
}

#[test]
fn renders_named_enum_externs() {
    let externs = render_externs(
        &BTreeSet::new(),
        &BTreeMap::from([(
            "ReactiveFlags".to_string(),
            BTreeSet::from([
                "None".to_string(),
                "Mutable".to_string(),
                "Watching".to_string(),
            ]),
        )]),
    );

    assert!(externs.contains("Object.prototype.None;"), "{externs}");
    assert!(externs.contains("Object.prototype.Mutable;"), "{externs}");
    assert!(externs.contains("Object.prototype.Watching;"), "{externs}");
}

#[test]
fn bundler_runtime_rewrites_namespace_member_reads_to_numeric_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-abi-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export const marker = 'x';\nexport function renderMessage() { return marker; }\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        "import * as feature from './feature';\nexport default feature.renderMessage();\n",
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "marker".to_string(),
                                "renderMessage".to_string(),
                            ])),
                        ),
                        (
                            main_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(transformed.contains("feature[1]()"), "{transformed}");
    assert!(!transformed.contains("renderMessage"), "{transformed}");
    assert!(transformed.contains("__exports[0]="), "{transformed}");
    assert!(
        !transformed.contains("__exports[\"default\"]"),
        "{transformed}"
    );
    assert!(transformed.contains("__register("), "{transformed}");
    assert!(
        transformed.contains(
            "function(__require, __exports, __dynamicImport, __preloadDynamicImport, __live)"
        ),
        "{transformed}"
    );
    assert!(!transformed.contains(", []"), "{transformed}");
}

#[test]
fn off_mode_keeps_namespace_import_bindings_before_top_level_destructures() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-namespace-off-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export const protocol = { PartA: 1, PartB: 2 };\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        "import * as runtime from './feature';\nconst { PartA, PartB } = runtime.protocol;\nexport default PartA + PartB;\n",
    )
    .unwrap();

    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&main_file, &empty_context())
        })
        .unwrap();

    let import_index = transformed
        .find("const runtime = __goog_import_0;")
        .expect("namespace import binding");
    let destructure_index = transformed
        .find("const { PartA, PartB } = runtime.protocol;")
        .expect("namespace destructure");

    assert!(import_index < destructure_index, "{transformed}");
}

#[test]
fn bundler_runtime_rejects_reflective_namespace_usage() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-diagnostics-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(&feature_file, "export const marker = 'x';\n").unwrap();
    fs::write(
        &main_file,
        "import * as feature from './feature';\nconsole.log(Object.keys(feature));\n",
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let error = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "marker".to_string(),
                            ])),
                        ),
                        (
                            main_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap_err();

    assert!(
        error.contains("reflective Object.* operations on module namespace values"),
        "{error}"
    );
}

#[test]
fn bundler_runtime_keeps_namespace_import_bindings_before_top_level_destructures() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-namespace-runtime-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export const protocol = { PartA: 1, PartB: 2 };\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        "import * as runtime from './feature';\nconst { PartA, PartB } = runtime.protocol;\nexport default PartA + PartB;\n",
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "protocol".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    let import_index = transformed
        .find("const runtime = __gcc_import_0;")
        .expect("namespace import binding");
    let destructure_index = transformed
        .find("const { PartA, PartB } = runtime[0];")
        .expect("namespace destructure");

    assert!(import_index < destructure_index, "{transformed}");
}

#[test]
fn bundler_runtime_keeps_named_imports_live_instead_of_snapshotting_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-live-imports-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(&feature_file, "export let documentRef;\n").unwrap();
    fs::write(
        &main_file,
        "import { documentRef } from './feature';\nexport default function setTitle() { documentRef.title = 'ok'; }\n",
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "documentRef".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("const __gcc_import_0 = __require("),
        "{transformed}"
    );
    assert!(
        transformed.contains("__gcc_import_0[0].title = 'ok';"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("const documentRef ="),
        "{transformed}"
    );
}

#[test]
fn bundler_runtime_keeps_exported_let_bindings_live() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-live-export-{unique}"));
    let src_dir = root.join("src");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(&main_file, "export let count = 0;\ncount += 1;\n").unwrap();

    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([(
                        main_module_id,
                        super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                            "count".to_string()
                        ])),
                    )]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("__live(__exports,0,function(){return count;});"),
        "{transformed}"
    );
}

#[test]
fn bundler_runtime_packs_named_reexports_from_single_dependency() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-packed-reexports-{unique}"));
    let src_dir = root.join("src");
    let dep_file = src_dir.join("dep.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &dep_file,
        "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n",
    )
    .unwrap();
    fs::write(&main_file, "export { alpha, beta, gamma } from './dep';\n").unwrap();

    let dep_module_id = to_goog_module_id(&dep_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            dep_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("__live(__exports,__gcc_export_0,[0,0,1,1,2,2]);"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("__live(__exports,0,function(){return __gcc_export_0[0];});"),
        "{transformed}"
    );
}

#[test]
fn bundler_runtime_packs_export_all_from_single_dependency() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-packed-export-all-{unique}"));
    let src_dir = root.join("src");
    let dep_file = src_dir.join("dep.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &dep_file,
        "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n",
    )
    .unwrap();
    fs::write(&main_file, "export * from './dep';\n").unwrap();

    let dep_module_id = to_goog_module_id(&dep_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            dep_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("__live(__exports,__gcc_export_all_0,[0,0,1,1,2,2]);"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("__live(__exports,0,function(){return __gcc_export_all_0[0];});"),
        "{transformed}"
    );
}

#[test]
fn bundler_runtime_packs_imported_slot_alias_reexports_per_source() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-packed-import-aliases-{unique}"));
    let src_dir = root.join("src");
    let alpha_file = src_dir.join("alpha.ts");
    let beta_file = src_dir.join("beta.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &alpha_file,
        "export const alpha = 1;\nexport const beta = 2;\n",
    )
    .unwrap();
    fs::write(
        &beta_file,
        "export const gamma = 3;\nexport const delta = 4;\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        [
            "import { alpha, beta } from './alpha';",
            "import { gamma, delta } from './beta';",
            "export { alpha, beta, gamma, delta };",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let alpha_module_id = to_goog_module_id(&alpha_file, &root);
    let beta_module_id = to_goog_module_id(&beta_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            alpha_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                            ])),
                        ),
                        (
                            beta_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "delta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "alpha".to_string(),
                                "beta".to_string(),
                                "delta".to_string(),
                                "gamma".to_string(),
                            ])),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("__live(__exports,__gcc_import_0,[0,0,1,1]);"),
        "{transformed}"
    );
    assert!(
        transformed.contains("__live(__exports,__gcc_import_1,[2,0,3,1]);"),
        "{transformed}"
    );
    assert!(
        !transformed.contains("__live(__exports,0,function(){return __gcc_import_0[0];});"),
        "{transformed}"
    );
}

#[test]
fn bundler_runtime_rewrites_promise_consumer_callback_params_to_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-callback-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export default function feature() { return 'ok'; }\n",
    )
    .unwrap();
    fs::write(
            &main_file,
            [
                "const loaders = { panel: () => __dynamicImport('gcc.src.feature') };",
                "const selected = state(null);",
                "setState(selected, loaders.panel());",
                "awaitLike(() => readState(selected), null, (anchor, module) => module.default(anchor));",
                "",
            ]
            .join("\n"),
        )
        .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(transformed.contains("module[0](anchor)"), "{transformed}");
    assert!(!transformed.contains(".default"), "{transformed}");
}

#[test]
fn bundler_runtime_rewrites_wrapped_promise_consumer_callback_params_to_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-callback-wrapped-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export default function feature() { return 'ok'; }\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        [
            "const modules = [{ id: 'button', label: 'Button', note: 'lazy panel', load: () => __dynamicImport('gcc.src.feature') }];",
            "const active = state(null);",
            "setState(active, modules.find(Boolean) ?? modules[0]);",
            "const selected = state(null);",
            "setState(selected, get(active).load());",
            "awaitLike(() => get(selected), null, (anchor, module) => get(module).default(anchor));",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("get(module)[0](anchor)"),
        "{transformed}"
    );
    assert!(!transformed.contains(".default"), "{transformed}");
}

#[test]
fn bundler_runtime_rewrites_nested_wrapped_promise_consumer_callback_params_to_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-callback-nested-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export default function feature() { return 'ok'; }\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        [
            "const modules = [{ id: 'button', label: 'Button', note: 'lazy panel', load: () => __dynamicImport('gcc.src.feature') }];",
            "const active = state(null);",
            "setState(active, modules.find(Boolean) ?? modules[0]);",
            "const selected = state(null);",
            "setState(selected, get(active).load());",
            "awaitLike(anchor, () => get(selected), null, (outer, module) => {",
            "  renderComponent(outer, () => get(module).default, (inner, component) => {",
            "    component(inner, {});",
            "  });",
            "});",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(transformed.contains("get(module)[0]"), "{transformed}");
    assert!(!transformed.contains(".default"), "{transformed}");
}

#[test]
fn bundler_runtime_rewrites_realistic_helper_wrapped_consumer_callbacks_to_slots() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-slot-callback-real-{unique}"));
    let src_dir = root.join("src");
    let feature_file = src_dir.join("feature.ts");
    let main_file = src_dir.join("main.ts");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(
        &feature_file,
        "export default function feature() { return 'ok'; }\n",
    )
    .unwrap();
    fs::write(
        &main_file,
        [
            "const entries = [{ key: 'button', label: 'Button', note: 'lazy panel', load: function(){ return __dynamicImport('gcc.src.feature'); } }];",
            "const selection = __gcc_import_0[30]('button');",
            "const mounted = __gcc_import_0[30](false);",
            "const pendingModule = __gcc_import_0[30](null);",
            "const currentEntry = __gcc_import_0[30](entries[0]);",
            "const resolveEntry = function(entryKey){ var _a; return (_a = entries.find(function(entry){ return entry.key === entryKey; })) != null ? _a : entries[0]; };",
            "__gcc_import_0[27](function(){ return __gcc_import_0[22](selection); }, function(){ var nextEntry = resolveEntry(__gcc_import_0[22](selection)); __gcc_import_0[38](currentEntry, nextEntry); if (__gcc_import_0[22](mounted)) __gcc_import_0[38](pendingModule, nextEntry.load()); });",
            "__gcc_import_0[12](node, function(){ return __gcc_import_0[22](pendingModule); }, null, function(anchor, module){ __gcc_import_0[16](anchor, function(){ return __gcc_import_0[22](module).default; }, function(inner, component){ component(inner, {}); }); });",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let feature_module_id = to_goog_module_id(&feature_file, &root);
    let main_module_id = to_goog_module_id(&main_file, &root);
    let transformed = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &main_file,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::from([
                        (
                            feature_module_id.clone(),
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                                "default".to_string(),
                            ])),
                        ),
                        (
                            main_module_id,
                            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
                        ),
                    ]),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::BundlerRuntime,
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
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(
        transformed.contains("__gcc_import_0[22](module)[0]"),
        "{transformed}"
    );
    assert!(!transformed.contains(".default"), "{transformed}");
}

#[test]
fn collects_realistic_helper_wrapped_object_and_promise_carriers() {
    let source = [
        "const entries = [{ key: 'button', label: 'Button', note: 'lazy panel', load: function(){ return __dynamicImport('gcc.src.feature'); } }];",
        "const selection = __gcc_import_0[30]('button');",
        "const mounted = __gcc_import_0[30](false);",
        "const pendingModule = __gcc_import_0[30](null);",
        "const currentEntry = __gcc_import_0[30](entries[0]);",
        "const resolveEntry = function(entryKey){ var _a; return (_a = entries.find(function(entry){ return entry.key === entryKey; })) != null ? _a : entries[0]; };",
        "__gcc_import_0[27](function(){ return __gcc_import_0[22](selection); }, function(){ var nextEntry = resolveEntry(__gcc_import_0[22](selection)); __gcc_import_0[38](currentEntry, nextEntry); if (__gcc_import_0[22](mounted)) __gcc_import_0[38](pendingModule, nextEntry.load()); });",
        "",
    ]
    .join("\n");
    let file_path = PathBuf::from("/tmp/realistic-helper-carriers.js");
    let module = crate::module_cache::parse_module(&file_path, &source).unwrap();
    let wrappers = super::collect_dynamic_import_wrappers(&module);
    let object_carriers = super::collect_dynamic_import_object_carriers(&module, &wrappers);
    let promise_carriers =
        super::collect_dynamic_import_promise_carriers(&module, &object_carriers, &wrappers);

    assert!(
        wrappers
            .object_wrappers
            .keys()
            .any(|id| id.symbol() == "entries"),
        "{wrappers:?}"
    );
    assert!(
        wrappers
            .object_function_wrappers
            .keys()
            .any(|id| id.symbol() == "resolveEntry"),
        "{wrappers:?}"
    );
    assert!(
        object_carriers
            .keys()
            .any(|id| id.symbol() == "nextEntry"),
        "{object_carriers:?}"
    );
    assert!(
        promise_carriers
            .keys()
            .any(|id| id.symbol() == "pendingModule"),
        "{promise_carriers:?}"
    );
}

struct CrossChunkFixture {
    context: super::TranspileContext,
    files: HashMap<String, PathBuf>,
    plan: std::sync::Arc<super::HoistPlan>,
    root: PathBuf,
}

/// origin/reexport live in chunk 1, main in chunk 0: every import edge in this
/// fixture crosses a chunk boundary through a pure re-export facade.
fn make_cross_chunk_fixture(label: &str, lazy_target: Option<&str>) -> CrossChunkFixture {
    make_cross_chunk_fixture_with_main(label, lazy_target, None)
}

fn make_cross_chunk_fixture_with_main(
    label: &str,
    lazy_target: Option<&str>,
    main_source: Option<&str>,
) -> CrossChunkFixture {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let default_main_source = if lazy_target.is_some() {
        concat!(
            "export async function loadAwait() { const module = await import('./reexport'); return [module.default(), module.marker, module.renderMessage()]; }\n",
            "export const loadThen = () => import('./reexport').then(module => module.default());\n",
            "export async function loadDestructure() { const { default: render, marker } = await import('./reexport'); return [render(), marker]; }\n",
            "export async function loadMutable() { const module = await import('./reexport'); module.increment(); return module.count; }\n",
        )
    } else {
        "import { renderMessage } from './reexport';\nconsole.log(renderMessage());\n"
    };
    let sources = [
        (
            "origin.ts",
            concat!(
                "export default function renderDefault() { return marker; }\n",
                "export let count = 0;\n",
                "export function increment() { count += 1; }\n",
                "export const marker = 'x';\n",
                "export function renderMessage() { return marker; }\n",
            ),
        ),
        (
            "reexport.ts",
            "export { default, count, increment, marker, renderMessage } from './origin';\n",
        ),
        ("main.ts", main_source.unwrap_or(default_main_source)),
    ];
    let mut files = HashMap::new();
    for (name, text) in sources {
        let path = src_dir.join(name);
        fs::write(&path, text).unwrap();
        files.insert(name.to_string(), path);
    }

    let file_names = ["origin.ts", "reexport.ts", "main.ts"]
        .iter()
        .map(|name| files[*name].to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let chunk_graph = vec![
        // `main` statically imports from `shared`, so `shared` has to have run
        // first: the vendor shape, where the plan puts the dependency chunk
        // ahead of the base and base carries the generated import edge.
        super::TranspileChunkInput {
            dependencies: vec!["shared".to_string()],
            files: vec!["src/main.ts".to_string()],
            name: "main".to_string(),
        },
        super::TranspileChunkInput {
            dependencies: vec![],
            files: vec!["src/origin.ts".to_string(), "src/reexport.ts".to_string()],
            name: "shared".to_string(),
        },
    ];
    let lazy_imports = lazy_target
        .map(|name| {
            vec![super::LazyImportInput {
                importerFilePath: files["main.ts"].to_string_lossy().to_string(),
                moduleId: to_goog_module_id(&files[name], &root),
                specifier: format!("./{}", name.trim_end_matches(".ts")),
                targetPath: files[name].to_string_lossy().to_string(),
            }]
        })
        .unwrap_or_default();

    let plan = std::sync::Arc::new(
        super::build_hoist_plan(
            &file_names,
            &root,
            &[],
            &HashMap::new(),
            &chunk_graph,
            &lazy_imports,
            &HashMap::new(),
        )
        .unwrap()
        .expect("hoist plan"),
    );

    let slots = ["origin.ts", "reexport.ts"]
        .iter()
        .map(|name| {
            (
                to_goog_module_id(&files[*name], &root),
                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                    "count".to_string(),
                    "default".to_string(),
                    "increment".to_string(),
                    "marker".to_string(),
                    "renderMessage".to_string(),
                ])),
            )
        })
        .chain(std::iter::once((
            to_goog_module_id(&files["main.ts"], &root),
            super::BundlerModuleSlots::from_export_names(&BTreeSet::new()),
        )))
        .collect::<HashMap<_, _>>();

    let context = super::TranspileContext {
        bundler_module_slots: slots.clone(),
        bundler_runtime_logical_ids: slots
            .keys()
            .map(|module_id| {
                (
                    crate::pathing::to_bundler_runtime_module_id(module_id),
                    module_id.clone(),
                )
            })
            .collect(),
        chunk_mode: super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        file_metadata: HashMap::new(),
        hoist_plan: Some(plan.clone()),
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: super::group_lazy_imports_by_file(lazy_imports.clone()),
        lazy_target_module_ids: lazy_imports
            .iter()
            .map(|lazy_import| lazy_import.moduleId.clone())
            .collect(),
        resolved_module_ids: HashMap::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: true,
        vendor_module_ids: HashSet::new(),
        workspace_dir: root.clone(),
    };

    CrossChunkFixture {
        context,
        files,
        plan,
        root,
    }
}

fn emit(fixture: &CrossChunkFixture, name: &str) -> String {
    GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.files[name], &fixture.context)
        })
        .unwrap()
        .code
}

#[test]
fn hoisted_cross_chunk_import_emits_direct_binding() {
    let fixture = make_cross_chunk_fixture("cross-chunk-direct", None);
    let ordinal = fixture
        .plan
        .ordinal_of(&to_goog_module_id(
            &fixture.files["origin.ts"],
            &fixture.root,
        ))
        .unwrap();
    let transformed = emit(&fixture, "main.ts");

    assert!(
        transformed.contains(&format!("renderMessage$${ordinal}()")),
        "{transformed}"
    );
    assert!(!transformed.contains("__require("), "{transformed}");
    assert!(!transformed.contains("__register("), "{transformed}");
}

#[test]
fn hoisted_pure_reexport_facade_is_pruned() {
    let fixture = make_cross_chunk_fixture("cross-chunk-prune", None);
    let reexport_module_id = to_goog_module_id(&fixture.files["reexport.ts"], &fixture.root);

    assert!(
        fixture.plan.facade_slots_for(&reexport_module_id).is_none(),
        "{:?}",
        fixture.plan.facade_slots
    );
    assert!(!emit(&fixture, "reexport.ts").contains("__register("));
    assert!(!emit(&fixture, "origin.ts").contains("__register("));
}

#[test]
fn hoisted_pure_esm_dynamic_import_uses_slots_and_named_facade() {
    let fixture = make_cross_chunk_fixture("cross-chunk-lazy", Some("reexport.ts"));
    let main = emit(&fixture, "main.ts");
    let facade = emit(&fixture, "reexport.ts");
    let origin_module_id = to_goog_module_id(&fixture.files["origin.ts"], &fixture.root);
    let origin_ordinal = fixture.plan.ordinal_of(&origin_module_id).unwrap();
    let reexport_module_id = to_goog_module_id(&fixture.files["reexport.ts"], &fixture.root);
    let slots = &fixture.context.bundler_module_slots[&reexport_module_id];

    assert!(main.contains("__dynamicImport("), "{main}");
    assert!(main.contains(".then("), "{main}");
    for named_access in [
        ".default",
        ".increment",
        ".marker",
        ".renderMessage",
        ".count",
    ] {
        assert!(!main.contains(named_access), "{main}");
    }

    assert!(facade.contains("__register("), "{facade}");
    for (export_name, local_name) in [
        ("default", "renderDefault"),
        ("increment", "increment"),
        ("marker", "marker"),
        ("renderMessage", "renderMessage"),
    ] {
        let slot = slots.slot_for(export_name).unwrap();
        assert!(
            facade.contains(&format!(
                "__exports[{slot}]={local_name}$${origin_ordinal};"
            )),
            "{facade}"
        );
    }
    assert!(
        facade.contains("Object.defineProperties(__exports"),
        "{facade}"
    );
    assert!(facade.contains("__exports.__esModule = true;"), "{facade}");
    assert!(!facade.contains("__require("), "{facade}");
}

#[test]
fn hoisted_mutable_same_chunk_reexport_stays_live() {
    let fixture = make_cross_chunk_fixture("cross-chunk-lazy-live", Some("reexport.ts"));
    let facade = emit(&fixture, "reexport.ts");
    let origin_module_id = to_goog_module_id(&fixture.files["origin.ts"], &fixture.root);
    let origin_ordinal = fixture.plan.ordinal_of(&origin_module_id).unwrap();
    let reexport_module_id = to_goog_module_id(&fixture.files["reexport.ts"], &fixture.root);
    let count_slot = fixture.context.bundler_module_slots[&reexport_module_id]
        .slot_for("count")
        .unwrap();

    assert!(
        facade.contains(&format!(
            "__live(__exports,{count_slot},function(){{return count$${origin_ordinal};}});"
        )),
        "{facade}"
    );
}

#[test]
fn hoisted_lazy_target_with_escaping_namespace_keeps_named_facade() {
    let fixture = make_cross_chunk_fixture_with_main(
        "cross-chunk-lazy-escape",
        Some("reexport.ts"),
        Some("import * as namespace from './reexport';\nglobalThis.namespace = namespace;\n"),
    );
    let facade = emit(&fixture, "reexport.ts");

    assert!(
        facade.contains("Object.defineProperties(__exports"),
        "{facade}"
    );
    assert!(facade.contains("__exports.__esModule = true;"), "{facade}");
}

#[test]
fn hoisted_commonjs_dynamic_target_keeps_named_facade() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-cross-chunk-lazy-cjs-{unique}"));
    let main_file = root.join("src/main.ts");
    let commonjs_file = root.join("node_modules/demo/index.js");
    fs::create_dir_all(main_file.parent().unwrap()).unwrap();
    fs::create_dir_all(commonjs_file.parent().unwrap()).unwrap();
    fs::write(
        &main_file,
        "export const load = () => import('../node_modules/demo/index.js').then(module => module.default());\n",
    )
    .unwrap();
    fs::write(
        &commonjs_file,
        "module.exports = function demo() { return 'ok'; };\n",
    )
    .unwrap();

    let file_names = vec![
        main_file.to_string_lossy().to_string(),
        commonjs_file.to_string_lossy().to_string(),
    ];
    let commonjs_module_id = to_goog_module_id(&commonjs_file, &root);
    let lazy_imports = vec![super::LazyImportInput {
        importerFilePath: main_file.to_string_lossy().to_string(),
        moduleId: commonjs_module_id.clone(),
        specifier: "../node_modules/demo/index.js".to_string(),
        targetPath: commonjs_file.to_string_lossy().to_string(),
    }];
    let chunk_graph = vec![
        super::TranspileChunkInput {
            dependencies: vec![],
            files: vec!["src/main.ts".to_string()],
            name: "main".to_string(),
        },
        super::TranspileChunkInput {
            dependencies: vec!["main".to_string()],
            files: vec!["node_modules/demo/index.js".to_string()],
            name: "lazy".to_string(),
        },
    ];
    let slots = super::collect_bundler_module_slots(
        &file_names,
        &root,
        &[],
        &HashMap::new(),
        &HashMap::new(),
    )
    .unwrap();
    let plan = std::sync::Arc::new(
        super::build_hoist_plan(
            &file_names,
            &root,
            &[],
            &HashMap::new(),
            &chunk_graph,
            &lazy_imports,
            &HashMap::new(),
        )
        .unwrap()
        .expect("hoist plan"),
    );
    let context = super::TranspileContext {
        bundler_module_slots: slots,
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        opaque_commonjs: Default::default(),
        file_metadata: HashMap::new(),
        hoist_plan: Some(plan),
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: super::group_lazy_imports_by_file(lazy_imports.clone()),
        lazy_target_module_ids: HashSet::from([commonjs_module_id]),
        resolved_module_ids: HashMap::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        type_metadata_enabled: true,
        vendor_module_ids: HashSet::new(),
        workspace_dir: root,
    };
    let facade = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&commonjs_file, &context)
        })
        .unwrap()
        .code;

    assert!(
        facade.contains("Object.defineProperties(__exports"),
        "{facade}"
    );
    assert!(facade.contains("default"), "{facade}");
    assert!(facade.contains("__exports.__esModule = true;"), "{facade}");
}

/// A bundler-runtime build with no chunk graph gets no hoist plan
/// (`build_hoist_plan` returns `None` for an empty graph), and emission then
/// falls back to registry form. This is a live path, not the deleted
/// `GCC_DISABLE_HOIST` mode: hoisting is now unconditional whenever a plan
/// exists.
#[test]
fn emission_without_a_hoist_plan_stays_registry_form() {
    let mut fixture = make_cross_chunk_fixture("cross-chunk-no-plan", None);
    let reexport_module_id = to_goog_module_id(&fixture.files["reexport.ts"], &fixture.root);
    let render_slot = fixture.context.bundler_module_slots[&reexport_module_id]
        .slot_for("renderMessage")
        .unwrap();
    fixture.context.hoist_plan = None;
    let transformed = emit(&fixture, "main.ts");

    assert!(transformed.contains("__register("), "{transformed}");
    assert!(transformed.contains("__require("), "{transformed}");
    assert!(
        transformed.contains(&format!("[{render_slot}]()")),
        "{transformed}"
    );
    assert!(!transformed.contains("$$"), "{transformed}");
}

// --- unified Closure type metadata -----------------------------------------

struct TypedDeliveryFixture {
    context: super::TranspileContext,
    file_path: PathBuf,
    ordinal: Option<usize>,
}

fn runtime_symbol(id: &str, name: &str) -> crate::closure_metadata::ClosureTypeSymbol {
    crate::closure_metadata::ClosureTypeSymbol {
        builtin_name: None,
        declaration_file_path: None,
        declaration_id: None,
        declaration_start: None,
        diagnostic_name: name.to_string(),
        id: id.to_string(),
        kind: "runtime".to_string(),
        local_name: Some(name.to_string()),
    }
}

fn declared_symbol(id: &str, name: &str) -> crate::closure_metadata::ClosureTypeSymbol {
    crate::closure_metadata::ClosureTypeSymbol {
        builtin_name: None,
        declaration_file_path: None,
        declaration_id: Some(format!("{id}:declaration")),
        declaration_start: None,
        diagnostic_name: name.to_string(),
        id: id.to_string(),
        kind: "declared".to_string(),
        local_name: None,
    }
}

fn type_reference(token: &str, symbol_id: &str) -> crate::closure_metadata::ClosureTypeReference {
    crate::closure_metadata::ClosureTypeReference {
        symbol_id: symbol_id.to_string(),
        token: token.to_string(),
    }
}

fn binding_annotation(
    name: &str,
    template: &str,
    references: Vec<crate::closure_metadata::ClosureTypeReference>,
) -> crate::closure_metadata::ClosureAnnotation {
    crate::closure_metadata::ClosureAnnotation {
        references,
        target: crate::closure_metadata::ClosureAnnotationTarget::Binding {
            binding_name: name.to_string(),
        },
        template: template.to_string(),
        type_bearing: true,
    }
}

fn member_annotation(
    owner: &str,
    kind: &str,
    name: &str,
    is_static: bool,
    template: &str,
    references: Vec<crate::closure_metadata::ClosureTypeReference>,
) -> crate::closure_metadata::ClosureAnnotation {
    crate::closure_metadata::ClosureAnnotation {
        references,
        target: crate::closure_metadata::ClosureAnnotationTarget::Member {
            member_kind: kind.to_string(),
            member_name: name.to_string(),
            owner_binding_name: owner.to_string(),
            is_static,
        },
        template: template.to_string(),
        type_bearing: true,
    }
}

fn make_typed_delivery_fixture(
    label: &str,
    chunk_mode: super::ChunkMode,
    metadata_enabled: bool,
    hoisted: bool,
) -> TypedDeliveryFixture {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    let file_path = src_dir.join("main.ts");
    fs::write(
        &file_path,
        concat!(
            "export const enum Kind { Ready = 1, Done = 2 }\n",
            "export class Widget {\n",
            "  value;\n",
            "  method(item) { return item; }\n",
            "}\n",
            "export function use(widget, ghost) { return widget; }\n",
        ),
    )
    .unwrap();

    let metadata = crate::closure_metadata::ClosureFileMetadata {
        annotations: vec![
            binding_annotation(
                "use",
                "/**\n * @param {!__GCC_TYPE_0__} widget\n * @param {!__GCC_TYPE_1__} ghost\n * @return {!__GCC_TYPE_2__}\n */\n",
                vec![
                    type_reference("__GCC_TYPE_0__", "runtime:widget"),
                    type_reference("__GCC_TYPE_1__", "runtime:ghost"),
                    type_reference("__GCC_TYPE_2__", "declared:config"),
                ],
            ),
            member_annotation(
                "Widget",
                "field",
                "value",
                false,
                "/** @type {!__GCC_TYPE_3__} */\n",
                vec![type_reference("__GCC_TYPE_3__", "runtime:widget")],
            ),
            member_annotation(
                "Widget",
                "method",
                "method",
                false,
                "/** @param {!__GCC_TYPE_4__} item @return {!__GCC_TYPE_5__} */\n",
                vec![
                    type_reference("__GCC_TYPE_4__", "runtime:widget"),
                    type_reference("__GCC_TYPE_5__", "declared:config"),
                ],
            ),
        ],
        declarations: vec![crate::closure_metadata::ClosureTypeDeclaration {
            declared_symbol_id: "declared:config".to_string(),
            exported: true,
            id: "declared:config:declaration".to_string(),
            references: vec![type_reference("__GCC_TYPE_6__", "runtime:widget")],
            template: concat!(
                "/** @record */\n",
                "function Config() {}\n",
                "/** @type {!__GCC_TYPE_6__} */\n",
                "Config.prototype.owner;\n",
            )
            .to_string(),
        }],
        ambient_globals: Vec::new(),
        erased_const_enums: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: vec![crate::closure_metadata::ClosureEnumDeclaration {
            binding_name: "Kind".to_string(),
            exported: true,
            members: vec![
                crate::closure_metadata::ClosureEnumMember {
                    name: "Ready".to_string(),
                    value: serde_json::json!(1),
                },
                crate::closure_metadata::ClosureEnumMember {
                    name: "Done".to_string(),
                    value: serde_json::json!(2),
                },
            ],
            symbol_id: "enum:kind".to_string(),
            value_type: "number".to_string(),
        }],
        file_path: file_path.to_string_lossy().to_string(),
        runtime_module_id: None,
        source_file_path: file_path.to_string_lossy().to_string(),
        symbols: vec![
            runtime_symbol("runtime:widget", "Widget"),
            runtime_symbol("runtime:ghost", "Ghost"),
            runtime_symbol("enum:kind", "Kind"),
            declared_symbol("declared:config", "Config"),
        ],
    };
    let metadata_map = HashMap::from([(
        crate::closure_metadata::closure_metadata_key(&file_path),
        metadata,
    )]);
    let module_id = to_goog_module_id(&file_path, &root);
    let chunk_graph = vec![super::TranspileChunkInput {
        dependencies: vec![],
        files: vec!["src/main.ts".to_string()],
        name: "main".to_string(),
    }];
    let plan = if chunk_mode == super::ChunkMode::BundlerRuntime && hoisted {
        super::build_hoist_plan(
            &[file_path.to_string_lossy().to_string()],
            &root,
            &[],
            &HashMap::new(),
            &chunk_graph,
            &[],
            &metadata_map,
        )
        .unwrap()
        .map(std::sync::Arc::new)
    } else {
        None
    };
    let ordinal = plan.as_ref().and_then(|value| value.ordinal_of(&module_id));
    let slots = (chunk_mode == super::ChunkMode::BundlerRuntime)
        .then(|| {
            HashMap::from([(
                module_id,
                super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                    "Kind".to_string(),
                    "Widget".to_string(),
                    "use".to_string(),
                ])),
            )])
        })
        .unwrap_or_default();

    TypedDeliveryFixture {
        context: super::TranspileContext {
            bundler_module_slots: slots,
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: metadata_map,
            hoist_plan: plan,
            preserved_property_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            resolved_module_ids: HashMap::new(),
            package_aliases: Vec::new(),
            static_property_names: HashSet::new(),
            type_metadata_enabled: metadata_enabled,
            vendor_module_ids: HashSet::new(),
            workspace_dir: root,
        },
        file_path,
        ordinal,
    }
}

fn emit_typed_delivery(fixture: &TypedDeliveryFixture) -> super::EmittedProgram {
    GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap()
}

fn assert_full_typed_delivery(
    output: &super::EmittedProgram,
    runtime_name: &str,
    declaration_name: &str,
) {
    assert!(
        output.contains(&format!("@param {{!{runtime_name}}} widget")),
        "{output}"
    );
    assert!(output.contains("@param {?} ghost"), "{output}");
    assert!(output.contains("@record"), "{output}");
    assert!(output.contains("@enum {number}"), "{output}");
    assert!(
        output.contains(&format!("{runtime_name}.prototype.value")),
        "{output}"
    );
    assert!(output.contains(declaration_name), "{output}");
    assert_eq!(output.type_metadata.counts.annotationCount, 1);
    assert_eq!(output.type_metadata.counts.memberAnnotationCount, 2);
    assert_eq!(output.type_metadata.counts.typeDeclarationCount, 1);
    assert_eq!(output.type_metadata.counts.enumDeclarationCount, 1);
    assert_eq!(output.type_metadata.counts.unresolvedTypeReferenceCount, 1);
    assert!(output
        .type_metadata
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.reason == "runtime-binding-not-found"));
}

#[test]
fn typed_metadata_delivers_in_off_mode() {
    // `goog.module` emission is now unique to unchunked output: `split` joined
    // the shared chunked emission path, so its former row here asserted a shape
    // that no longer exists rather than a behaviour worth keeping.
    let output = emit_typed_delivery(&make_typed_delivery_fixture(
        "typed-off",
        super::ChunkMode::Off,
        true,
        false,
    ));
    assert_full_typed_delivery(&output, "Widget", "function Config()");
    assert!(output.starts_with("goog.module("), "{output}");
}

#[test]
fn typed_metadata_delivers_declarations_enums_and_members_through_hoisting() {
    let fixture = make_typed_delivery_fixture(
        "typed-hoisted",
        super::ChunkMode::BundlerRuntime,
        true,
        true,
    );
    let ordinal = fixture.ordinal.expect("hoist ordinal");
    let output = emit_typed_delivery(&fixture);
    assert_full_typed_delivery(
        &output,
        &format!("Widget$${ordinal}"),
        &format!("function Config$$type$${ordinal}()"),
    );
    assert!(
        output.contains(&format!("class Widget$${ordinal}")),
        "{output}"
    );
    assert!(
        output.contains(&format!("function Config$$type$${ordinal}()")),
        "{output}"
    );
    assert!(
        output.contains(&format!("const Kind$${ordinal}")),
        "{output}"
    );
    assert!(!output.contains("__register("), "{output}");
}

#[test]
fn typed_metadata_delivers_declarations_enums_and_members_in_registry_runtime() {
    let fixture = make_typed_delivery_fixture(
        "typed-registry",
        super::ChunkMode::BundlerRuntime,
        true,
        false,
    );
    let output = emit_typed_delivery(&fixture);
    assert_full_typed_delivery(&output, "Widget", "function Config()");
    assert!(output.contains("__register("), "{output}");
}

#[test]
fn typed_metadata_escape_hatch_omits_optional_types_but_keeps_enum_lowering() {
    let fixture = make_typed_delivery_fixture(
        "typed-disabled",
        super::ChunkMode::BundlerRuntime,
        false,
        true,
    );
    let output = emit_typed_delivery(&fixture);
    assert!(!output.contains("@param"), "{output}");
    assert!(!output.contains("@record"), "{output}");
    assert!(output.contains("@enum {number}"), "{output}");
    assert_eq!(output.type_metadata.counts.annotationCount, 0);
    assert_eq!(output.type_metadata.counts.memberAnnotationCount, 0);
    assert_eq!(output.type_metadata.counts.typeDeclarationCount, 0);
    assert_eq!(output.type_metadata.counts.enumDeclarationCount, 1);
    assert_eq!(output.type_metadata.counts.unresolvedTypeReferenceCount, 0);
}

struct TypedImportFixture {
    context: super::TranspileContext,
    main: PathBuf,
    origin_ordinal: Option<usize>,
}

fn make_typed_import_fixture(label: &str, hoisted: bool) -> TypedImportFixture {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    let origin = src_dir.join("origin.ts");
    let main = src_dir.join("main.ts");
    fs::write(&origin, "export class Money { minor = 0; }\n").unwrap();
    fs::write(
        &main,
        "import { Money as Cash } from './origin';\nexport const sample = new Cash();\nexport function total(cash) { return cash.minor; }\n",
    )
    .unwrap();
    let metadata = crate::closure_metadata::ClosureFileMetadata {
        annotations: vec![binding_annotation(
            "total",
            "/** @param {!__GCC_TYPE_0__} cash @return {number} */\n",
            vec![type_reference("__GCC_TYPE_0__", "runtime:cash")],
        )],
        declarations: Vec::new(),
        ambient_globals: Vec::new(),
        erased_const_enums: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        file_path: main.to_string_lossy().to_string(),
        runtime_module_id: None,
        source_file_path: main.to_string_lossy().to_string(),
        symbols: vec![runtime_symbol("runtime:cash", "Cash")],
    };
    let metadata_map = HashMap::from([(
        crate::closure_metadata::closure_metadata_key(&main),
        metadata,
    )]);
    let file_names = vec![
        origin.to_string_lossy().to_string(),
        main.to_string_lossy().to_string(),
    ];
    let chunk_graph = vec![super::TranspileChunkInput {
        dependencies: vec![],
        files: vec!["src/origin.ts".to_string(), "src/main.ts".to_string()],
        name: "main".to_string(),
    }];
    let plan = hoisted
        .then(|| {
            super::build_hoist_plan(
                &file_names,
                &root,
                &[],
                &HashMap::new(),
                &chunk_graph,
                &[],
                &metadata_map,
            )
            .unwrap()
            .map(std::sync::Arc::new)
        })
        .flatten();
    let origin_module_id = to_goog_module_id(&origin, &root);
    let main_module_id = to_goog_module_id(&main, &root);
    let origin_ordinal = plan
        .as_ref()
        .and_then(|value| value.ordinal_of(&origin_module_id));
    TypedImportFixture {
        context: super::TranspileContext {
            bundler_module_slots: HashMap::from([
                (
                    origin_module_id,
                    super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                        "Money".to_string()
                    ])),
                ),
                (
                    main_module_id,
                    super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                        "total".to_string(),
                        "sample".to_string(),
                    ])),
                ),
            ]),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::BundlerRuntime,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: metadata_map,
            hoist_plan: plan,
            preserved_property_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            resolved_module_ids: HashMap::new(),
            package_aliases: Vec::new(),
            static_property_names: HashSet::new(),
            type_metadata_enabled: true,
            vendor_module_ids: HashSet::new(),
            workspace_dir: root,
        },
        main,
        origin_ordinal,
    }
}

#[test]
fn typed_import_alias_resolves_to_authoritative_hoisted_origin_binding() {
    let fixture = make_typed_import_fixture("typed-import-hoisted", true);
    let origin_ordinal = fixture.origin_ordinal.expect("origin ordinal");
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.main, &fixture.context)
        })
        .unwrap();
    assert!(
        output.contains(&format!("@param {{!Money$${origin_ordinal}}} cash")),
        "{output}"
    );
    assert_eq!(output.type_metadata.counts.unresolvedTypeReferenceCount, 0);
}

#[test]
fn typed_registry_import_degrades_only_the_unnameable_atom() {
    let fixture = make_typed_import_fixture("typed-import-registry", false);
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.main, &fixture.context)
        })
        .unwrap();
    assert!(output.contains("@param {?} cash"), "{output}");
    assert!(output.contains("@return {number}"), "{output}");
    assert_eq!(output.type_metadata.counts.annotationCount, 1);
    assert_eq!(output.type_metadata.counts.unresolvedTypeReferenceCount, 1);
    assert!(output
        .type_metadata
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.reason == "registry-slot-is-not-a-type-name"));
}

// --- vendor assigner detection (JSC_IMPORT_ASSIGN hardening) -------------

fn assigner_names_of(source: &str, bindings: &[&str]) -> Vec<String> {
    use super::assigners::assigner_function_name;
    let module = parse_module(std::path::Path::new("fixture.js"), source).expect("module");
    let bindings = bindings
        .iter()
        .map(|name| name.to_string())
        .collect::<HashSet<_>>();
    module
        .body
        .iter()
        .filter_map(|item| match item {
            super::ModuleItem::Stmt(statement) => assigner_function_name(statement, &bindings),
            _ => None,
        })
        .collect()
}

#[test]
fn detects_functions_that_write_module_state_in_every_assignment_form() {
    let source = concat!(
        "function plain$$1() { state$$1 = 1; }\n",
        "function compound$$1() { state$$1 += 1; }\n",
        "function logical$$1() { state$$1 ??= 1; }\n",
        "function increment$$1() { return ++state$$1; }\n",
        "function decrement$$1() { state$$1--; }\n",
        "function reads$$1() { return state$$1; }\n",
    );

    assert_eq!(
        assigner_names_of(source, &["state$$1"]),
        vec![
            "plain$$1",
            "compound$$1",
            "logical$$1",
            "increment$$1",
            "decrement$$1",
        ],
    );
}

#[test]
fn a_nested_write_to_outer_module_state_pins_the_enclosing_declaration() {
    // Inlining hoists the closure into the caller along with its enclosing
    // function, so the top-level declaration is what has to stay put.
    let source = concat!(
        "function outer$$1() {\n",
        "  return function inner() { state$$1 = 1; };\n",
        "}\n",
        "function arrow$$1() {\n",
        "  queue(() => { state$$1 += 1; });\n",
        "}\n",
    );

    assert_eq!(
        assigner_names_of(source, &["state$$1"]),
        vec!["outer$$1", "arrow$$1"],
    );
}

#[test]
fn local_and_property_writes_are_not_module_state() {
    let source = concat!(
        // A local shadowing nothing: hoisting suffixes every top-level
        // binding, so a local can never collide with one.
        "function locals$$1() { var state = 1; state = 2; state++; }\n",
        // Writing through an object mutates the object, not the binding, so
        // it cannot produce JSC_IMPORT_ASSIGN.
        "function members$$1() { state$$1.field = 1; state$$1.count++; }\n",
        // Comparison is not assignment.
        "function compares$$1() { return state$$1 === 1; }\n",
        // A different module's binding is that module's problem.
        "function other$$1() { other$$2 = 1; }\n",
    );

    assert!(assigner_names_of(source, &["state$$1"]).is_empty());
}

#[test]
fn no_module_bindings_means_nothing_to_pin() {
    // Non-vendor chunks pass an empty set: motion out of base and lazy
    // chunks is legal and is how those chunks stay small.
    assert!(assigner_names_of("function f$$1() { state$$1 = 1; }\n", &[]).is_empty());
}

#[test]
fn the_noinline_tag_merges_into_one_block_with_pure_and_typed_tags() {
    use super::assigners::NOINLINE_TAG;
    use super::type_metadata::{compose_annotations, PURE_TAG};

    // Closure keeps only the JSDoc block nearest the declaration, so two
    // adjacent blocks would silently drop the first.
    assert_eq!(
        compose_annotations(&[NOINLINE_TAG], None),
        "/** @noinline */\n"
    );
    assert_eq!(
        compose_annotations(&[PURE_TAG, NOINLINE_TAG], None),
        "/** @pureOrBreakMyCode @noinline */\n",
    );
    assert_eq!(
        compose_annotations(&[NOINLINE_TAG], Some("/** @type {number} */\n")),
        "/** @noinline @type {number} */\n",
    );
    assert_eq!(
        compose_annotations(
            &[PURE_TAG, NOINLINE_TAG],
            Some("/**\n * @param {number} a\n */\n"),
        ),
        "/** @pureOrBreakMyCode @noinline\n * @param {number} a\n */\n",
    );
    // Unchanged when nothing applies, and the pure-only form is exactly the
    // block `pure_calls` owns.
    assert_eq!(compose_annotations(&[], None), "");
    assert_eq!(
        compose_annotations(&[PURE_TAG], None),
        super::pure_calls::PURE_JSDOC,
    );
}

#[test]
fn the_pin_lists_annotated_functions_against_the_chunks_own_alias() {
    use super::assigners::{collect_annotated_assigner_names, render_assigner_pin};

    let chunk_text = concat!(
        "/** @noinline */\nfunction a$$1(){ s$$1=1; }\n",
        "function skipped$$1(){}\n",
        "/** @pureOrBreakMyCode @noinline */\nfunction b$$1(){ s$$1++; }\n",
        "/**\n * @noinline\n * @param {number} x\n */\nfunction c$$1(x){ s$$1=x; }\n",
    );
    let names = collect_annotated_assigner_names(chunk_text);

    assert_eq!(names, vec!["a$$1", "b$$1", "c$$1"]);
    assert_eq!(
        render_assigner_pin("__runtime_0", &names).as_deref(),
        Some("__runtime_0.v=[a$$1,b$$1,c$$1];"),
    );
    // Nothing annotated, nothing pinned: a bare property write would still
    // cost bytes in every chunk that has no mutating functions.
    assert_eq!(render_assigner_pin("__runtime_0", &[]), None);
    assert!(collect_annotated_assigner_names("function a$$1(){}\n").is_empty());
}

#[test]
fn only_vendor_chunk_modules_are_pinned() {
    use crate::pathing::{is_vendor_chunk_name, vendor_chunk_name};

    // The chunk name is the only channel: nothing but `files` and `name`
    // crosses the napi boundary into the transpiler.
    assert_eq!(vendor_chunk_name("main"), "main-vendor");
    assert!(is_vendor_chunk_name(&vendor_chunk_name("main")));
    assert!(!is_vendor_chunk_name("main"));
    assert!(!is_vendor_chunk_name("main-shared"));
    assert!(!is_vendor_chunk_name("src-panel-lazy"));
}

/// Builds a workspace with one CommonJS package and one ESM consumer that
/// exercises all three export-ABI emission sites, and returns
/// `(producer_output, consumer_output)`.
fn transform_cjs_abi_fixture(label: &str, package_source: &str) -> (String, String) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-cjs-abi-{label}-{unique}"));
    let package_file = root.join("node_modules/demo/index.js");
    let consumer_file = root.join("src/consumer.js");
    fs::create_dir_all(package_file.parent().unwrap()).unwrap();
    fs::create_dir_all(consumer_file.parent().unwrap()).unwrap();
    fs::write(&package_file, package_source).unwrap();
    fs::write(
        &consumer_file,
        // namespace read (site C1) and named import (site C2)
        "import * as ns from \"demo\";\nimport { alpha } from \"demo\";\nexport const value = ns.beta + alpha;\n",
    )
    .unwrap();

    let package_aliases = vec![super::PackageAliasInput {
        packageName: "demo".to_string(),
        subpath: ".".to_string(),
        targetPath: package_file.to_string_lossy().to_string(),
    }];
    let commonjs_specifiers = HashSet::from(["demo".to_string()]);
    let file_names = vec![
        package_file.to_string_lossy().to_string(),
        consumer_file.to_string_lossy().to_string(),
    ];

    let mut context = empty_context();
    context.workspace_dir = root.clone();
    context.commonjs_specifiers = commonjs_specifiers.clone();
    context.package_aliases = package_aliases.clone();
    let opacity = super::cjs_opacity::collect_opaque_commonjs(
        &file_names,
        &commonjs_specifiers,
        &package_aliases,
    )
    .expect("opacity");
    context.opaque_commonjs = std::sync::Arc::new(opacity);

    GLOBALS.set(&Globals::new(), || {
        (
            transform_source_file(&package_file, &context)
                .expect("producer")
                .code,
            transform_source_file(&consumer_file, &context)
                .expect("consumer")
                .code,
        )
    })
}

#[test]
fn cjs_export_abi_agrees_across_all_three_emission_sites() {
    // A name quoted at one site and renamed at another resolves to `undefined`
    // at runtime, so the producer write, the namespace read and the named-import
    // destructure must always agree. This asserts the agreement in both
    // directions rather than either form on its own.
    let (transparent_producer, transparent_consumer) =
        transform_cjs_abi_fixture("transparent", "exports.alpha = 1;\nexports.beta = 2;\n");
    assert!(
        transparent_producer.contains("module[\"exports\"].alpha = 1;"),
        "producer: {transparent_producer}"
    );
    assert!(
        transparent_consumer.contains("ns.beta"),
        "consumer: {transparent_consumer}"
    );
    assert!(
        transparent_consumer.contains(".alpha") && !transparent_consumer.contains("[\"alpha\"]"),
        "consumer: {transparent_consumer}"
    );

    let (opaque_producer, opaque_consumer) = transform_cjs_abi_fixture(
        "opaque",
        "exports.alpha = 1;\nexports.beta = 2;\nregister(Object.keys(exports));\n",
    );
    assert!(
        opaque_producer.contains("module[\"exports\"][\"alpha\"] = 1;"),
        "producer: {opaque_producer}"
    );
    assert!(
        opaque_consumer.contains("ns[\"beta\"]"),
        "consumer: {opaque_consumer}"
    );
    assert!(
        opaque_consumer.contains("[\"alpha\"]"),
        "consumer: {opaque_consumer}"
    );
}

#[test]
fn reflecting_commonjs_module_keeps_literal_export_names() {
    // `Object.keys` over its own exports means the names are readable as data;
    // the whole package surface must stay literal.
    let (producer, consumer) = transform_cjs_abi_fixture(
        "reflecting",
        "exports.alpha = 1;\nexports.beta = 2;\nmodule.exports.names = Object.keys(exports);\n",
    );
    assert!(
        producer.contains("module[\"exports\"][\"alpha\"] = 1;"),
        "{producer}"
    );
    assert!(
        producer.contains("module[\"exports\"][\"beta\"] = 2;"),
        "{producer}"
    );
    assert!(consumer.contains("ns[\"beta\"]"), "{consumer}");
}

#[test]
fn non_reflecting_commonjs_module_renames_export_names() {
    let (producer, consumer) =
        transform_cjs_abi_fixture("plain", "exports.alpha = 1;\nexports.beta = 2;\n");
    assert!(
        producer.contains("module[\"exports\"].alpha = 1;"),
        "{producer}"
    );
    assert!(
        !producer.contains("module[\"exports\"][\"alpha\"]"),
        "{producer}"
    );
    assert!(consumer.contains("ns.beta"), "{consumer}");
    assert!(!consumer.contains("ns[\"beta\"]"), "{consumer}");
}

#[test]
fn consumer_side_reflection_pins_the_package_surface() {
    // The reflection is in the *importer*, not the package: the verdict must
    // still reach the producer, or the producer would rename what the consumer
    // reads as a string.
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-cjs-consumer-{unique}"));
    let package_file = root.join("node_modules/demo/index.js");
    let consumer_file = root.join("src/consumer.js");
    fs::create_dir_all(package_file.parent().unwrap()).unwrap();
    fs::create_dir_all(consumer_file.parent().unwrap()).unwrap();
    fs::write(&package_file, "exports.alpha = 1;\n").unwrap();
    fs::write(
        &consumer_file,
        "import * as ns from \"demo\";\nexport const keys = Object.keys(ns);\nexport const dyn = (k) => ns[k];\n",
    )
    .unwrap();

    let package_aliases = vec![super::PackageAliasInput {
        packageName: "demo".to_string(),
        subpath: ".".to_string(),
        targetPath: package_file.to_string_lossy().to_string(),
    }];
    let commonjs_specifiers = HashSet::from(["demo".to_string()]);
    let opacity = super::cjs_opacity::collect_opaque_commonjs(
        &[
            package_file.to_string_lossy().to_string(),
            consumer_file.to_string_lossy().to_string(),
        ],
        &commonjs_specifiers,
        &package_aliases,
    )
    .expect("opacity");

    assert!(opacity.specifier_is_opaque("demo"));
    assert!(opacity.file_is_opaque(&package_file));
}

#[test]
fn ts_export_assignment_does_not_reference_module_exports() {
    // `export = x` used to reach SWC's TypeScript strip untouched, which lowers
    // it to `module.exports = x`. Every output shape here is a `goog.module`,
    // where `module` is unbound, so Closure rejected the file with
    // JSC_UNDEFINED_VARIABLE for *any* source using `export =`.
    let file_path = PathBuf::from("/tmp/src/es5_exports.ts");
    let source = "let x = 0;\nexport = x;\n";
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_program(
                parse_module(&file_path, source).expect("module"),
                &file_path,
                &empty_context(),
                None,
            )
            .and_then(|program| print_program(&program))
        })
        .expect("transform");

    assert!(!output.contains("module.exports"), "{output}");
    assert!(!output.contains("module["), "{output}");
    assert!(output.contains("x = 0"), "{output}");
}

#[test]
fn ts_export_assignment_of_a_call_keeps_the_expression() {
    let file_path = PathBuf::from("/tmp/src/reexport.ts");
    let source = "function make() { return 1; }\nexport = make();\n";
    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_program(
                parse_module(&file_path, source).expect("module"),
                &file_path,
                &empty_context(),
                None,
            )
            .and_then(|program| print_program(&program))
        })
        .expect("transform");

    assert!(!output.contains("module.exports"), "{output}");
    assert!(output.contains("make()"), "{output}");
}

#[test]
fn ambient_declarations_are_not_program_declared_names() {
    // `declare` emits no runtime binding, so the name is *not* provided by the
    // program and must stay eligible for the ambient extern channel. Counting
    // it as program-declared suppressed the extern its own reference needed
    // (JSC_UNDEFINED_VARIABLE: Component).
    let file_path = PathBuf::from("/tmp/src/decorated.ts");
    let source = [
        "declare const Component: any;",
        "declare function ambientCall(): void;",
        "declare class AmbientClass {}",
        "const realConst = 1;",
        "function realFn() {}",
        "class RealClass {}",
        "export const use = [Component, ambientCall, AmbientClass, realConst, realFn, RealClass];",
        "",
    ]
    .join("\n");
    let names = super::externs::collect_program_declared_names_for_test(&file_path, &source)
        .expect("declared names");

    for ambient in ["Component", "ambientCall", "AmbientClass"] {
        assert!(!names.contains(ambient), "{ambient} in {names:?}");
    }
    for declared in ["realConst", "realFn", "RealClass"] {
        assert!(
            names.contains(declared),
            "{declared} missing from {names:?}"
        );
    }
}

/// The marker spelling is an ABI: the `in` probe and the property read that
/// follows it must be the *same* name, or the probe silently answers "no" and
/// the consumer binds the namespace object instead of the exports bag.
const CJS_EXPORT_MARKER: &str = "__cjsExports";

/// Anything that can rewrite a property name into a different symbol. If one of
/// these ever reaches the marker, the string and the property stop agreeing.
const RENAME_PRIMITIVES: [&str; 3] = [
    "JSCompiler_renameProperty",
    "goog.reflect.objectProperty",
    "goog.reflect.object",
];

/// Extracts every `"<quoted>" in <ns> ? <ns>.<dotted> : <ns>` interop probe as
/// the (quoted, dotted) pair whose agreement is the whole invariant.
fn cjs_interop_probes(source: &str) -> Vec<(String, String)> {
    let mut probes = Vec::new();
    for (index, _) in source.match_indices(" in ") {
        let head = &source[..index];
        let Some(close) = head.rfind('"') else {
            continue;
        };
        let Some(open) = head[..close].rfind('"') else {
            continue;
        };
        let tail = &source[index + " in ".len()..];
        let (Some(question), Some(colon)) = (tail.find(" ? "), tail.find(" : ")) else {
            continue;
        };
        if question > colon {
            continue;
        }
        let consequent = &tail[question + 3..colon];
        let Some(dot) = consequent.rfind('.') else {
            continue;
        };
        probes.push((
            head[open + 1..close].to_string(),
            consequent[dot + 1..].trim().to_string(),
        ));
    }
    probes
}

fn collect_rust_sources(directory: &std::path::Path, into: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read crate source dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, into);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && path.file_name().is_some_and(|name| name != "tests.rs")
        {
            into.push(path);
        }
    }
}

/// The companion guard to `cjs_export_abi_agrees_across_all_three_emission_sites`.
///
/// That test compares the three emitters to each other, so it passes even when
/// all three are wrong in the same direction — it passed throughout the W2
/// mangling experiment that produced a silent miscompile. This one anchors the
/// marker to a fixed spelling instead, and fails on the two ways a fourth path
/// can appear: a rename primitive reaching the marker, and a new file emitting
/// it without anyone revisiting the ABI.
#[test]
fn cjs_export_marker_is_never_reachable_through_a_rename_primitive() {
    // 1. Dynamic: the emitted interop probe must be self-consistent. This is
    //    the exact desync W2-A reproduced — `"M" in aa ? aa.__cjsExports : aa`,
    //    where the string was renamed and the property was not.
    let chain = transform_cjs_interop_chain_fixture("rename-guard");
    let probes = cjs_interop_probes(&chain);
    assert!(
        !probes.is_empty(),
        "fixture no longer emits the interop probe, so this test proves nothing: {chain}"
    );
    for (quoted, dotted) in &probes {
        assert_eq!(
            quoted, CJS_EXPORT_MARKER,
            "probe string desynced from the ABI marker: {chain}"
        );
        assert_eq!(
            dotted, CJS_EXPORT_MARKER,
            "probe property desynced from the ABI marker: {chain}"
        );
    }
    // The quoted marker must survive for opaque packages specifically.
    assert!(
        chain.contains(&format!("\"{CJS_EXPORT_MARKER}\" in ")),
        "opaque output lost the quoted marker: {chain}"
    );
    for primitive in RENAME_PRIMITIVES {
        assert!(
            !chain.contains(primitive),
            "emitted output routes through {primitive}: {chain}"
        );
    }

    // 2. Static: no rename primitive may co-occur with the marker anywhere in
    //    the crate, and the set of emitting files is pinned so a fourth
    //    emission path cannot land unnoticed.
    let mut sources = Vec::new();
    collect_rust_sources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut sources,
    );
    let mut emitting = BTreeSet::new();
    for source in &sources {
        let text = fs::read_to_string(source).expect("read crate source");
        if !text.contains(CJS_EXPORT_MARKER) {
            continue;
        }
        for line in text.lines() {
            if !line.contains(CJS_EXPORT_MARKER) {
                continue;
            }
            for primitive in RENAME_PRIMITIVES {
                assert!(
                    !line.contains(primitive),
                    "{} reaches the CommonJS export marker through {primitive}: {line}",
                    source.display()
                );
            }
        }
        emitting.insert(
            source
                .strip_prefix(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
                .expect("relative source path")
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
    let expected: BTreeSet<String> = [
        "support_files.rs",
        "transpile/context.rs",
        "transpile/emit_hoist.rs",
        "transpile/emit_hoist_oxc.rs",
        "transpile/emit_runtime.rs",
        "transpile/emit_runtime_oxc.rs",
        "transpile/hoist.rs",
        "transpile/imports_exports/bindings.rs",
        "transpile/js_compat/ast.rs",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(
        emitting, expected,
        "the set of files mentioning the CommonJS export marker changed. A new \
         emission path must agree with the existing ones on the literal \
         spelling and must not route through a rename primitive; update this \
         list once that is verified."
    );
}

fn transform_cjs_interop_chain_fixture(label: &str) -> String {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-cjs-chain-{label}-{unique}"));
    let demo = root.join("node_modules/demo/index.js");
    let other = root.join("node_modules/other/index.js");
    fs::create_dir_all(demo.parent().unwrap()).unwrap();
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    // `demo` is a CommonJS file that *requires* another CommonJS package, which
    // is the path that emits the `"__cjsExports" in ns ? ns.__cjsExports : ns`
    // interop probe.
    fs::write(&demo, "const other = require(\"other\");\nexports.alpha = other.x;\nregister(Object.keys(exports));\n").unwrap();
    fs::write(&other, "exports.x = 1;\n").unwrap();

    let package_aliases = vec![
        super::PackageAliasInput {
            packageName: "demo".to_string(),
            subpath: ".".to_string(),
            targetPath: demo.to_string_lossy().to_string(),
        },
        super::PackageAliasInput {
            packageName: "other".to_string(),
            subpath: ".".to_string(),
            targetPath: other.to_string_lossy().to_string(),
        },
    ];
    let commonjs_specifiers = HashSet::from(["demo".to_string(), "other".to_string()]);
    let file_names = vec![
        demo.to_string_lossy().to_string(),
        other.to_string_lossy().to_string(),
    ];

    let mut context = empty_context();
    context.workspace_dir = root.clone();
    context.commonjs_specifiers = commonjs_specifiers.clone();
    context.package_aliases = package_aliases.clone();
    let opacity = super::cjs_opacity::collect_opaque_commonjs(
        &file_names,
        &commonjs_specifiers,
        &package_aliases,
    )
    .expect("opacity");
    context.opaque_commonjs = std::sync::Arc::new(opacity);

    GLOBALS.set(&Globals::new(), || {
        transform_source_file(&demo, &context).expect("chain").code
    })
}

fn pair_array_rule() -> super::ClassMapCallInput {
    super::ClassMapCallInput {
        argIndex: 1,
        callee: "default".to_string(),
        calleeModulePattern: Some("plugin-vue[:-]export-helper".to_string()),
        keyExcludePattern: None,
        keyPattern: None,
        keySource: Some("pairArray".to_string()),
        stringLiteralArgIndex: None,
    }
}

fn pair_array_names(source: &str) -> Vec<String> {
    let module = parse_module(&PathBuf::from("fixture.js"), source).unwrap();
    let mut names = super::compat::collect_pair_array_class_map_property_names(
        &module,
        &[pair_array_rule()],
    )
    .unwrap()
    .into_iter()
    .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn pair_array_key_source_collects_entry_keys_by_import_identity() {
    let names = pair_array_names(concat!(
        "import _export_sfc from './__virtual__/plugin-vue-export-helper.js';\n",
        "export default _export_sfc(main, [['render', render], ['__scopeId', 'data-v-1']]);\n",
    ));
    assert_eq!(
        names,
        vec!["__scopeId".to_string(), "render".to_string()],
        "{names:?}"
    );
}

#[test]
fn pair_array_key_source_ignores_same_spelling_from_another_module() {
    // Spelling is not identity: the same local name imported from elsewhere
    // is a different function with different semantics.
    let names = pair_array_names(concat!(
        "import _export_sfc from './helpers/unrelated.js';\n",
        "export default _export_sfc(main, [['render', render]]);\n",
    ));
    assert!(names.is_empty(), "{names:?}");
}

#[test]
fn pair_array_key_source_fails_closed_on_irregular_entries() {
    // Holes, spreads, computed/non-literal first elements, non-array entries,
    // and a spread argument each prove nothing and must contribute nothing.
    let names = pair_array_names(concat!(
        "import _export_sfc from './__virtual__/plugin-vue-export-helper.js';\n",
        "_export_sfc(main, [, ...rest, [key, value], ['ok', value], 'render', [[nested], v]]);\n",
        "_export_sfc(main, ...spreadArgs);\n",
    ));
    assert_eq!(names, vec!["ok".to_string()], "{names:?}");
}

#[test]
fn pair_array_key_source_is_opt_in_per_rule() {
    let module = parse_module(
        &PathBuf::from("fixture.js"),
        concat!(
            "import _export_sfc from './__virtual__/plugin-vue-export-helper.js';\n",
            "_export_sfc(main, [['render', render]]);\n",
        ),
    )
    .unwrap();
    let object_literal_rule = super::ClassMapCallInput {
        keySource: None,
        ..pair_array_rule()
    };
    let names =
        super::compat::collect_pair_array_class_map_property_names(&module, &[object_literal_rule])
            .unwrap();
    assert!(names.is_empty(), "{names:?}");
}

#[test]
fn pair_array_key_source_rejects_unknown_key_source_values() {
    let calls = vec![super::ClassMapCallInput {
        keySource: Some("objectArray".to_string()),
        ..pair_array_rule()
    }];
    let error = super::validate_class_map_calls(&calls).expect_err("invalid keySource");
    assert!(error.contains("keySource"), "{error}");
    assert!(error.contains("pairArray"), "{error}");
}
