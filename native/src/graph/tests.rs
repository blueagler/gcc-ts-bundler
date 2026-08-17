use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("gcc-ts-bundler-native-{unique}-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn join(&self, relative: &str) -> PathBuf {
        self.path.join(relative)
    }

    fn write(&self, relative: &str, contents: &str) {
        let file_path = self.join(relative);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(file_path, contents).unwrap();
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn top_level_await_classifies_preserved_modules_without_nested_false_positives() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.js",
        "import { value } from './tla.js'; import { sum } from './for-await.js'; import { nested } from './nested.js'; import { nestedForAwait } from './nested-for-await.js'; import { usingValue } from './await-using.js'; import { nestedUsing } from './nested-await-using.js'; console.log(value, sum, nested, nestedForAwait, usingValue, nestedUsing);",
    );
    temp_dir.write(
        "src/tla.js",
        "export const value = await Promise.resolve(1); export default value;",
    );
    temp_dir.write(
        "src/for-await.js",
        "let sum = 0; try { if (true) { for await (const value of [Promise.resolve(2)]) { sum += value; } } } finally {} export { sum };",
    );
    temp_dir.write(
        "src/nested.js",
        "export async function nested() { return await Promise.resolve(2); }",
    );
    temp_dir.write(
        "src/nested-for-await.js",
        "export async function nestedForAwait() { for await (const value of [Promise.resolve(3)]) { return value; } }",
    );
    temp_dir.write(
        "src/await-using.js",
        "await using resource = null; export const usingValue = resource;",
    );
    temp_dir.write(
        "src/nested-await-using.js",
        "export async function nestedUsing() { await using resource = null; return resource; }",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert_eq!(result.preservedModules.len(), 3);
    let preserved = result
        .preservedModules
        .iter()
        .find(|entry| entry.filePath.ends_with("src/tla.js"))
        .unwrap();
    assert_eq!(preserved.exportNames, vec!["value"]);
    assert!(preserved.hasDefaultExport);
    assert!(result
        .preservedModules
        .iter()
        .any(|entry| entry.filePath.ends_with("src/for-await.js")));
    assert!(result
        .preservedModules
        .iter()
        .any(|entry| entry.filePath.ends_with("src/await-using.js")));
    for compiled_path in [
        "src/nested.js",
        "src/nested-for-await.js",
        "src/nested-await-using.js",
    ] {
        assert!(result
            .graph
            .iter()
            .any(|entry| entry.filePath.ends_with(compiled_path)),);
        assert!(!result
            .preservedModules
            .iter()
            .any(|entry| entry.filePath.ends_with(compiled_path)),);
    }
}

#[test]
fn preserved_compiled_cycles_fail_closed() {
    let temp_dir = TestDir::new();
    temp_dir.write("src/index.js", "import './a.js';");
    temp_dir.write(
        "src/a.js",
        "import { b } from './b.js'; export const a = await Promise.resolve(b);",
    );
    temp_dir.write(
        "src/b.js",
        "import { a } from './a.js'; export const b = a ?? 1;",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap_err();

    assert!(error.contains("Preserved/compiled module cycle is unsupported in phase 1"));
    assert!(error.contains("a.js"));
    assert!(error.contains("b.js"));
}

#[test]
fn resolves_package_root_from_exports_browser_condition() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}"#,
    );
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");
    temp_dir.write("node_modules/demo-pkg/import.js", "export default 2;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
}

#[test]
fn prefers_production_exports_in_release_mode() {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js",
                    "production": "./prod.js",
                    "default": "./default.js"
                }
            }"#,
    )
    .unwrap();

    let resolved = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();

    assert_eq!(resolved.as_deref(), Some("./prod.js"));
}

#[test]
fn prefers_development_exports_in_debug_mode() {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js",
                    "production": "./prod.js",
                    "default": "./default.js"
                }
            }"#,
    )
    .unwrap();

    let resolved = select_package_export_target(&exports, ".", "demo-pkg", true).unwrap();

    assert_eq!(resolved.as_deref(), Some("./dev.js"));
}

#[test]
fn release_conditions_fall_through_to_a_sibling_key_when_the_matched_subtree_is_debug_only() {
    // The matched `browser` key holds a subtree that only answers to
    // `development`. Under release conditions that subtree resolves to nothing,
    // and the walk has to continue to the sibling `default` key. Ending the walk
    // at `browser` instead made every non-debug pass return nothing, so the
    // release `.or()` chain fell through to the development pass and a release
    // build resolved `./dev.js`.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js"
                },
                "default": "./def.js"
            }"#,
    )
    .unwrap();

    let release = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();
    let debug = select_package_export_target(&exports, ".", "demo-pkg", true).unwrap();

    assert_eq!(
        release.as_deref(),
        Some("./def.js"),
        "release must not ship debug code"
    );
    assert_eq!(
        debug.as_deref(),
        Some("./dev.js"),
        "debug still prefers the debug subtree"
    );
}

#[test]
fn a_matched_subtree_with_no_resolvable_condition_and_no_sibling_fails_closed() {
    // Same shape with the sibling removed, and with a condition no pass knows.
    // Falling through has to run out of keys and report "no target" rather than
    // invent one.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "react-native": "./rn.js"
                }
            }"#,
    )
    .unwrap();

    for prefer_debug in [false, true] {
        let resolved =
            select_package_export_target(&exports, ".", "demo-pkg", prefer_debug).unwrap();
        assert_eq!(
            resolved, None,
            "exhausting the sibling keys must fail closed"
        );
    }
}

#[test]
fn a_package_offering_only_a_development_build_still_resolves_in_release() {
    // The deliberate other half of the policy, pinned so the fall-through fix
    // above cannot be mistaken for it. `select_package_export_target` chains
    // production -> default -> development for release, so a package whose only
    // build answers `development` still resolves rather than failing the build.
    // That last-resort chain is exactly why the missing sibling fall-through was
    // invisible: it silently absorbed the `None` that should have gone to a
    // sibling key.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js"
                }
            }"#,
    )
    .unwrap();

    let release = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();

    assert_eq!(release.as_deref(), Some("./dev.js"));
}

