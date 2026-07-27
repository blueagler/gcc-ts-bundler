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
        file_metadata: HashMap::new(),
        hoist_plan: None,
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        typed_annotations: HashMap::new(),
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
            file_metadata: HashMap::new(),
            hoist_plan: None,
            preserved_property_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: vec![super::PackageAliasInput {
                packageName: "react".to_string(),
                subpath: ".".to_string(),
                targetPath: workspace_dir
                    .join("node_modules/react/index.js")
                    .to_string_lossy()
                    .to_string(),
            }],
            static_property_names: HashSet::new(),
            typed_annotations: HashMap::new(),
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
fn generated_externs_include_only_hard_static_protocols() {
    let externs = render_generated_externs(&HashSet::from([
        "formAssociated".to_string(),
        "observedAttributes".to_string(),
    ]));

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
    let transformed = apply_js_compat_text_fixes(
        "import item from '.';\nexport { other } from '..';\n".to_string(),
    );

    assert!(transformed.contains("from './index.js'"), "{transformed}");
    assert!(transformed.contains("from '../index.js'"), "{transformed}");
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
    let transformed = apply_js_compat_text_fixes(
        "if (process.env.NODE_ENV !== 'production') console.warn('dev');\n".to_string(),
    );

    assert!(
        transformed.contains("\"production\" !== 'production'"),
        "{transformed}"
    );
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
            file_metadata: HashMap::new(),
            hoist_plan: None,
            preserved_property_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: Vec::new(),
            static_property_names: HashSet::new(),
            typed_annotations: HashMap::new(),
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
    assert!(transformed.contains("demo[\"answer\"]"), "{transformed}");
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

    assert!(
        output.contains("module.exports[\"Component\"] = Component;"),
        "{output}"
    );
    assert!(
        output.contains("module.exports[\"createContext\"] = createContext;"),
        "{output}"
    );
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
        file_metadata: HashMap::new(),
        hoist_plan: None,
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
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
        typed_annotations: HashMap::new(),
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
        output.contains("module[\"exports\"] = React[\"Component\"];"),
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
            file_metadata: HashMap::new(),
            hoist_plan: None,
            preserved_property_names: HashSet::from([
                "formAssociated".to_string(),
                "observedAttributes".to_string(),
            ]),
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: vec![],
            static_property_names: HashSet::from([
                "formAssociated".to_string(),
                "observedAttributes".to_string(),
            ]),
            typed_annotations: HashMap::new(),
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
            callee: "set_class".to_string(),
            keyPattern: None,
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

    // CommonJS namespaces carry literal keys, so the read must be quoted.
    assert!(
        transformed.contains("React[\"forwardRef\"]"),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
                    file_metadata: HashMap::new(),
                    hoist_plan: None,
                    preserved_property_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    lazy_target_module_ids: HashSet::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    typed_annotations: HashMap::new(),
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
            .any(|id| id.0.as_ref() == "entries"),
        "{wrappers:?}"
    );
    assert!(
        wrappers
            .object_function_wrappers
            .keys()
            .any(|id| id.0.as_ref() == "resolveEntry"),
        "{wrappers:?}"
    );
    assert!(
        object_carriers
            .keys()
            .any(|id| id.0.as_ref() == "nextEntry"),
        "{object_carriers:?}"
    );
    assert!(
        promise_carriers
            .keys()
            .any(|id| id.0.as_ref() == "pendingModule"),
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
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let sources = [
        (
            "origin.ts",
            "export const marker = 'x';\nexport function renderMessage() { return marker; }\n",
        ),
        (
            "reexport.ts",
            "export { marker, renderMessage } from './origin';\n",
        ),
        (
            "main.ts",
            "import { renderMessage } from './reexport';\nconsole.log(renderMessage());\n",
        ),
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
        super::TranspileChunkInput {
            files: vec!["src/main.ts".to_string()],
            name: "main".to_string(),
        },
        super::TranspileChunkInput {
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
        bundler_module_slots: slots,
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        hoist_plan: Some(plan.clone()),
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: lazy_imports
            .iter()
            .map(|lazy_import| lazy_import.moduleId.clone())
            .collect(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        typed_annotations: HashMap::new(),
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
fn hoisted_dynamic_import_target_keeps_facade() {
    let fixture = make_cross_chunk_fixture("cross-chunk-lazy", Some("reexport.ts"));
    let transformed = emit(&fixture, "reexport.ts");

    assert!(transformed.contains("__register("), "{transformed}");
    // Slots of a lazy facade still resolve straight to the origin binding
    // rather than re-entering the registry.
    assert!(transformed.contains("return marker$$"), "{transformed}");
    assert!(!transformed.contains("__require("), "{transformed}");
}

#[test]
fn registry_fallback_emission_is_unchanged_without_hoist_plan() {
    let mut fixture = make_cross_chunk_fixture("cross-chunk-fallback", None);
    fixture.context.hoist_plan = None;
    let transformed = emit(&fixture, "main.ts");

    assert!(transformed.contains("__register("), "{transformed}");
    assert!(transformed.contains("__require("), "{transformed}");
    assert!(transformed.contains("[1]()"), "{transformed}");
    assert!(!transformed.contains("$$"), "{transformed}");
}

// --- typed annotations (docs/research/typed-input.md) ---------------------

struct TypedFixture {
    context: super::TranspileContext,
    file_path: PathBuf,
    ordinal: usize,
}

/// A single hoisted module exercising every JSDoc-attachable declaration
/// form: exported class, exported function, exported single-declarator
/// const, a `__PURE__`-initialized const, and an unannotated const.
fn make_typed_fixture(label: &str, annotations: &[(&str, &str)]) -> TypedFixture {
    make_typed_fixture_from(label, TYPED_FIXTURE_SOURCE, annotations)
}

/// The v1 fixture body: every JSDoc-attachable declaration form, plus a
/// `__PURE__` initializer and an unannotated const.
const TYPED_FIXTURE_SOURCE: &str = concat!(
    "export class Widget { constructor() { this.size = 1; } }\n",
    "export function measure(widget) { return widget.size; }\n",
    "export const label = 'w';\n",
    "const built = /*#__PURE__*/ makeWidget();\n",
    "const plain = 2;\n",
    "function makeWidget() { return new Widget(); }\n",
    "console.log(measure(built), label, plain);\n",
);

fn make_typed_fixture_from(
    label: &str,
    source: &str,
    annotations: &[(&str, &str)],
) -> TypedFixture {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    let file_path = src_dir.join("main.ts");
    fs::write(&file_path, source).unwrap();

    let file_names = vec![file_path.to_string_lossy().to_string()];
    let chunk_graph = vec![super::TranspileChunkInput {
        files: vec!["src/main.ts".to_string()],
        name: "main".to_string(),
    }];
    let plan = std::sync::Arc::new(
        super::build_hoist_plan(&file_names, &root, &[], &chunk_graph, &[], &HashMap::new())
            .unwrap()
            .expect("hoist plan"),
    );
    let module_id = to_goog_module_id(&file_path, &root);
    let ordinal = plan.ordinal_of(&module_id).expect("ordinal");

    let mut context = make_typed_context(&root, plan, &module_id);
    if !annotations.is_empty() {
        context.typed_annotations.insert(
            super::typed_annotations::annotation_key(&file_path),
            annotations
                .iter()
                .map(|(name, jsdoc)| {
                    (
                        name.to_string(),
                        super::typed_annotations::TypedBindingAnnotation {
                            jsdoc: jsdoc.to_string(),
                            members: HashMap::new(),
                        },
                    )
                })
                .collect(),
        );
    }

    TypedFixture {
        context,
        file_path,
        ordinal,
    }
}

fn make_typed_context(
    root: &std::path::Path,
    plan: std::sync::Arc<super::HoistPlan>,
    module_id: &str,
) -> super::TranspileContext {
    super::TranspileContext {
        bundler_module_slots: HashMap::from([(
            module_id.to_string(),
            super::BundlerModuleSlots::from_export_names(&BTreeSet::from([
                "Widget".to_string(),
                "label".to_string(),
                "measure".to_string(),
            ])),
        )]),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        hoist_plan: Some(plan),
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        typed_annotations: HashMap::new(),
        vendor_module_ids: HashSet::new(),
        workspace_dir: root.to_path_buf(),
    }
}

fn emit_typed(fixture: &TypedFixture) -> String {
    GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(&fixture.file_path, &fixture.context)
        })
        .unwrap()
}

#[test]
fn hoisted_typed_bindings_receive_their_jsdoc() {
    let fixture = make_typed_fixture(
        "typed-basic",
        &[
            ("Widget", "/** @constructor */\n"),
            (
                "measure",
                "/**\n * @param {!Widget} widget\n * @return {number}\n */\n",
            ),
            ("label", "/** @type {string} */\n"),
        ],
    );
    let ordinal = fixture.ordinal;
    let transformed = emit_typed(&fixture);

    // Annotations are keyed by the pre-hoist name but must land on the
    // suffixed declaration the emitter actually prints.
    assert!(
        transformed.contains(&format!("/** @constructor */\nclass Widget$${ordinal}")),
        "{transformed}"
    );
    // Same-module type references are rewritten to the suffixed class name.
    assert!(
        transformed.contains(&format!(
            "@param {{!Widget$${ordinal}}} widget\n * @return {{number}}\n */\nfunction measure$${ordinal}"
        )),
        "{transformed}"
    );
    assert!(
        transformed.contains(&format!("/** @type {{string}} */\nconst label$${ordinal}")),
        "{transformed}"
    );
}

#[test]
fn hoisted_typed_annotation_merges_with_pure_annotation() {
    let fixture = make_typed_fixture("typed-pure", &[("built", "/** @type {!Widget} */\n")]);
    let ordinal = fixture.ordinal;
    let transformed = emit_typed(&fixture);

    // Closure keeps only the JSDoc block nearest the declaration, so the two
    // annotations must arrive as one block, not two adjacent ones.
    assert!(
        transformed.contains(&format!(
            "/** @pureOrBreakMyCode @type {{!Widget$${ordinal}}} */\nconst built$${ordinal}"
        )),
        "{transformed}"
    );
    assert_eq!(
        transformed.matches("@pureOrBreakMyCode").count(),
        1,
        "{transformed}"
    );
}

#[test]
fn pure_annotation_is_unaffected_when_no_typed_annotation_matches() {
    let fixture = make_typed_fixture("typed-pure-only", &[("plain", "/** @type {number} */\n")]);
    let ordinal = fixture.ordinal;
    let transformed = emit_typed(&fixture);

    assert!(
        transformed.contains(&format!(
            "{}const built$${ordinal}",
            super::pure_calls::PURE_JSDOC
        )),
        "{transformed}"
    );
    assert!(
        transformed.contains(&format!("/** @type {{number}} */\nconst plain$${ordinal}")),
        "{transformed}"
    );
}

#[test]
fn hoisted_emission_without_typed_annotations_is_unchanged() {
    let annotated = emit_typed(&make_typed_fixture(
        "typed-none-a",
        &[("Widget", "/** @constructor */\n")],
    ));
    let bare = emit_typed(&make_typed_fixture("typed-none-b", &[]));

    assert!(!bare.contains("@constructor"), "{bare}");
    assert_eq!(
        bare,
        annotated.replace("/** @constructor */\n", ""),
        "annotations must be the only difference"
    );
}

#[test]
fn typed_annotations_never_match_a_multi_declarator_statement() {
    // JSDoc attaches to the whole statement, so annotating one name in
    // `var a = 1, b = 2` would silently claim the other declarator too.
    let source = "var size = 1, other = 2;\n";
    let module = parse_module(std::path::Path::new("fixture.js"), source).expect("module");
    let super::ModuleItem::Stmt(statement) = &module.body[0] else {
        panic!("expected statement");
    };
    let annotations = HashMap::from([(
        "size".to_string(),
        super::typed_annotations::TypedBindingAnnotation {
            jsdoc: "/** @type {number} */\n".to_string(),
            members: HashMap::new(),
        },
    )]);

    assert!(super::typed_annotations::typed_annotation_for_statement(
        statement,
        &annotations,
        |_| None
    )
    .is_none());
}

#[test]
fn pure_tag_stays_in_sync_with_the_standalone_pure_block() {
    assert!(super::pure_calls::PURE_JSDOC.contains(super::typed_annotations::PURE_TAG));
}

// --- typed annotations v2: members and cross-module type names -----------

fn typed_annotation(
    jsdoc: &str,
    members: &[(&str, &str)],
) -> super::typed_annotations::TypedBindingAnnotation {
    super::typed_annotations::TypedBindingAnnotation {
        jsdoc: jsdoc.to_string(),
        members: members
            .iter()
            .map(|(name, jsdoc)| (name.to_string(), jsdoc.to_string()))
            .collect(),
    }
}

#[test]
fn member_annotations_land_on_declared_fields_and_constructor_assignments() {
    // `size` is constructor-assigned (the shape esbuild leaves for a bare
    // `size: number` declaration), `unit` is a class field.
    let mut fixture = make_typed_fixture_from(
        "typed-members",
        concat!(
            "export class Widget {\n",
            "  unit = 'px';\n",
            "  ['computed'] = 0;\n",
            "  handler = function() {\n",
            "    this.size = 'not-a-number';\n",
            "  };\n",
            "  constructor() {\n",
            "    this.size = 1;\n",
            "  }\n",
            "  measure(other) {\n",
            "    const size = other;\n",
            "    return size;\n",
            "  }\n",
            "}\n",
            "console.log(new Widget());\n",
        ),
        &[],
    );
    fixture.context.typed_annotations.insert(
        super::typed_annotations::annotation_key(&fixture.file_path),
        HashMap::from([(
            "Widget".to_string(),
            typed_annotation(
                "",
                &[
                    ("size", "/** @type {number} */\n"),
                    ("unit", "/** @type {string} */\n"),
                    ("computed", "/** @type {number} */\n"),
                ],
            ),
        )]),
    );
    let transformed = emit_typed(&fixture);

    assert!(
        transformed.contains("/** @type {string} */\n    unit = 'px';"),
        "{transformed}"
    );
    assert!(
        transformed.contains("/** @type {number} */\n        this.size = 1;"),
        "{transformed}"
    );
    // Computed keys are never matched, and a local `const size` one level
    // deeper inside a method must not be mistaken for the field.
    assert!(
        !transformed.contains("*/\n    ['computed']"),
        "{transformed}"
    );
    // `this.size` inside a non-arrow function field is a different `this`;
    // annotating it would be a lie, and it is one indent step deep like a
    // real constructor assignment, so only the constructor body counts.
    assert_eq!(
        transformed.matches("@type {number}").count(),
        1,
        "{transformed}"
    );
    assert!(
        !transformed.contains("*/\n        this.size = 'not-a-number'"),
        "{transformed}"
    );
    // A class takes no JSDoc of its own, so an empty binding block must not
    // emit a stray comment before the declaration.
    assert!(!transformed.contains("*/\nclass Widget$$"), "{transformed}");
}

/// origin declares a class, main imports it and is annotated with it. Both
/// live in one chunk, so the import resolves to a direct binding.
fn make_cross_module_typed_fixture(
    label: &str,
    annotations: HashMap<String, super::typed_annotations::TypedBindingAnnotation>,
) -> (super::TranspileContext, PathBuf, usize) {
    make_cross_module_typed_fixture_with(label, annotations, false)
}

/// `veto_origin_hoist` gives origin closure-ir enum metadata, which is the
/// hoist veto in `hoist.rs`: origin then stays a registry module and main's
/// import degrades from a direct binding to a slot access.
fn make_cross_module_typed_fixture_with(
    label: &str,
    annotations: HashMap<String, super::typed_annotations::TypedBindingAnnotation>,
    veto_origin_hoist: bool,
) -> (super::TranspileContext, PathBuf, usize) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();
    let origin = src_dir.join("origin.ts");
    let main = src_dir.join("main.ts");
    fs::write(
        &origin,
        "export class Money { constructor() { this.minor = 0; } }\n",
    )
    .unwrap();
    fs::write(
        &main,
        concat!(
            "import { Money as Cash } from './origin';\n",
            "export function total(cash) { return cash.minor; }\n",
            "console.log(total(new Cash()));\n",
        ),
    )
    .unwrap();

    let file_names = vec![
        origin.to_string_lossy().to_string(),
        main.to_string_lossy().to_string(),
    ];
    let chunk_graph = vec![super::TranspileChunkInput {
        files: vec!["src/origin.ts".to_string(), "src/main.ts".to_string()],
        name: "main".to_string(),
    }];
    let mut file_metadata = HashMap::new();
    if veto_origin_hoist {
        file_metadata.insert(
            origin.to_string_lossy().to_string(),
            crate::closure_metadata::ClosureFileMetadata {
                decorated_output_text: None,
                enum_declarations: vec![crate::closure_metadata::ClosureEnumDeclaration {
                    exported: true,
                    members: Vec::new(),
                    name: "Kind".to_string(),
                    value_type: "number".to_string(),
                }],
                file_path: origin.to_string_lossy().to_string(),
                top_level_docs: Vec::new(),
                type_declarations: Vec::new(),
            },
        );
    }
    let plan = std::sync::Arc::new(
        super::build_hoist_plan(&file_names, &root, &[], &chunk_graph, &[], &file_metadata)
            .unwrap()
            .expect("hoist plan"),
    );
    let origin_module_id = to_goog_module_id(&origin, &root);
    let origin_ordinal = plan.ordinal_of(&origin_module_id).expect("ordinal");

    let slots = HashMap::from([
        (
            origin_module_id,
            super::BundlerModuleSlots::from_export_names(&BTreeSet::from(["Money".to_string()])),
        ),
        (
            to_goog_module_id(&main, &root),
            super::BundlerModuleSlots::from_export_names(&BTreeSet::from(["total".to_string()])),
        ),
    ]);
    let mut context = super::TranspileContext {
        bundler_module_slots: slots,
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::BundlerRuntime,
        class_map_calls: Vec::new(),
        pure_callees: HashSet::new(),
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        hoist_plan: Some(plan),
        preserved_property_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        lazy_target_module_ids: HashSet::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        typed_annotations: HashMap::new(),
        vendor_module_ids: HashSet::new(),
        workspace_dir: root.clone(),
    };
    context
        .typed_annotations
        .insert(super::typed_annotations::annotation_key(&main), annotations);
    (context, main, origin_ordinal)
}

#[test]
fn imported_class_type_reference_rewrites_to_the_origin_suffixed_name() {
    // The checker names the type by the LOCAL binding as written (`Cash`);
    // native must route it through the same import rewrite the code takes.
    let (context, main, origin_ordinal) = make_cross_module_typed_fixture(
        "typed-cross-ok",
        HashMap::from([(
            "total".to_string(),
            typed_annotation("/** @param {!Cash} cash @return {number} */\n", &[]),
        )]),
    );
    let transformed = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();

    assert!(
        transformed.contains(&format!("@param {{!Money$${origin_ordinal}}} cash")),
        "{transformed}"
    );
    assert!(transformed.contains("@return {number}"), "{transformed}");
}

#[test]
fn unresolvable_type_reference_drops_the_block_without_failing_the_build() {
    // `Ghost` is neither a binding of this module nor a direct-binding
    // import, so the block cannot be made to name a real declaration.
    let (context, main, _) = make_cross_module_typed_fixture(
        "typed-cross-drop",
        HashMap::from([(
            "total".to_string(),
            typed_annotation("/** @param {!Ghost} cash @return {number} */\n", &[]),
        )]),
    );
    let transformed = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();

    assert!(!transformed.contains("@param"), "{transformed}");
    assert!(!transformed.contains("Ghost"), "{transformed}");
    // The declaration itself still emits: dropping an annotation must never
    // drop code.
    assert!(transformed.contains("function total$$"), "{transformed}");
}

#[test]
fn member_annotation_with_an_unresolvable_type_is_dropped_on_its_own() {
    let (context, main, _) = make_cross_module_typed_fixture(
        "typed-member-drop",
        HashMap::from([(
            "total".to_string(),
            typed_annotation(
                "/** @param {number} cash @return {number} */\n",
                &[("minor", "/** @type {!Ghost} */\n")],
            ),
        )]),
    );
    let transformed = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();

    assert!(!transformed.contains("Ghost"), "{transformed}");
    // The sibling block on the same binding survives.
    assert!(
        transformed.contains("@param {number} cash"),
        "{transformed}"
    );
}

#[test]
fn type_name_rewriting_keeps_primitives_and_reports_unresolvable_names() {
    let names = HashMap::from([("Foo".to_string(), "Foo$$3".to_string())]);

    assert_eq!(
        super::typed_annotations::rewrite_type_names(
            "/** @param {!Foo} a @param {number} b @return {void} */\n",
            &names,
        )
        .as_deref(),
        Some("/** @param {!Foo$$3} a @param {number} b @return {void} */\n"),
    );
    assert_eq!(
        super::typed_annotations::rewrite_type_names("/** @type {!Bar} */\n", &names),
        None,
    );
    // No type expression at all: nothing to resolve, nothing to drop.
    assert_eq!(
        super::typed_annotations::rewrite_type_names("/** @pureOrBreakMyCode */\n", &names)
            .as_deref(),
        Some("/** @pureOrBreakMyCode */\n"),
    );
}

#[test]
fn registry_slot_imports_are_not_expressible_as_type_names() {
    // A slot import rewrites to `__gcc_req_0[0]`, which is an expression, not
    // a type name. It must not be spliced into the block; the block goes.
    let (context, main, _) = make_cross_module_typed_fixture_with(
        "typed-slot-drop",
        HashMap::from([(
            "total".to_string(),
            typed_annotation("/** @param {!Cash} cash @return {number} */\n", &[]),
        )]),
        true,
    );
    let transformed = GLOBALS
        .set(&Globals::new(), || transform_source_file(&main, &context))
        .unwrap();

    assert!(transformed.contains("__require("), "{transformed}");
    assert!(!transformed.contains("@param"), "{transformed}");
    assert!(!transformed.contains("Cash"), "{transformed}");
    assert!(transformed.contains("function total$$"), "{transformed}");
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
    use super::typed_annotations::{compose_annotations, PURE_TAG};

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
