use super::{
    apply_js_compat_text_fixes, collect_commonjs_extern_names, collect_enum_extern_names,
    collect_protocol_extern_names, collect_static_property_names_from_text, print_program,
    render_externs, render_generated_externs, transform_js_pass_through_module, transform_program,
    transform_source_file, StaticPropertyNameCollector,
};
use crate::module_cache::parse_module;
use crate::pathing::to_goog_module_id;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use swc_core::common::{Globals, GLOBALS};
use swc_core::ecma::visit::VisitWith;

fn empty_context() -> super::TranspileContext {
    super::TranspileContext {
        bundler_module_slots: HashMap::new(),
        bundler_runtime_logical_ids: HashMap::new(),
        chunk_mode: super::ChunkMode::Off,
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        global_property_names: HashSet::new(),
        instance_method_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
        package_aliases: Vec::new(),
        static_property_names: HashSet::new(),
        workspace_dir: PathBuf::from("/tmp"),
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
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-compat-{unique}.js"));
    let source_text = "/** @nocollapse */\nconst JSCompiler_renameProperty=(prop,_obj)=>prop;\n";
    fs::write(&file_path, source_text).unwrap();

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &file_path,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::new(),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::Off,
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
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
                    static_property_names: HashSet::new(),
                    workspace_dir: file_path
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_path_buf(),
                },
            )
        })
        .unwrap();

    assert!(output.contains("goog.module("), "{output}");
    assert!(output.contains("JSCompiler_renameProperty"), "{output}");
}

#[test]
fn adds_generic_static_property_fallbacks() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-{unique}.js"));
    let source_text = "class Demo {}\nDemo.enabledWarnings = [\"x\"];\nfunction run(){ return this.constructor.enabledWarnings.includes(\"x\"); }\n";
    fs::write(&file_path, source_text).unwrap();

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &file_path,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::new(),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::Off,
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
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
                    static_property_names: HashSet::new(),
                    workspace_dir: file_path
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_path_buf(),
                },
            )
        })
        .unwrap();

    assert!(
        output.contains("this.constructor[\"enabledWarnings\"].includes(\"x\")"),
        "{output}"
    );
}

#[test]
fn rewrites_global_alias_property_accesses_in_js_pass_through() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-alias-{unique}.js"));
    let source_text = "const global = globalThis;\nglobal.sharedRegistry ??= new WeakMap();\nconst item = sharedRegistry.get(meta);\n";
    fs::write(&file_path, source_text).unwrap();

    let output = GLOBALS
        .set(&Globals::new(), || {
            transform_source_file(
                &file_path,
                &super::TranspileContext {
                    bundler_module_slots: HashMap::new(),
                    bundler_runtime_logical_ids: HashMap::new(),
                    chunk_mode: super::ChunkMode::Off,
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
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
                    static_property_names: HashSet::new(),
                    workspace_dir: file_path
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_path_buf(),
                },
            )
        })
        .unwrap();

    assert!(
        output.contains("globalThis.sharedRegistry.get(meta)"),
        "{output}"
    );
}

#[test]
fn preserves_class_static_property_names_via_bracket_access() {
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

    assert!(output.contains("Demo[\"styles\"] = theme;"), "{output}");
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
        transformed.contains("/** @nocollapse */\nDemo[\"styles\"] = theme;"),
        "{transformed}"
    );
}

#[test]
fn generated_externs_include_global_and_static_protocols() {
    let externs = render_generated_externs(
        &HashSet::from([
            "sharedRegistry".to_string(),
            "reactiveElementVersions".to_string(),
        ]),
        &HashSet::from(["finalize".to_string(), "elementProperties".to_string()]),
    );

    assert!(
        externs.contains("Window.prototype.sharedRegistry;"),
        "{externs}"
    );
    assert!(
        externs.contains("Window.prototype.reactiveElementVersions;"),
        "{externs}"
    );
    assert!(
        externs.contains("Function.prototype.finalize;"),
        "{externs}"
    );
    assert!(
        externs.contains("Function.prototype.elementProperties;"),
        "{externs}"
    );
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
            commonjs_specifiers: HashSet::from(["demo-pkg".to_string()]),
            file_metadata: HashMap::new(),
            global_property_names: HashSet::new(),
            instance_method_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            package_aliases: Vec::new(),
            static_property_names: HashSet::new(),
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
        commonjs_specifiers: HashSet::new(),
        file_metadata: HashMap::new(),
        global_property_names: HashSet::new(),
        instance_method_names: HashSet::new(),
        lazy_imports_by_file: HashMap::new(),
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
fn collects_static_property_names_from_assignments_and_fields() {
    let names = collect_static_property_names_from_text(
            "class Demo { static styles = theme; }\nlet Other = class Other {};\nOther.shadowRootOptions = {};\n",
        );

    assert!(names.contains("styles"));
    assert!(names.contains("shadowRootOptions"));
}

#[test]
fn collects_static_property_names_from_static_method_this_access() {
    let module = parse_module(
            std::path::Path::new("fixture.js"),
            "class Demo { static finalize() { this.__attributeToPropertyMap = new Map(); this.elementProperties.set('x', 1); } }",
        )
        .expect("module");
    let mut collector = StaticPropertyNameCollector::default();
    module.visit_with(&mut collector);

    assert!(collector.names.contains("__attributeToPropertyMap"));
    assert!(collector.names.contains("elementProperties"));
}

#[test]
fn preserves_constant_like_object_keys_and_member_reads() {
    let source = "const PartType = { ATTRIBUTE: 1, CHILD: 2, ELEMENT: 6 };\nconst alias = PartType;\nexport const value = alias.CHILD + PartType.ELEMENT;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(
        transformed.contains("\"ATTRIBUTE\": 1") || transformed.contains("\"ATTRIBUTE\":1"),
        "{transformed}"
    );
    assert!(transformed.contains("alias[\"CHILD\"]"), "{transformed}");
    assert!(
        transformed.contains("PartType[\"ELEMENT\"]"),
        "{transformed}"
    );
}