#[test]
fn sibling_fall_through_works_at_every_nesting_depth() {
    // The fall-through is not a top-level special case. Here the *inner*
    // `browser` object is the one that has to recover: its `import` key matches,
    // its subtree answers only `development`, and the walk must continue to the
    // inner `default` sibling. `import` is deliberately a key the release
    // condition list contains - a key it does not contain is skipped rather than
    // matched, and would not exercise this path at all.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "import": {
                        "development": "./dev.js"
                    },
                    "default": "./browser-default.js"
                },
                "default": "./def.js"
            }"#,
    )
    .unwrap();

    let release = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();

    assert_eq!(
        release.as_deref(),
        Some("./browser-default.js"),
        "release must recover inside the nested object, not fall through to the debug pass"
    );
}

#[test]
fn a_false_target_stays_a_hard_error_even_when_a_sibling_key_would_resolve() {
    // The fall-through must not turn a disabled export into a silent fallback.
    // `"browser": false` means the package refuses browser bundling; resolving
    // the sibling `default` here would serve its Node build to a browser bundle,
    // which is the whole failure this error exists to prevent.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": false,
                "default": "./node.js"
            }"#,
    )
    .unwrap();

    for prefer_debug in [false, true] {
        let error = select_package_export_target(&exports, ".", "demo-pkg", prefer_debug)
            .expect_err("a disabled browser export must stay an error");
        assert!(error.contains("disables this export"), "{error}");
    }
}

#[test]
fn a_null_target_stays_a_hard_error_even_when_a_sibling_key_would_resolve() {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": null,
                "default": "./node.js"
            }"#,
    )
    .unwrap();

    let error = select_package_export_target(&exports, ".", "demo-pkg", false)
        .expect_err("a null target must stay an error");
    assert!(error.contains("disables this export"), "{error}");
}

#[test]
fn condition_walk_order_follows_our_ranking_not_the_json_key_order() {
    // Walk-order pin. Node iterates the object's keys in insertion order, so it
    // would answer `./default.js` here. We iterate our own condition ranking
    // instead, because that ranking *is* the release/debug policy: release must
    // prefer `production` however the package happened to order its map.
    //
    // If a future change adopts Node's key order, this test fails and the
    // policy change becomes a deliberate decision instead of a silent one.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "default": "./default.js",
                "production": "./prod.js",
                "development": "./dev.js"
            }"#,
    )
    .unwrap();

    let release = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();
    let debug = select_package_export_target(&exports, ".", "demo-pkg", true).unwrap();

    assert_eq!(
        release.as_deref(),
        Some("./prod.js"),
        "release ranks production first"
    );
    assert_eq!(
        debug.as_deref(),
        Some("./dev.js"),
        "debug ranks development first"
    );
}

#[test]
fn browser_outranks_a_sibling_import_key_that_also_resolves() {
    // The other half of the walk-order pin: `browser` is first in every
    // condition list, so a resolvable `browser` subtree wins over a resolvable
    // `import` sibling. Only an *unresolvable* match falls through.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "import": "./import.js",
                "browser": "./browser.js"
            }"#,
    )
    .unwrap();

    let release = select_package_export_target(&exports, ".", "demo-pkg", false).unwrap();

    assert_eq!(release.as_deref(), Some("./browser.js"));
}

#[test]
fn resolves_package_subpath_from_exports_pattern() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import feature from \"demo-pkg/features/button\";\nexport default feature;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","exports":{"./features/*":{"browser":"./dist/features/*.js"}}}"#,
    );
    temp_dir.write(
        "node_modules/demo-pkg/dist/features/button.js",
        "export default 1;\n",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/dist/features/button.js")));
}

#[test]
fn falls_back_to_browser_then_module_then_main() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
            "node_modules/demo-pkg/package.json",
            r#"{"name":"demo-pkg","browser":"./browser.js","module":"./module.js","main":"./main.cjs"}"#,
        );
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");
    temp_dir.write("node_modules/demo-pkg/module.js", "export default 2;\n");
    temp_dir.write("node_modules/demo-pkg/main.cjs", "module.exports = 3;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
}

#[test]
fn applies_browser_object_mapping_to_package_main() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./node.js","browser":{"./node.js":"./browser.js"}}"#,
    );
    temp_dir.write(
        "node_modules/demo-pkg/node.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    );
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    assert!(!result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/node.js")));
}

#[test]
fn applies_browser_object_mapping_to_package_module() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"./node.js","main":"./fallback.js","browser":{"./node.js":"./browser.js"}}"#,
    );
    temp_dir.write(
        "node_modules/demo-pkg/node.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    );
    temp_dir.write("node_modules/demo-pkg/fallback.js", "export default 2;\n");
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    assert!(!result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/fallback.js")));
}

#[test]
fn applies_browser_object_mapping_to_relative_package_imports() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./index.js","browser":{"./feature.js":"./feature-browser.js"}}"#,
    );
    temp_dir.write(
        "node_modules/demo-pkg/index.js",
        "import feature from \"./feature\";\nexport default feature;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/feature.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/feature-browser.js",
        "export default 1;\n",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/feature-browser.js")));
    assert!(!result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/feature.js")));
    let resolved = result
        .resolvedImports
        .iter()
        .find(|entry| {
            entry
                .importerFilePath
                .ends_with("node_modules/demo-pkg/index.js")
                && entry.specifier == "./feature"
        })
        .expect("resolved relative import");
    assert!(resolved
        .targetPath
        .ends_with("node_modules/demo-pkg/feature-browser.js"));
    assert_eq!(
        resolved.moduleId,
        to_goog_module_id(
            &temp_dir.join("node_modules/demo-pkg/feature-browser.js"),
            &temp_dir.path,
        )
    );
}

#[test]
fn dynamic_import_templates_use_cooked_specifiers_in_graph_resolution() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        r#"globalThis.load = () => import(`./\u0066eature.js`);"#,
    );
    temp_dir.write("src/feature.js", "export const value = 1;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert_eq!(result.lazyImports.len(), 1);
    assert_eq!(result.lazyImports[0].specifier, "./feature.js");
    assert!(result.lazyImports[0].targetPath.ends_with("src/feature.js"));
}

#[test]
fn resolves_package_relative_module_field_without_dot_prefix() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"es/index.js","main":"lib/index.js"}"#,
    );
    temp_dir.write("node_modules/demo-pkg/es/index.js", "export default 1;\n");
    temp_dir.write(
        "node_modules/demo-pkg/lib/index.js",
        "module.exports = 2;\n",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/es/index.js")));
}

#[test]
fn tracks_package_json_hash_changes() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"./index.js"}"#,
    );
    temp_dir.write("node_modules/demo-pkg/index.js", "export default 1;\n");

    let first = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"./index.js","version":"2.0.0"}"#,
    );
    let second = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    let first_hash = first
        .fileHashes
        .iter()
        .find(|entry| entry.filePath == "node_modules/demo-pkg/package.json")
        .unwrap()
        .hash
        .clone();
    let second_hash = second
        .fileHashes
        .iter()
        .find(|entry| entry.filePath == "node_modules/demo-pkg/package.json")
        .unwrap()
        .hash
        .clone();

    assert_ne!(first_hash, second_hash);
}

#[test]
fn resolves_commonjs_package_below_source_root() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "src/node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./index.js"}"#,
    );
    temp_dir.write(
        "src/node_modules/demo-pkg/index.js",
        "module.exports = 1;\n",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("src/node_modules/demo-pkg/index.js")));
}

#[test]
fn rejects_unsupported_commonjs_package_patterns() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./index.cjs"}"#,
    );
    temp_dir.write(
        "node_modules/demo-pkg/index.cjs",
        "module.exports = require(name);\n",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap_err();

    assert!(error.contains("Unsupported CommonJS"));
}

#[test]
fn rejects_node_builtin_imports() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/index.ts",
        "import { join } from \"node:path\";\nexport default join;\n",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap_err();

    assert!(error.contains("Node builtin"));
}