#[test]
fn preserves_internal_protocol_class_methods_and_calls() {
    let source =
            "class Demo { constructor(){ this.__initialize(); this._$changeProperty(); this.$createRenderRoot$(); } __initialize(){ this.__save(); } __save(){} _$changeProperty(){} $createRenderRoot$(){} }\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &empty_context(),
    )
    .expect("transform");

    assert!(
        transformed.contains("this[\"__initialize\"]()"),
        "{transformed}"
    );
    assert!(transformed.contains("\"__initialize\"()"), "{transformed}");
    assert!(transformed.contains("this[\"__save\"]()"), "{transformed}");
    assert!(transformed.contains("\"__save\"()"), "{transformed}");
    assert!(
        transformed.contains("this[\"_$changeProperty\"]()"),
        "{transformed}"
    );
    assert!(
        transformed.contains("\"_$changeProperty\"()"),
        "{transformed}"
    );
    assert!(
        transformed.contains("this[\"$createRenderRoot$\"]()"),
        "{transformed}"
    );
    assert!(
        transformed.contains("\"$createRenderRoot$\"()"),
        "{transformed}"
    );
}

#[test]
fn rewrites_collected_global_property_reads_to_bracket_access() {
    let source = "const root = globalThis;\nroot.sharedRegistry = root.sharedRegistry || new WeakMap();\nexport const value = sharedRegistry.get(meta) ?? globalThis.sharedRegistry ?? root.sharedRegistry;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            commonjs_specifiers: HashSet::new(),
            file_metadata: HashMap::new(),
            global_property_names: HashSet::from(["sharedRegistry".to_string()]),
            instance_method_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            package_aliases: vec![],
            static_property_names: HashSet::new(),
            workspace_dir: PathBuf::from("/tmp"),
        },
    )
    .expect("transform");

    assert!(
        transformed.contains("root[\"sharedRegistry\"]"),
        "{transformed}"
    );
    assert!(
        transformed.contains("globalThis[\"sharedRegistry\"].get(meta)"),
        "{transformed}"
    );
    assert!(
        transformed.contains("globalThis[\"sharedRegistry\"]"),
        "{transformed}"
    );
}

#[test]
fn rewrites_collected_static_property_reads_to_bracket_access() {
    let source = "class Base { static finalize(ctor) { return ctor.styles && ctor.elementStyles; } }\nclass Demo extends Base {}\nDemo.styles = theme;\n";
    let transformed = transform_js_pass_through_module(
        parse_module(std::path::Path::new("fixture.js"), source).expect("module"),
        source.to_string(),
        std::path::Path::new("fixture.js"),
        &super::TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: super::ChunkMode::Off,
            commonjs_specifiers: HashSet::new(),
            file_metadata: HashMap::new(),
            global_property_names: HashSet::new(),
            instance_method_names: HashSet::new(),
            lazy_imports_by_file: HashMap::new(),
            package_aliases: vec![],
            static_property_names: HashSet::from([
                "styles".to_string(),
                "elementStyles".to_string(),
            ]),
            workspace_dir: PathBuf::from("/tmp"),
        },
    )
    .expect("transform");

    assert!(transformed.contains("ctor[\"styles\"]"), "{transformed}");
    assert!(
        transformed.contains("ctor[\"elementStyles\"]"),
        "{transformed}"
    );
    assert!(
        transformed.contains("Demo[\"styles\"] = theme;"),
        "{transformed}"
    );
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
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(transformed.contains("feature[1]()"), "{transformed}");
    assert!(!transformed.contains("renderMessage"), "{transformed}");
    assert!(transformed.contains("__exports[0]"), "{transformed}");
    assert!(
        !transformed.contains("__exports[\"default\"]"),
        "{transformed}"
    );
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
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
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
                    commonjs_specifiers: HashSet::new(),
                    file_metadata: HashMap::new(),
                    global_property_names: HashSet::new(),
                    instance_method_names: HashSet::new(),
                    lazy_imports_by_file: HashMap::new(),
                    package_aliases: Vec::new(),
                    static_property_names: HashSet::new(),
                    workspace_dir: root.clone(),
                },
            )
        })
        .unwrap();

    assert!(transformed.contains("module[0](anchor)"), "{transformed}");
    assert!(!transformed.contains(".default"), "{transformed}");
}