#[test]
fn target_matrix_selects_conditional_exports_and_external_boundaries() {
    let temp_dir = TestDir::new();
    temp_dir.write(
        "src/conditions.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    );
    temp_dir.write(
        "src/node-boundaries.ts",
        "import nodeFs from \"node:fs\";\nimport barePath from \"path\";\nexport default [nodeFs, barePath];\n",
    );
    temp_dir.write(
        "src/bun-boundaries.ts",
        "import nodeFs from \"node:fs\";\nimport barePath from \"path\";\nimport bunTest from \"bun:test\";\nexport default [nodeFs, barePath, bunTest];\n",
    );
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","exports":{"browser":"./browser.js","node":"./node.js","bun":"./bun.js","workerd":"./workerd.js","import":"./import.js","require":"./require.js","default":"./default.js"}}"#,
    );
    for (name, value) in [
        ("browser", "browser"),
        ("node", "node"),
        ("bun", "bun"),
        ("workerd", "workerd"),
        ("import", "import"),
        ("require", "require"),
        ("default", "default"),
    ] {
        temp_dir.write(
            &format!("node_modules/demo-pkg/{name}.js"),
            &format!("export default {value:?};\n"),
        );
    }

    for (target, expected) in [
        ("bun", "bun.js"),
        ("node", "node.js"),
        ("workerd", "workerd.js"),
    ] {
        let result = resolve_graph(
            vec![temp_dir
                .join("src/conditions.ts")
                .to_string_lossy()
                .to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            format!("esm-only:{target}"),
        )
        .unwrap();
        assert!(
            result
                .sourceFiles
                .iter()
                .any(|path| path.ends_with(expected)),
            "{target} did not select {expected}"
        );
    }

    for (target, entry, expected_boundaries) in [
        ("node", "src/node-boundaries.ts", vec!["node:fs", "path"]),
        (
            "bun",
            "src/bun-boundaries.ts",
            vec!["bun:test", "node:fs", "path"],
        ),
    ] {
        let result = resolve_graph(
            vec![temp_dir.join(entry).to_string_lossy().to_string()],
            temp_dir.join("src").to_string_lossy().to_string(),
            temp_dir.path.to_string_lossy().to_string(),
            format!("esm-only:{target}"),
        )
        .unwrap();
        assert_eq!(
            result
                .externalBoundaries
                .iter()
                .map(|item| item.specifier.as_str())
                .collect::<Vec<_>>(),
            expected_boundaries
        );
    }
}

#[test]
fn resolves_js_specifier_to_ts_source() {
    let temp_dir = TestDir::new();
    temp_dir.write("src/index.ts", "export { value } from \"./support.js\";\n");
    temp_dir.write("src/support.ts", "export const value = 1;\n");

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .unwrap();

    assert!(result
        .sourceFiles
        .iter()
        .any(|path| path.ends_with("src/support.ts")));
}

#[test]
fn colliding_chunk_names_receive_deterministic_entry_identity_suffixes() {
    let base_names = vec!["index".to_string(), "index".to_string()];
    let assigned = assign_chunk_names(
        base_names.clone(),
        vec!["index.ts".to_string(), "vite/index.ts".to_string()],
    )
    .expect("colliding names should be disambiguated");
    let assigned_with_windows_separator = assign_chunk_names(
        base_names,
        vec!["index.ts".to_string(), "vite\\index.ts".to_string()],
    )
    .expect("path separators should not affect chunk identity");

    assert_eq!(assigned, assigned_with_windows_separator);
    assert_ne!(assigned[0], assigned[1]);
    assert!(assigned.iter().all(|name| name.starts_with("index-")));
}

#[test]
fn non_colliding_chunk_names_are_byte_stable() {
    let assigned = assign_chunk_names(
        vec!["main".to_string(), "panel".to_string()],
        vec!["src/main.ts".to_string(), "src/panel.ts".to_string()],
    )
    .expect("distinct names should remain valid");

    assert_eq!(assigned, vec!["main".to_string(), "panel".to_string()]);
}

#[test]
fn off_mode_chunk_plan_disambiguates_colliding_output_basenames() {
    let plan = || {
        plan_chunks(
            "off".to_string(),
            "ignored".to_string(),
            "/workspace".to_string(),
            vec![
                ChunkPlanEntryInput {
                    chunkName: "index-mjs".to_string(),
                    outputName: "index.mjs".to_string(),
                    sourcePath: "/workspace/src/index.ts".to_string(),
                },
                ChunkPlanEntryInput {
                    chunkName: "vite-index-mjs".to_string(),
                    outputName: "vite/index.mjs".to_string(),
                    sourcePath: "/workspace/src/vite/index.ts".to_string(),
                },
            ],
            vec![
                DependencyGraphEntry {
                    filePath: "/workspace/entries/index-mjs.ts".to_string(),
                    dependencies: vec!["/workspace/src/index.ts".to_string()],
                },
                DependencyGraphEntry {
                    filePath: "/workspace/entries/vite-index-mjs.ts".to_string(),
                    dependencies: vec!["/workspace/src/vite/index.ts".to_string()],
                },
                DependencyGraphEntry {
                    filePath: "/workspace/src/index.ts".to_string(),
                    dependencies: vec![],
                },
                DependencyGraphEntry {
                    filePath: "/workspace/src/vite/index.ts".to_string(),
                    dependencies: vec![],
                },
            ],
            vec![],
            vec![],
            vec![
                "/workspace/entries/index-mjs.ts".to_string(),
                "/workspace/entries/vite-index-mjs.ts".to_string(),
            ],
            false,
        )
        .expect("colliding output basenames should be planned")
    };
    let first = plan();
    let second = plan();
    let first_names = first
        .iter()
        .map(|chunk| chunk.name.clone())
        .collect::<Vec<_>>();
    let second_names = second
        .iter()
        .map(|chunk| chunk.name.clone())
        .collect::<Vec<_>>();

    assert_eq!(first_names, second_names);
    assert_eq!(first_names.len(), 2);
    assert_ne!(first_names[0], first_names[1]);
    assert!(first_names.iter().all(|name| name.starts_with("index-")));
}

#[test]
fn plans_bundler_runtime_chunks_in_native_graph_layer() {
    let result = plan_chunks(
        "bundler-runtime".to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        vec![ChunkPlanEntryInput {
            chunkName: "main".to_string(),
            outputName: "main.js".to_string(),
            sourcePath: "/workspace/src/main.ts".to_string(),
        }],
        vec![
            DependencyGraphEntry {
                filePath: "/workspace/src/main.ts".to_string(),
                dependencies: vec!["/workspace/src/shared.ts".to_string()],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/shared.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/feature.ts".to_string(),
                dependencies: vec!["/workspace/src/shared.ts".to_string()],
            },
        ],
        vec![LazyImportEntry {
            importerFilePath: "/workspace/src/main.ts".to_string(),
            moduleId: "gcc.src.feature".to_string(),
            specifier: "./feature".to_string(),
            targetPath: "/workspace/src/feature.ts".to_string(),
        }],
        vec![],
        vec![],
        false,
    )
    .unwrap();

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].name, "main");
    assert_eq!(result[0].kind.as_deref(), Some("base"));
    assert_eq!(result[1].name, "src-feature-lazy");
    assert_eq!(result[1].kind.as_deref(), Some("lazy"));
    assert_eq!(result[1].dependencies, vec!["main"]);
}

#[test]
fn plans_off_mode_chunks_in_native_graph_layer() {
    let result = plan_chunks(
        "off".to_string(),
        "ignored".to_string(),
        "/workspace".to_string(),
        vec![
            ChunkPlanEntryInput {
                chunkName: "first".to_string(),
                outputName: "first.js".to_string(),
                sourcePath: "/workspace/src/first.ts".to_string(),
            },
            ChunkPlanEntryInput {
                chunkName: "second".to_string(),
                outputName: "second.js".to_string(),
                sourcePath: "/workspace/src/second.ts".to_string(),
            },
        ],
        vec![
            DependencyGraphEntry {
                filePath: "/workspace/entries/first.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/first.ts".to_string(),
                    "/workspace/src/shared.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                filePath: "/workspace/entries/second.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/second.ts".to_string(),
                    "/workspace/src/shared.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/first.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/second.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/shared.ts".to_string(),
                dependencies: vec![],
            },
        ],
        vec![],
        vec![],
        vec![
            "/workspace/entries/first.ts".to_string(),
            "/workspace/entries/second.ts".to_string(),
        ],
        false,
    )
    .unwrap();

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].name, "shared");
    assert_eq!(result[1].name, "first");
    assert_eq!(result[1].dependencies, vec!["shared"]);
    assert_eq!(result[2].name, "second");
    assert_eq!(result[2].dependencies, vec!["shared"]);
}

// --- vendor chunk partition ---------------------------------------------

/// Entry -> two app modules and three dependency-originated ones, one per
/// vendor directory shape.
fn vendor_graph() -> (Vec<ChunkPlanEntryInput>, Vec<DependencyGraphEntry>) {
    let entries = vec![ChunkPlanEntryInput {
        chunkName: "main".to_string(),
        outputName: "main.js".to_string(),
        sourcePath: "/workspace/src/main.ts".to_string(),
    }];
    let graph = vec![
        DependencyGraphEntry {
            filePath: "/workspace/src/main.ts".to_string(),
            dependencies: vec![
                "/workspace/src/app.ts".to_string(),
                "/workspace/node_modules/lib/index.js".to_string(),
                "/workspace/.vite/__dep-bundles/dep.js".to_string(),
                "/workspace/__virtual__/style.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/app.ts".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            filePath: "/workspace/node_modules/lib/index.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            filePath: "/workspace/.vite/__dep-bundles/dep.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            filePath: "/workspace/__virtual__/style.js".to_string(),
            dependencies: vec![],
        },
    ];
    (entries, graph)
}

fn plan_vendor(vendor_chunk: bool, chunk_mode: &str) -> Vec<ChunkPlanChunkOutput> {
    let (entries, graph) = vendor_graph();
    plan_chunks(
        chunk_mode.to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        entries,
        graph,
        vec![],
        vec![],
        vec![],
        vendor_chunk,
    )
    .unwrap()
}

#[test]
fn vendor_chunk_partitions_dependency_originated_files_and_leads_the_plan() {
    let plan = plan_vendor(true, "bundler-runtime");

    assert_eq!(plan.len(), 2);
    // Vendor is first so it is also the first Closure chunk spec, which is
    // what makes base's generated import edge execute it at startup.
    assert_eq!(plan[0].name, "main-vendor");
    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert!(plan[0].dependencies.is_empty());
    assert_eq!(plan[0].entryFiles, None);
    assert_eq!(plan[0].lazyModuleIds, None);
    assert_eq!(
        plan[0].files.iter().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            &".vite/__dep-bundles/dep.js".to_string(),
            &"__virtual__/style.js".to_string(),
            &"node_modules/lib/index.js".to_string(),
        ])
    );

    assert_eq!(plan[1].name, "main");
    assert_eq!(plan[1].kind.as_deref(), Some("base"));
    assert_eq!(plan[1].dependencies, vec!["main-vendor"]);
    assert_eq!(plan[1].files, vec!["src/app.ts", "src/main.ts"]);
}

#[test]
fn vendor_chunk_excludes_virtual_modules_with_authored_dependencies() {
    let plan = plan_chunks(
        "bundler-runtime".to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        vec![ChunkPlanEntryInput {
            chunkName: "main".to_string(),
            outputName: "main.js".to_string(),
            sourcePath: "/workspace/src/main.ts".to_string(),
        }],
        vec![
            DependencyGraphEntry {
                filePath: "/workspace/src/main.ts".to_string(),
                dependencies: vec!["/workspace/__virtual__/bridge.js".to_string()],
            },
            DependencyGraphEntry {
                filePath: "/workspace/__virtual__/bridge.js".to_string(),
                dependencies: vec!["/workspace/src/value.js".to_string()],
            },
            DependencyGraphEntry {
                filePath: "/workspace/src/value.js".to_string(),
                dependencies: vec![],
            },
        ],
        vec![],
        vec![],
        vec![],
        true,
    )
    .unwrap();

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan[0].dependencies.is_empty());
    assert_eq!(
        plan[0].files,
        vec!["src/value.js", "__virtual__/bridge.js", "src/main.ts",],
    );
}

#[test]
fn vendor_chunk_never_claims_an_entry_file() {
    // A project whose entry itself sits under a vendor-looking path still
    // owns that file: it is app code by definition, and moving it would put
    // the thing every edit touches into the chunk meant to stay stable.
    let plan = plan_chunks(
        "bundler-runtime".to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        vec![ChunkPlanEntryInput {
            chunkName: "main".to_string(),
            outputName: "main.js".to_string(),
            sourcePath: "/workspace/__virtual__/entry.ts".to_string(),
        }],
        vec![
            DependencyGraphEntry {
                filePath: "/workspace/__virtual__/entry.ts".to_string(),
                dependencies: vec!["/workspace/node_modules/lib/index.js".to_string()],
            },
            DependencyGraphEntry {
                filePath: "/workspace/node_modules/lib/index.js".to_string(),
                dependencies: vec![],
            },
        ],
        vec![],
        vec![],
        vec![],
        true,
    )
    .unwrap();

    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert_eq!(plan[0].files, vec!["node_modules/lib/index.js"]);
    assert_eq!(plan[1].files, vec!["__virtual__/entry.ts"]);
}

#[test]
fn empty_vendor_partition_emits_no_vendor_chunk() {
    let plan = plan_chunks(
        "bundler-runtime".to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        vec![ChunkPlanEntryInput {
            chunkName: "main".to_string(),
            outputName: "main.js".to_string(),
            sourcePath: "/workspace/src/main.ts".to_string(),
        }],
        vec![DependencyGraphEntry {
            filePath: "/workspace/src/main.ts".to_string(),
            dependencies: vec![],
        }],
        vec![],
        vec![],
        vec![],
        true,
    )
    .unwrap();

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan[0].dependencies.is_empty());
}

#[test]
fn vendor_chunk_flag_off_leaves_the_plan_byte_identical() {
    let off = plan_vendor(false, "bundler-runtime");

    // Same shape as before the feature existed: one base chunk owning every
    // eagerly reachable file, no dependencies, no vendor kind anywhere.
    assert_eq!(off.len(), 1);
    assert_eq!(off[0].name, "main");
    assert_eq!(off[0].kind.as_deref(), Some("base"));
    assert!(off[0].dependencies.is_empty());
    assert_eq!(off[0].files.len(), 5);
    assert!(!off
        .iter()
        .any(|chunk| chunk.kind.as_deref() == Some("vendor")));

    // And the flag is inert once there is nothing to move, so the two agree
    // whenever the partition is empty.
    let plan_plain = |vendor_chunk: bool| {
        format!(
            "{:?}",
            plan_chunks(
                "bundler-runtime".to_string(),
                "main.js".to_string(),
                "/workspace".to_string(),
                vec![ChunkPlanEntryInput {
                    chunkName: "main".to_string(),
                    outputName: "main.js".to_string(),
                    sourcePath: "/workspace/src/main.ts".to_string(),
                }],
                vec![DependencyGraphEntry {
                    filePath: "/workspace/src/main.ts".to_string(),
                    dependencies: vec![],
                }],
                vec![],
                vec![],
                vec![],
                vendor_chunk
            )
            .unwrap()
        )
    };
    assert_eq!(plan_plain(false), plan_plain(true));
}

#[test]
fn split_partitions_the_vendor_chunk_exactly_like_bundler_runtime() {
    // Split used to ignore the flag because plain-script chunks have no import
    // edge to order vendor before base. It is on the shared import-edge chunk
    // graph now, so the partition must be identical to `bundler-runtime` --
    // and must still be opt-in.
    assert_eq!(
        format!("{:?}", plan_vendor(true, "split")),
        format!("{:?}", plan_vendor(true, "bundler-runtime")),
    );
    assert_eq!(
        format!("{:?}", plan_vendor(false, "split")),
        format!("{:?}", plan_vendor(false, "bundler-runtime")),
    );
    assert_ne!(
        format!("{:?}", plan_vendor(true, "split")),
        format!("{:?}", plan_vendor(false, "split")),
    );
}

#[test]
fn vendor_chunk_coexists_with_shared_and_lazy_chunks() {
    let (entries, mut graph) = vendor_graph();
    graph.push(DependencyGraphEntry {
        filePath: "/workspace/src/panel.ts".to_string(),
        dependencies: vec!["/workspace/src/panel-only.ts".to_string()],
    });
    graph.push(DependencyGraphEntry {
        filePath: "/workspace/src/panel-only.ts".to_string(),
        dependencies: vec![],
    });
    let plan = plan_chunks(
        "bundler-runtime".to_string(),
        "main.js".to_string(),
        "/workspace".to_string(),
        entries,
        graph,
        vec![LazyImportEntry {
            importerFilePath: "/workspace/src/main.ts".to_string(),
            moduleId: "gcc.src.panel".to_string(),
            specifier: "./panel".to_string(),
            targetPath: "/workspace/src/panel.ts".to_string(),
        }],
        vec![],
        vec![],
        true,
    )
    .unwrap();

    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert_eq!(plan[1].kind.as_deref(), Some("base"));
    assert_eq!(plan[1].dependencies, vec!["main-vendor"]);
    let lazy = plan
        .iter()
        .find(|chunk| chunk.kind.as_deref() == Some("lazy"))
        .expect("lazy chunk");
    // Lazy chunks keep their existing dependency lists: Closure chunk deps
    // are transitive, and a panel reaches vendor through base. Verified
    // against the real compiler - a panel referencing a vendor symbol with
    // only a base dependency compiles clean and inlines correctly.
    assert_eq!(lazy.dependencies, vec!["main"]);
}

#[test]
fn dotted_module_names_still_probe_extensions() {
    // `enum.untyped.ts` imported as `./enum.untyped`: the trailing `untyped`
    // segment is part of the name, not an extension, so the `.ts` candidate
    // must still be produced.
    let candidates = super::module_candidates(Path::new("/w/src/enum.untyped"))
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(
        candidates.contains(&"/w/src/enum.untyped.ts".to_string()),
        "{candidates:?}"
    );
    assert!(
        candidates.contains(&"/w/src/enum.untyped.tsx".to_string()),
        "{candidates:?}"
    );
    // The literal path stays first, so a file that resolves today keeps
    // resolving to exactly the same file.
    assert_eq!(
        candidates.first().map(String::as_str),
        Some("/w/src/enum.untyped")
    );
}

#[test]
fn multi_dot_module_names_probe_extensions() {
    let candidates = super::module_candidates(Path::new("/w/decorator_nested_scope.decorated"))
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(
        candidates.contains(&"/w/decorator_nested_scope.decorated.ts".to_string()),
        "{candidates:?}"
    );
}

#[test]
fn a_real_js_extension_is_not_shadowed_by_an_appended_one() {
    // The regression this guards: treating every trailing segment as a name
    // would make `./x.js` probe `x.js.ts` and could shadow a real `x.js`.
    // A known module extension must keep the exact-file-first behaviour and
    // must never gain an appended-extension candidate.
    let candidates = super::module_candidates(Path::new("/w/src/x.js"))
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert_eq!(candidates.first().map(String::as_str), Some("/w/src/x.js"));
    assert!(
        !candidates
            .iter()
            .any(|candidate| candidate.ends_with("x.js.ts")),
        "{candidates:?}"
    );
    // The established `.js` -> `.ts` substitution is untouched.
    assert!(
        candidates.contains(&"/w/src/x.ts".to_string()),
        "{candidates:?}"
    );
}

#[test]
fn materialized_dependency_bundle_commonjs_is_allowed_by_signed_marker() {
    let temp_dir = TestDir::new();
    let bundle_contents = "module.exports = 7;\n";
    temp_dir.write("src/__dep-bundles/eager/generated.js", bundle_contents);
    let hash = Sha256::digest(bundle_contents.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    temp_dir.write(
        "src/__dep-bundles/.gcc-ts-bundler-materialized-dependency-bundles.json",
        &format!(
            r#"{{"files":[{{"path":"eager/generated.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
        ),
    );
    temp_dir.write(
        "src/index.js",
        "import value from \"./__dep-bundles/eager/generated.js\"; export default value;\n",
    );

    let result = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    );

    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn authored_commonjs_stays_rejected_without_materialized_marker() {
    let temp_dir = TestDir::new();
    temp_dir.write("src/authored.js", "module.exports = 7;\n");
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .expect_err("authored CommonJS must remain rejected");

    assert!(error.contains("CommonJS is only supported"), "{error}");
}

#[test]
fn authored_commonjs_rejects_forged_source_root_marker() {
    let temp_dir = TestDir::new();
    let contents = "module.exports = 7;\n";
    let hash = Sha256::digest(contents.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    temp_dir.write("src/authored.js", contents);
    temp_dir.write(
        "src/.gcc-ts-bundler-materialized-dependency-bundles.json",
        &format!(
            r#"{{"files":[{{"path":"authored.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
        ),
    );
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .expect_err("a source-root marker must not authorize authored CommonJS");

    assert!(error.contains("CommonJS is only supported"), "{error}");
}

#[test]
fn dependency_bundle_marker_rejects_entries_outside_its_root() {
    let temp_dir = TestDir::new();
    let contents = "module.exports = 7;\n";
    let hash = Sha256::digest(contents.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    temp_dir.write("src/authored.js", contents);
    temp_dir.write(
        "src/__dep-bundles/.gcc-ts-bundler-materialized-dependency-bundles.json",
        &format!(
            r#"{{"files":[{{"path":"../authored.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
        ),
    );
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    );

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .expect_err("a bundle marker must not authorize paths outside __dep-bundles");

    assert!(error.contains("CommonJS is only supported"), "{error}");
}

#[test]
fn every_known_module_extension_suppresses_appending() {
    for extension in [
        "ts", "tsx", "js", "jsx", "mjs", "mts", "cjs", "cts", "json", "node",
    ] {
        let base = format!("/w/src/file.{extension}");
        let candidates = super::module_candidates(Path::new(&base))
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(candidates.first().map(String::as_str), Some(base.as_str()));
        assert!(
            !candidates
                .iter()
                .any(|candidate| candidate == &format!("{base}.ts")),
            "{extension}: {candidates:?}"
        );
    }
}

// --- Rollup-mirrored chunk plan ------------------------------------------

/// A six-chunk Rollup graph with two dependency-free chunks, a shared chunk
/// behind two dynamic routes, an unassigned atom consumed from two chunks, and
/// an entry shim nothing consumes.
fn mirror_fixture() -> (
    Vec<ChunkPlanEntryInput>,
    Vec<DependencyGraphEntry>,
    Vec<LazyImportEntry>,
    Vec<RollupChunkInput>,
) {
    let entries = vec![ChunkPlanEntryInput {
        chunkName: "index".to_string(),
        outputName: "index.js".to_string(),
        sourcePath: "/workspace/src/main.js".to_string(),
    }];
    let graph = vec![
        DependencyGraphEntry {
            filePath: "/workspace/entries/index.ts".to_string(),
            dependencies: vec!["/workspace/src/main.js".to_string()],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/main.js".to_string(),
            dependencies: vec![
                "/workspace/src/atom.js".to_string(),
                "/workspace/src/polyfill.js".to_string(),
                "/workspace/src/ui.js".to_string(),
                "/workspace/node_modules/lib/index.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/ui.js".to_string(),
            dependencies: vec!["/workspace/node_modules/lib/index.js".to_string()],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/shared.js".to_string(),
            dependencies: vec!["/workspace/src/atom.js".to_string()],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/route-a.js".to_string(),
            dependencies: vec![
                "/workspace/src/shared.js".to_string(),
                "/workspace/src/ui.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/route-b.js".to_string(),
            dependencies: vec!["/workspace/src/shared.js".to_string()],
        },
        DependencyGraphEntry {
            filePath: "/workspace/node_modules/lib/index.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/atom.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            filePath: "/workspace/src/polyfill.js".to_string(),
            dependencies: vec![],
        },
    ];
    let lazy_imports = vec![
        LazyImportEntry {
            importerFilePath: "/workspace/src/main.js".to_string(),
            moduleId: "gcc.src.route-a".to_string(),
            specifier: "./route-a.js".to_string(),
            targetPath: "/workspace/src/route-a.js".to_string(),
        },
        LazyImportEntry {
            importerFilePath: "/workspace/src/main.js".to_string(),
            moduleId: "gcc.src.route-b".to_string(),
            specifier: "./route-b.js".to_string(),
            targetPath: "/workspace/src/route-b.js".to_string(),
        },
    ];
    let rollup_chunk = |name: &str,
                        file_name: &str,
                        is_entry: bool,
                        module_files: &[&str],
                        imports: &[&str],
                        dynamic_imports: &[&str]| RollupChunkInput {
        dynamicImportedChunkFileNames: dynamic_imports
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        fileName: file_name.to_string(),
        importedChunkFileNames: imports.iter().map(|value| (*value).to_string()).collect(),
        isEntry: is_entry,
        moduleFiles: module_files
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        name: name.to_string(),
    };
    let rollup_chunks = vec![
        rollup_chunk(
            "index",
            "index-aaaa.js",
            true,
            &["/workspace/src/main.js"],
            &["vendor-bbbb.js", "ui-cccc.js", "polyfill-gggg.js"],
            &["route-a-eeee.js", "route-b-ffff.js"],
        ),
        rollup_chunk(
            "vendor",
            "vendor-bbbb.js",
            false,
            &["/workspace/node_modules/lib/index.js"],
            &[],
            &[],
        ),
        rollup_chunk(
            "ui",
            "ui-cccc.js",
            false,
            &["/workspace/src/ui.js"],
            &["vendor-bbbb.js"],
            &[],
        ),
        rollup_chunk(
            "shared",
            "shared-dddd.js",
            false,
            &["/workspace/src/shared.js"],
            &["vendor-bbbb.js"],
            &[],
        ),
        rollup_chunk(
            "route-a",
            "route-a-eeee.js",
            false,
            &["/workspace/src/route-a.js"],
            &["shared-dddd.js", "ui-cccc.js"],
            &[],
        ),
        rollup_chunk(
            "route-b",
            "route-b-ffff.js",
            false,
            &["/workspace/src/route-b.js"],
            &["shared-dddd.js"],
            &[],
        ),
        rollup_chunk(
            "polyfill",
            "polyfill-gggg.js",
            false,
            &["/workspace/src/polyfill.js"],
            &[],
            &[],
        ),
    ];
    (entries, graph, lazy_imports, rollup_chunks)
}

fn plan_mirror(rollup_chunks: Vec<RollupChunkInput>) -> Vec<ChunkPlanChunkOutput> {
    let (entries, graph, lazy_imports, _) = mirror_fixture();
    plan_chunks(
        "bundler-runtime".to_string(),
        "index".to_string(),
        "/workspace".to_string(),
        entries,
        graph,
        lazy_imports,
        rollup_chunks,
        vec![],
        false,
    )
    .expect("the mirrored Rollup graph should plan")
}

#[test]
fn mirrored_plan_reproduces_the_rollup_chunk_graph() {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks);
    let names = plan
        .iter()
        .map(|chunk| chunk.name.as_str())
        .collect::<Vec<_>>();

    // One Closure chunk per Rollup chunk, dependencies before dependents.
    assert_eq!(
        names,
        vec!["polyfill", "vendor", "shared", "route-b", "ui", "index", "route-a"]
    );
    let by_name = plan
        .iter()
        .map(|chunk| (chunk.name.as_str(), chunk))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(by_name["ui"].dependencies, vec!["vendor"]);
    assert_eq!(by_name["shared"].dependencies, vec!["vendor"]);
    assert_eq!(by_name["route-a"].dependencies, vec!["ui", "shared"]);
    assert_eq!(by_name["route-b"].dependencies, vec!["shared"]);
    assert_eq!(
        by_name["index"].dependencies,
        vec!["vendor", "ui", "polyfill"]
    );

    // The entry chunk is a sink in Rollup's graph, so it is base by kind, not
    // by position, and it still carries the entry files.
    assert_eq!(by_name["index"].kind.as_deref(), Some("base"));
    assert_eq!(
        by_name["index"].entryFiles.as_deref(),
        Some(["src/main.js".to_string()].as_slice())
    );
    assert!(plan
        .iter()
        .filter(|chunk| chunk.name != "index")
        .all(|chunk| chunk.entryFiles.is_none()));

    // Rollup's dynamic imports become lazy roots that pruning can never erase.
    assert_eq!(by_name["route-a"].kind.as_deref(), Some("lazy"));
    assert_eq!(
        by_name["route-a"].lazyModuleIds.as_deref(),
        Some(["gcc.src.route-a".to_string()].as_slice())
    );
    assert_eq!(by_name["route-b"].kind.as_deref(), Some("lazy"));
    // A plain shared chunk keeps neither kind nor lazy ids, so an empty one is
    // still prunable.
    assert_eq!(by_name["shared"].kind, None);
    assert_eq!(by_name["shared"].lazyModuleIds, None);
}

#[test]
fn mirrored_plan_gives_multi_root_rollup_graphs_one_closure_root() {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks);

    // Closure's JSChunkGraph.getRootChunk accepts exactly one dependency-free
    // chunk; Rollup produced two. The extra root is chained onto the leader,
    // which is the chunk that carries the runtime core and the leading inputs.
    assert_eq!(plan[0].name, "polyfill");
    assert!(plan[0].dependencies.is_empty());
    assert_eq!(plan[1].name, "vendor");
    assert_eq!(plan[1].dependencies, vec!["polyfill"]);
    assert_eq!(
        plan.iter()
            .filter(|chunk| chunk.dependencies.is_empty())
            .count(),
        1
    );
}

#[test]
fn mirrored_plan_places_unassigned_files_at_the_deepest_shared_ancestor() {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks);
    let by_name = plan
        .iter()
        .map(|chunk| (chunk.name.as_str(), chunk))
        .collect::<BTreeMap<_, _>>();

    // atom.js is in no Rollup chunk and is consumed from both the entry chunk
    // and the shared chunk, whose only common ancestors are the two roots.
    assert_eq!(
        by_name["vendor"].files,
        vec!["node_modules/lib/index.js", "src/atom.js"]
    );
    assert!(!by_name["index"].files.contains(&"src/atom.js".to_string()));
    assert!(!by_name["shared"].files.contains(&"src/atom.js".to_string()));

    // Every Rollup-owned module stays in the chunk Rollup chose.
    assert_eq!(by_name["index"].files, vec!["src/main.js"]);
    assert_eq!(by_name["ui"].files, vec!["src/ui.js"]);
    assert_eq!(by_name["shared"].files, vec!["src/shared.js"]);
    assert_eq!(by_name["route-a"].files, vec!["src/route-a.js"]);

    // The entry shim only imports; nothing consumes it, so it is dead weight
    // the mirror drops instead of shipping.
    assert!(plan
        .iter()
        .all(|chunk| !chunk.files.iter().any(|file| file.contains("entries/"))));
}

#[test]
fn mirrored_plan_rejects_a_cyclic_rollup_chunk_graph() {
    let (entries, graph, lazy_imports, mut rollup_chunks) = mirror_fixture();
    // Closure chunk dependencies are a DAG; a cycle has no legal ordering.
    rollup_chunks[1]
        .importedChunkFileNames
        .push("ui-cccc.js".to_string());
    let error = plan_chunks(
        "bundler-runtime".to_string(),
        "index".to_string(),
        "/workspace".to_string(),
        entries,
        graph,
        lazy_imports,
        rollup_chunks,
        vec![],
        false,
    )
    .expect_err("a cyclic chunk graph has no topological order");

    assert!(error.contains("import cycle"), "{error}");
}

#[test]
fn absent_rollup_chunks_keep_the_standalone_lazy_planner() {
    let (entries, graph, lazy_imports, _) = mirror_fixture();
    let plan = plan_chunks(
        "bundler-runtime".to_string(),
        "index".to_string(),
        "/workspace".to_string(),
        entries,
        graph,
        lazy_imports,
        vec![],
        vec![],
        false,
    )
    .expect("the standalone chunked build has no Rollup graph to mirror");

    assert_eq!(plan[0].name, "index");
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan
        .iter()
        .any(|chunk| chunk.kind.as_deref() == Some("lazy")));
}
