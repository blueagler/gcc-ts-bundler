use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::chunk_mirror::RollupChunkInput;
use super::package_resolver::{is_external_boundary_specifier, select_package_export_target};
use super::{
    assign_chunk_names, plan_chunks, resolve_graph, ChunkPlanChunkOutput, ChunkPlanEntryInput,
    DependencyGraphEntry, LazyImportEntry, PackageMode, PlanChunksInput, ResolveContext,
    BROWSER_TARGET,
};
use crate::pathing::to_goog_module_id;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::hash_content;
use serde_json::Value;

static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let suffix = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("gcc-ts-bundler-native-{unique}-{suffix}"));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn join(&self, relative: &str) -> PathBuf {
        self.path.join(relative)
    }

    fn write(&self, relative: &str, contents: &str) -> std::io::Result<()> {
        let file_path = self.join(relative);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(file_path, contents)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn top_level_await_classifies_preserved_modules_without_nested_false_positives(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write("src/index.js",
    "import { value } from './tla.js'; import { sum } from './for-await.js'; import { nested } from './nested.js'; import { nestedForAwait } from './nested-for-await.js'; import { usingValue } from './await-using.js'; import { nestedUsing } from './nested-await-using.js'; console.log(value, sum, nested, nestedForAwait, usingValue, nestedUsing);",)?;
    temp_dir.write(
        "src/tla.js",
        "export const value = await Promise.resolve(1); export default value;",
    )?;
    temp_dir.write("src/for-await.js",
    "let sum = 0; try { if (true) { for await (const value of [Promise.resolve(2)]) { sum += value; } } } finally {} export { sum };",)?;
    temp_dir.write(
        "src/nested.js",
        "export async function nested() { return await Promise.resolve(2); }",
    )?;
    temp_dir.write("src/nested-for-await.js",
    "export async function nestedForAwait() { for await (const value of [Promise.resolve(3)]) { return value; } }",)?;
    temp_dir.write(
        "src/await-using.js",
        "await using resource = null; export const usingValue = resource;",
    )?;
    temp_dir.write(
        "src/nested-await-using.js",
        "export async function nestedUsing() { await using resource = null; return resource; }",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert_eq!(result.preserved_modules.len(), 3);
    let preserved = result
        .preserved_modules
        .iter()
        .find(|entry| entry.file_path.ends_with("src/tla.js"))
        .ok_or("expected preserved tla module")?;
    assert_eq!(preserved.export_names, vec!["value"]);
    assert!(preserved.has_default_export);
    assert!(result
        .preserved_modules
        .iter()
        .any(|entry| entry.file_path.ends_with("src/for-await.js")));
    assert!(result
        .preserved_modules
        .iter()
        .any(|entry| entry.file_path.ends_with("src/await-using.js")));
    for compiled_path in [
        "src/nested.js",
        "src/nested-for-await.js",
        "src/nested-await-using.js",
    ] {
        assert!(result
            .graph
            .iter()
            .any(|entry| entry.file_path.ends_with(compiled_path)),);
        assert!(!result
            .preserved_modules
            .iter()
            .any(|entry| entry.file_path.ends_with(compiled_path)),);
    }
    Ok(())
}

#[test]
fn preserved_compiled_cycles_fail_closed() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write("src/index.js", "import './a.js';")?;
    temp_dir.write(
        "src/a.js",
        "import { b } from './b.js'; export const a = await Promise.resolve(b);",
    )?;
    temp_dir.write(
        "src/b.js",
        "import { a } from './a.js'; export const b = a ?? 1;",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("operation unexpectedly succeeded")?;

    assert!(error.contains("Preserved/compiled module cycle is unsupported in phase 1"));
    assert!(error.contains("a.js"));
    assert!(error.contains("b.js"));
    Ok(())
}

#[test]
fn resolves_package_root_from_exports_browser_condition() -> Result<(), Box<dyn std::error::Error>>
{
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}"#,
    )?;
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n")?;
    temp_dir.write("node_modules/demo-pkg/import.js", "export default 2;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    Ok(())
}

#[test]
fn prefers_production_exports_in_release_mode() -> Result<(), Box<dyn std::error::Error>> {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js",
                    "production": "./prod.js",
                    "default": "./default.js"
                }
            }"#,
    )?;

    let resolved = select_package_export_target(&exports, ".", "demo-pkg", false)?;

    assert_eq!(resolved.as_deref(), Some("./prod.js"));
    Ok(())
}

#[test]
fn prefers_development_exports_in_debug_mode() -> Result<(), Box<dyn std::error::Error>> {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "development": "./dev.js",
                    "production": "./prod.js",
                    "default": "./default.js"
                }
            }"#,
    )?;

    let resolved = select_package_export_target(&exports, ".", "demo-pkg", true)?;

    assert_eq!(resolved.as_deref(), Some("./dev.js"));
    Ok(())
}

#[test]
fn release_conditions_fall_through_to_a_sibling_key_when_the_matched_subtree_is_debug_only(
) -> Result<(), Box<dyn std::error::Error>> {
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
    )?;

    let release = select_package_export_target(&exports, ".", "demo-pkg", false)?;
    let debug = select_package_export_target(&exports, ".", "demo-pkg", true)?;

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
    Ok(())
}

#[test]
fn a_matched_subtree_with_no_resolvable_condition_and_no_sibling_fails_closed(
) -> Result<(), Box<dyn std::error::Error>> {
    // Same shape with the sibling removed, and with a condition no pass knows.
    // Falling through has to run out of keys and report "no target" rather than
    // invent one.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": {
                    "react-native": "./rn.js"
                }
            }"#,
    )?;

    for prefer_debug in [false, true] {
        let resolved = select_package_export_target(&exports, ".", "demo-pkg", prefer_debug)?;
        assert_eq!(
            resolved, None,
            "exhausting the sibling keys must fail closed"
        );
    }
    Ok(())
}

#[test]
fn a_package_offering_only_a_development_build_still_resolves_in_release(
) -> Result<(), Box<dyn std::error::Error>> {
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
    )?;

    let release = select_package_export_target(&exports, ".", "demo-pkg", false)?;

    assert_eq!(release.as_deref(), Some("./dev.js"));
    Ok(())
}

#[test]
fn sibling_fall_through_works_at_every_nesting_depth() -> Result<(), Box<dyn std::error::Error>> {
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
    )?;

    let release = select_package_export_target(&exports, ".", "demo-pkg", false)?;

    assert_eq!(
        release.as_deref(),
        Some("./browser-default.js"),
        "release must recover inside the nested object, not fall through to the debug pass"
    );
    Ok(())
}

#[test]
fn a_false_target_stays_a_hard_error_even_when_a_sibling_key_would_resolve(
) -> Result<(), Box<dyn std::error::Error>> {
    // The fall-through must not turn a disabled export into a silent fallback.
    // `"browser": false` means the package refuses browser bundling; resolving
    // the sibling `default` here would serve its Node build to a browser bundle,
    // which is the whole failure this error exists to prevent.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": false,
                "default": "./node.js"
            }"#,
    )?;

    for prefer_debug in [false, true] {
        let error = select_package_export_target(&exports, ".", "demo-pkg", prefer_debug)
            .err()
            .ok_or("a disabled browser export must stay an error")?;
        assert!(error.contains("disables this export"), "{error}");
    }
    Ok(())
}

#[test]
fn a_null_target_stays_a_hard_error_even_when_a_sibling_key_would_resolve(
) -> Result<(), Box<dyn std::error::Error>> {
    let exports = serde_json::from_str::<Value>(
        r#"{
                "browser": null,
                "default": "./node.js"
            }"#,
    )?;

    let error = select_package_export_target(&exports, ".", "demo-pkg", false)
        .err()
        .ok_or("a null target must stay an error")?;
    assert!(error.contains("disables this export"), "{error}");
    Ok(())
}

#[test]
fn condition_walk_order_follows_our_ranking_not_the_json_key_order(
) -> Result<(), Box<dyn std::error::Error>> {
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
    )?;

    let release = select_package_export_target(&exports, ".", "demo-pkg", false)?;
    let debug = select_package_export_target(&exports, ".", "demo-pkg", true)?;

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
    Ok(())
}

#[test]
fn browser_outranks_a_sibling_import_key_that_also_resolves(
) -> Result<(), Box<dyn std::error::Error>> {
    // The other half of the walk-order pin: `browser` is first in every
    // condition list, so a resolvable `browser` subtree wins over a resolvable
    // `import` sibling. Only an *unresolvable* match falls through.
    let exports = serde_json::from_str::<Value>(
        r#"{
                "import": "./import.js",
                "browser": "./browser.js"
            }"#,
    )?;

    let release = select_package_export_target(&exports, ".", "demo-pkg", false)?;

    assert_eq!(release.as_deref(), Some("./browser.js"));
    Ok(())
}

#[test]
fn resolves_package_subpath_from_exports_pattern() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import feature from \"demo-pkg/features/button\";\nexport default feature;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","exports":{"./features/*":{"browser":"./dist/features/*.js"}}}"#,
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/dist/features/button.js",
        "export default 1;\n",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/dist/features/button.js")));
    Ok(())
}

#[test]
fn falls_back_to_browser_then_module_then_main() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write("node_modules/demo-pkg/package.json",
    r#"{"name":"demo-pkg","browser":"./browser.js","module":"./module.js","main":"./main.cjs"}"#,)?;
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n")?;
    temp_dir.write("node_modules/demo-pkg/module.js", "export default 2;\n")?;
    temp_dir.write("node_modules/demo-pkg/main.cjs", "module.exports = 3;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    Ok(())
}

#[test]
fn applies_browser_object_mapping_to_package_main() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./node.js","browser":{"./node.js":"./browser.js"}}"#,
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/node.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    )?;
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    assert!(!result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/node.js")));
    Ok(())
}

#[test]
fn applies_browser_object_mapping_to_package_module() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write("node_modules/demo-pkg/package.json",
    r#"{"name":"demo-pkg","module":"./node.js","main":"./fallback.js","browser":{"./node.js":"./browser.js"}}"#,)?;
    temp_dir.write(
        "node_modules/demo-pkg/node.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    )?;
    temp_dir.write("node_modules/demo-pkg/fallback.js", "export default 2;\n")?;
    temp_dir.write("node_modules/demo-pkg/browser.js", "export default 1;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/browser.js")));
    assert!(!result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/fallback.js")));
    Ok(())
}

#[test]
fn applies_browser_object_mapping_to_relative_package_imports(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write("node_modules/demo-pkg/package.json",
    r#"{"name":"demo-pkg","main":"./index.js","browser":{"./feature.js":"./feature-browser.js"}}"#,)?;
    temp_dir.write(
        "node_modules/demo-pkg/index.js",
        "import feature from \"./feature\";\nexport default feature;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/feature.js",
        "import fs from \"node:fs\";\nexport default fs;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/feature-browser.js",
        "export default 1;\n",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/feature-browser.js")));
    assert!(!result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/feature.js")));
    let resolved = result
        .resolved_imports
        .iter()
        .find(|entry| {
            entry
                .importer_file_path
                .ends_with("node_modules/demo-pkg/index.js")
                && entry.specifier == "./feature"
        })
        .ok_or("resolved relative import")?;
    assert!(resolved
        .target_path
        .ends_with("node_modules/demo-pkg/feature-browser.js"));
    assert_eq!(
        resolved.module_id,
        to_goog_module_id(
            &temp_dir.join("node_modules/demo-pkg/feature-browser.js"),
            &temp_dir.path,
        )
    );
    Ok(())
}

#[test]
fn dynamic_import_templates_use_cooked_specifiers_in_graph_resolution(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        r"globalThis.load = () => import(`./\u0066eature.js`);",
    )?;
    temp_dir.write("src/feature.js", "export const value = 1;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert_eq!(result.lazy_imports.len(), 1);
    assert_eq!(result.lazy_imports[0].specifier, "./feature.js");
    assert!(result.lazy_imports[0]
        .target_path
        .ends_with("src/feature.js"));
    Ok(())
}

#[test]
fn resolves_package_relative_module_field_without_dot_prefix(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"es/index.js","main":"lib/index.js"}"#,
    )?;
    temp_dir.write("node_modules/demo-pkg/es/index.js", "export default 1;\n")?;
    temp_dir.write(
        "node_modules/demo-pkg/lib/index.js",
        "module.exports = 2;\n",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("node_modules/demo-pkg/es/index.js")));
    Ok(())
}

#[test]
fn tracks_package_json_hash_changes() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"./index.js"}"#,
    )?;
    temp_dir.write("node_modules/demo-pkg/index.js", "export default 1;\n")?;

    let first = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","module":"./index.js","version":"2.0.0"}"#,
    )?;
    let second = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    let first_hash = first
        .file_hashes
        .iter()
        .find(|entry| entry.file_path == "node_modules/demo-pkg/package.json")
        .ok_or("expected initial package hash")?
        .hash
        .clone();
    let second_hash = second
        .file_hashes
        .iter()
        .find(|entry| entry.file_path == "node_modules/demo-pkg/package.json")
        .ok_or("expected updated package hash")?
        .hash
        .clone();

    assert_ne!(first_hash, second_hash);
    Ok(())
}

#[test]
fn resolves_commonjs_package_below_source_root() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "src/node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./index.js"}"#,
    )?;
    temp_dir.write(
        "src/node_modules/demo-pkg/index.js",
        "module.exports = 1;\n",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("src/node_modules/demo-pkg/index.js")));
    Ok(())
}

#[test]
fn rejects_unsupported_commonjs_package_patterns() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/package.json",
        r#"{"name":"demo-pkg","main":"./index.cjs"}"#,
    )?;
    temp_dir.write(
        "node_modules/demo-pkg/index.cjs",
        "module.exports = require(name);\n",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("operation unexpectedly succeeded")?;

    assert!(error.contains("Unsupported CommonJS"));
    Ok(())
}

#[test]
fn rejects_node_builtin_imports() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/index.ts",
        "import { join } from \"node:path\";\nexport default join;\n",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("operation unexpectedly succeeded")?;

    assert!(error.contains("Node builtin"));
    Ok(())
}

#[test]
fn external_boundary_specifiers_match_package_subpaths_not_unrelated_prefixes(
) -> Result<(), Box<dyn std::error::Error>> {
    let externals = BTreeSet::from([
        "google-closure-compiler".to_string(),
        "@foo/bar".to_string(),
    ]);
    let preserved = BTreeSet::new();
    let src_dir = PathBuf::from("src");
    let workspace_dir = PathBuf::from(".");
    let context = ResolveContext {
        external_specifiers: &externals,
        package_mode: PackageMode::EsmOnly,
        preserved_file_paths: &preserved,
        target: BROWSER_TARGET,
        src_dir: &src_dir,
        workspace_dir: &workspace_dir,
    };

    assert!(is_external_boundary_specifier(
        "google-closure-compiler",
        &context
    ));
    assert!(is_external_boundary_specifier(
        "google-closure-compiler/lib/utils.js",
        &context
    ));
    assert!(!is_external_boundary_specifier("google", &context));
    assert!(!is_external_boundary_specifier(
        "google-closure-compiler-js",
        &context
    ));
    assert!(is_external_boundary_specifier("@foo/bar", &context));
    assert!(is_external_boundary_specifier("@foo/bar/baz", &context));
    assert!(!is_external_boundary_specifier("@foo/baz", &context));
    Ok(())
}

#[test]
fn target_matrix_selects_conditional_exports_and_external_boundaries(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write(
        "src/conditions.ts",
        "import pkg from \"demo-pkg\";\nexport default pkg;\n",
    )?;
    temp_dir.write("src/node-boundaries.ts",
    "import nodeFs from \"node:fs\";\nimport barePath from \"path\";\nexport default [nodeFs, barePath];\n",)?;
    temp_dir.write("src/bun-boundaries.ts",
    "import nodeFs from \"node:fs\";\nimport barePath from \"path\";\nimport bunTest from \"bun:test\";\nexport default [nodeFs, barePath, bunTest];\n",)?;
    temp_dir.write("node_modules/demo-pkg/package.json",
    r#"{"name":"demo-pkg","exports":{"browser":"./browser.js","node":"./node.js","bun":"./bun.js","workerd":"./workerd.js","import":"./import.js","require":"./require.js","default":"./default.js"}}"#,)?;
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
        )?;
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
        )?;
        assert!(
            result
                .source_files
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
        )?;
        assert_eq!(
            result
                .external_boundaries
                .iter()
                .map(|item| item.specifier.as_str())
                .collect::<Vec<_>>(),
            expected_boundaries
        );
    }
    Ok(())
}

#[test]
fn resolves_js_specifier_to_ts_source() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write("src/index.ts", "export { value } from \"./support.js\";\n")?;
    temp_dir.write("src/support.ts", "export const value = 1;\n")?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.ts").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )?;

    assert!(result
        .source_files
        .iter()
        .any(|path| path.ends_with("src/support.ts")));
    Ok(())
}

#[test]
fn colliding_chunk_names_receive_deterministic_entry_identity_suffixes(
) -> Result<(), Box<dyn std::error::Error>> {
    let base_names = vec!["index".to_string(), "index".to_string()];
    let assigned = assign_chunk_names(
        base_names.clone(),
        vec!["index.ts".to_string(), "vite/index.ts".to_string()],
    )?;
    let assigned_with_windows_separator = assign_chunk_names(
        base_names,
        vec!["index.ts".to_string(), "vite\\index.ts".to_string()],
    )?;

    assert_eq!(assigned, assigned_with_windows_separator);
    assert_ne!(assigned[0], assigned[1]);
    assert!(assigned.iter().all(|name| name.starts_with("index-")));
    Ok(())
}

#[test]
fn non_colliding_chunk_names_are_byte_stable() -> Result<(), Box<dyn std::error::Error>> {
    let assigned = assign_chunk_names(
        vec!["main".to_string(), "panel".to_string()],
        vec!["src/main.ts".to_string(), "src/panel.ts".to_string()],
    )?;

    assert_eq!(assigned, vec!["main".to_string(), "panel".to_string()]);
    Ok(())
}

#[test]
fn off_mode_chunk_plan_disambiguates_colliding_output_basenames(
) -> Result<(), Box<dyn std::error::Error>> {
    let plan = || {
        plan_chunks(PlanChunksInput {
            chunk_mode: "off".to_string(),
            base_chunk_name: "ignored".to_string(),
            workspace_dir: "/workspace".to_string(),
            entry_files: vec![
                ChunkPlanEntryInput {
                    output_name: "index.mjs".to_string(),
                    source_path: "/workspace/src/index.ts".to_string(),
                    shim_path: "/workspace/entries/index-mjs.ts".to_string(),
                },
                ChunkPlanEntryInput {
                    output_name: "vite/index.mjs".to_string(),
                    source_path: "/workspace/src/vite/index.ts".to_string(),
                    shim_path: "/workspace/entries/vite-index-mjs.ts".to_string(),
                },
            ],
            graph_entries: vec![
                DependencyGraphEntry {
                    file_path: "/workspace/entries/index-mjs.ts".to_string(),
                    dependencies: vec!["/workspace/src/index.ts".to_string()],
                },
                DependencyGraphEntry {
                    file_path: "/workspace/entries/vite-index-mjs.ts".to_string(),
                    dependencies: vec!["/workspace/src/vite/index.ts".to_string()],
                },
                DependencyGraphEntry {
                    file_path: "/workspace/src/index.ts".to_string(),
                    dependencies: vec![],
                },
                DependencyGraphEntry {
                    file_path: "/workspace/src/vite/index.ts".to_string(),
                    dependencies: vec![],
                },
            ],
            lazy_imports: vec![],
            rollup_chunks: vec![],
            vendor_chunk: false,
        })
    };
    let first = plan()?;
    let second = plan()?;
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
    Ok(())
}

#[test]
fn plans_bundler_runtime_chunks_in_native_graph_layer() -> Result<(), Box<dyn std::error::Error>> {
    let result = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![ChunkPlanEntryInput {
            output_name: "main.js".to_string(),
            source_path: "/workspace/src/main.ts".to_string(),
            shim_path: "/workspace/entries/main.ts".to_string(),
        }],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/src/main.ts".to_string(),
                dependencies: vec!["/workspace/src/shared.ts".to_string()],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/shared.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/feature.ts".to_string(),
                dependencies: vec!["/workspace/src/shared.ts".to_string()],
            },
        ],
        lazy_imports: vec![LazyImportEntry {
            importer_file_path: "/workspace/src/main.ts".to_string(),
            module_id: "gcc.src.feature".to_string(),
            specifier: "./feature".to_string(),
            target_path: "/workspace/src/feature.ts".to_string(),
        }],
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].name, "main");
    assert_eq!(result[0].kind.as_deref(), Some("base"));
    assert_eq!(result[1].name, "src-feature-lazy");
    assert_eq!(result[1].kind.as_deref(), Some("lazy"));
    assert_eq!(result[1].dependencies, vec!["main"]);
    Ok(())
}

#[test]
fn plans_off_mode_chunks_in_native_graph_layer() -> Result<(), Box<dyn std::error::Error>> {
    let result = plan_chunks(PlanChunksInput {
        chunk_mode: "off".to_string(),
        base_chunk_name: "ignored".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![
            ChunkPlanEntryInput {
                output_name: "first.js".to_string(),
                source_path: "/workspace/src/first.ts".to_string(),
                shim_path: "/workspace/entries/first.ts".to_string(),
            },
            ChunkPlanEntryInput {
                output_name: "second.js".to_string(),
                source_path: "/workspace/src/second.ts".to_string(),
                shim_path: "/workspace/entries/second.ts".to_string(),
            },
        ],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/entries/first.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/first.ts".to_string(),
                    "/workspace/src/shared.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/entries/second.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/second.ts".to_string(),
                    "/workspace/src/shared.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/first.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/second.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/shared.ts".to_string(),
                dependencies: vec![],
            },
        ],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].name, "shared");
    assert_eq!(result[1].name, "first");
    assert_eq!(result[1].dependencies, vec!["shared"]);
    assert_eq!(
        result[1].entry_files.as_deref(),
        Some(["src/first.ts".to_string()].as_slice())
    );
    assert_eq!(result[2].name, "second");
    assert_eq!(result[2].dependencies, vec!["shared"]);
    assert_eq!(
        result[2].entry_files.as_deref(),
        Some(["src/second.ts".to_string()].as_slice())
    );
    Ok(())
}

#[test]
fn off_mode_chunk_plan_partitions_disjoint_share_groups() -> Result<(), Box<dyn std::error::Error>>
{
    let result = plan_chunks(PlanChunksInput {
        chunk_mode: "off".to_string(),
        base_chunk_name: "ignored".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![
            ChunkPlanEntryInput {
                output_name: "a.js".to_string(),
                source_path: "/workspace/src/a.ts".to_string(),
                shim_path: "/workspace/entries/a.ts".to_string(),
            },
            ChunkPlanEntryInput {
                output_name: "b.js".to_string(),
                source_path: "/workspace/src/b.ts".to_string(),
                shim_path: "/workspace/entries/b.ts".to_string(),
            },
            ChunkPlanEntryInput {
                output_name: "c.js".to_string(),
                source_path: "/workspace/src/c.ts".to_string(),
                shim_path: "/workspace/entries/c.ts".to_string(),
            },
            ChunkPlanEntryInput {
                output_name: "d.js".to_string(),
                source_path: "/workspace/src/d.ts".to_string(),
                shim_path: "/workspace/entries/d.ts".to_string(),
            },
        ],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/entries/a.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/a.ts".to_string(),
                    "/workspace/src/shared-ab.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/entries/b.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/b.ts".to_string(),
                    "/workspace/src/shared-ab.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/entries/c.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/c.ts".to_string(),
                    "/workspace/src/shared-cd.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/entries/d.ts".to_string(),
                dependencies: vec![
                    "/workspace/src/d.ts".to_string(),
                    "/workspace/src/shared-cd.ts".to_string(),
                ],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/a.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/b.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/c.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/d.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/shared-ab.ts".to_string(),
                dependencies: vec![],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/shared-cd.ts".to_string(),
                dependencies: vec![],
            },
        ],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    let names = result
        .iter()
        .map(|chunk| chunk.name.clone())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), names.iter().collect::<BTreeSet<_>>().len());
    assert_eq!(result.len(), 6);
    assert_eq!(result[0].name, "shared");
    assert_eq!(result[1].name, "a");
    assert_eq!(result[1].dependencies, vec!["shared"]);
    assert_eq!(result[2].name, "b");
    assert_eq!(result[2].dependencies, vec!["shared"]);
    assert_eq!(result[3].name, "shared2");
    assert_eq!(result[4].name, "c");
    assert_eq!(result[4].dependencies, vec!["shared2"]);
    assert_eq!(result[5].name, "d");
    assert_eq!(result[5].dependencies, vec!["shared2"]);
    assert!(result[0]
        .files
        .iter()
        .any(|file| file.contains("shared-ab")));
    assert!(!result[0]
        .files
        .iter()
        .any(|file| file.contains("shared-cd")));
    assert!(result[3]
        .files
        .iter()
        .any(|file| file.contains("shared-cd")));
    assert!(!result[3]
        .files
        .iter()
        .any(|file| file.contains("shared-ab")));
    Ok(())
}

#[test]
fn off_mode_empty_entries_emit_no_chunks() -> Result<(), Box<dyn std::error::Error>> {
    let result = plan_chunks(PlanChunksInput {
        chunk_mode: "off".to_string(),
        base_chunk_name: "ignored".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![],
        graph_entries: vec![],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    assert!(result.is_empty());
    Ok(())
}

#[test]
fn off_mode_single_entry_walks_its_own_shim_path() -> Result<(), Box<dyn std::error::Error>> {
    let result = plan_chunks(PlanChunksInput {
        chunk_mode: "off".to_string(),
        base_chunk_name: "ignored".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![ChunkPlanEntryInput {
            output_name: "main.js".to_string(),
            source_path: "/workspace/src/main.ts".to_string(),
            shim_path: "/workspace/entries/main.ts".to_string(),
        }],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/entries/main.ts".to_string(),
                dependencies: vec!["/workspace/src/main.ts".to_string()],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/main.ts".to_string(),
                dependencies: vec![],
            },
        ],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].name, "main");
    assert_eq!(result[0].output_name.as_deref(), Some("main.js"));
    assert_eq!(
        result[0].files.iter().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from(["entries/main.ts".to_string(), "src/main.ts".to_string(),])
    );
    Ok(())
}

// --- vendor chunk partition ---------------------------------------------

/// Entry -> two app modules and three dependency-originated ones, one per
/// vendor directory shape.
fn vendor_graph() -> (Vec<ChunkPlanEntryInput>, Vec<DependencyGraphEntry>) {
    let entries = vec![ChunkPlanEntryInput {
        output_name: "main.js".to_string(),
        source_path: "/workspace/src/main.ts".to_string(),
        shim_path: "/workspace/entries/main.ts".to_string(),
    }];
    let graph = vec![
        DependencyGraphEntry {
            file_path: "/workspace/src/main.ts".to_string(),
            dependencies: vec![
                "/workspace/src/app.ts".to_string(),
                "/workspace/node_modules/lib/index.js".to_string(),
                "/workspace/.vite/__dep-bundles/dep.js".to_string(),
                "/workspace/__virtual__/style.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/app.ts".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            file_path: "/workspace/node_modules/lib/index.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            file_path: "/workspace/.vite/__dep-bundles/dep.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            file_path: "/workspace/__virtual__/style.js".to_string(),
            dependencies: vec![],
        },
    ];
    (entries, graph)
}

fn plan_vendor(vendor_chunk: bool, chunk_mode: &str) -> Result<Vec<ChunkPlanChunkOutput>, String> {
    let (entries, graph) = vendor_graph();
    plan_chunks(PlanChunksInput {
        chunk_mode: chunk_mode.to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: entries,
        graph_entries: graph,
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk,
    })
}

#[test]
fn vendor_chunk_partitions_dependency_originated_files_and_leads_the_plan(
) -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_vendor(true, "bundler-runtime")?;

    assert_eq!(plan.len(), 2);
    // Vendor is first so it is also the first Closure chunk spec, which is
    // what makes base's generated import edge execute it at startup.
    assert_eq!(plan[0].name, "main-vendor");
    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert!(plan[0].dependencies.is_empty());
    assert_eq!(plan[0].entry_files, None);
    assert_eq!(plan[0].lazy_module_ids, None);
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
    Ok(())
}

#[test]
fn vendor_chunk_excludes_virtual_modules_with_authored_dependencies(
) -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![ChunkPlanEntryInput {
            output_name: "main.js".to_string(),
            source_path: "/workspace/src/main.ts".to_string(),
            shim_path: "/workspace/entries/main.ts".to_string(),
        }],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/src/main.ts".to_string(),
                dependencies: vec!["/workspace/__virtual__/bridge.js".to_string()],
            },
            DependencyGraphEntry {
                file_path: "/workspace/__virtual__/bridge.js".to_string(),
                dependencies: vec!["/workspace/src/value.js".to_string()],
            },
            DependencyGraphEntry {
                file_path: "/workspace/src/value.js".to_string(),
                dependencies: vec![],
            },
        ],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: true,
    })?;

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan[0].dependencies.is_empty());
    assert_eq!(
        plan[0].files,
        vec!["src/value.js", "__virtual__/bridge.js", "src/main.ts",],
    );
    Ok(())
}

#[test]
fn vendor_chunk_never_claims_an_entry_file() -> Result<(), Box<dyn std::error::Error>> {
    // A project whose entry itself sits under a vendor-looking path still
    // owns that file: it is app code by definition, and moving it would put
    // the thing every edit touches into the chunk meant to stay stable.
    let plan = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![ChunkPlanEntryInput {
            output_name: "main.js".to_string(),
            source_path: "/workspace/__virtual__/entry.ts".to_string(),
            shim_path: "/workspace/entries/main.ts".to_string(),
        }],
        graph_entries: vec![
            DependencyGraphEntry {
                file_path: "/workspace/__virtual__/entry.ts".to_string(),
                dependencies: vec!["/workspace/node_modules/lib/index.js".to_string()],
            },
            DependencyGraphEntry {
                file_path: "/workspace/node_modules/lib/index.js".to_string(),
                dependencies: vec![],
            },
        ],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: true,
    })?;

    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert_eq!(plan[0].files, vec!["node_modules/lib/index.js"]);
    assert_eq!(plan[1].files, vec!["__virtual__/entry.ts"]);
    Ok(())
}

#[test]
fn empty_vendor_partition_emits_no_vendor_chunk() -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: vec![ChunkPlanEntryInput {
            output_name: "main.js".to_string(),
            source_path: "/workspace/src/main.ts".to_string(),
            shim_path: "/workspace/entries/main.ts".to_string(),
        }],
        graph_entries: vec![DependencyGraphEntry {
            file_path: "/workspace/src/main.ts".to_string(),
            dependencies: vec![],
        }],
        lazy_imports: vec![],
        rollup_chunks: vec![],
        vendor_chunk: true,
    })?;

    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan[0].dependencies.is_empty());
    Ok(())
}

#[test]
fn vendor_chunk_flag_off_leaves_the_plan_byte_identical() -> Result<(), Box<dyn std::error::Error>>
{
    let off = plan_vendor(false, "bundler-runtime")?;

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
        plan_chunks(PlanChunksInput {
            chunk_mode: "bundler-runtime".to_string(),
            base_chunk_name: "main.js".to_string(),
            workspace_dir: "/workspace".to_string(),
            entry_files: vec![ChunkPlanEntryInput {
                output_name: "main.js".to_string(),
                source_path: "/workspace/src/main.ts".to_string(),
                shim_path: "/workspace/entries/main.ts".to_string(),
            }],
            graph_entries: vec![DependencyGraphEntry {
                file_path: "/workspace/src/main.ts".to_string(),
                dependencies: vec![],
            }],
            lazy_imports: vec![],
            rollup_chunks: vec![],
            vendor_chunk,
        })
        .map(|plan| format!("{plan:?}"))
    };
    assert_eq!(plan_plain(false)?, plan_plain(true)?);
    Ok(())
}

#[test]
fn split_partitions_the_vendor_chunk_exactly_like_bundler_runtime(
) -> Result<(), Box<dyn std::error::Error>> {
    // Split used to ignore the flag because plain-script chunks have no import
    // edge to order vendor before base. It is on the shared import-edge chunk
    // graph now, so the partition must be identical to `bundler-runtime` --
    // and must still be opt-in.
    assert_eq!(
        format!("{:?}", plan_vendor(true, "split")?),
        format!("{:?}", plan_vendor(true, "bundler-runtime")?),
    );
    assert_eq!(
        format!("{:?}", plan_vendor(false, "split")?),
        format!("{:?}", plan_vendor(false, "bundler-runtime")?),
    );
    assert_ne!(
        format!("{:?}", plan_vendor(true, "split")?),
        format!("{:?}", plan_vendor(false, "split")?),
    );
    Ok(())
}

#[test]
fn vendor_chunk_coexists_with_shared_and_lazy_chunks() -> Result<(), Box<dyn std::error::Error>> {
    let (entries, mut graph) = vendor_graph();
    graph.push(DependencyGraphEntry {
        file_path: "/workspace/src/panel.ts".to_string(),
        dependencies: vec!["/workspace/src/panel-only.ts".to_string()],
    });
    graph.push(DependencyGraphEntry {
        file_path: "/workspace/src/panel-only.ts".to_string(),
        dependencies: vec![],
    });
    let plan = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "main.js".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: entries,
        graph_entries: graph,
        lazy_imports: vec![LazyImportEntry {
            importer_file_path: "/workspace/src/main.ts".to_string(),
            module_id: "gcc.src.panel".to_string(),
            specifier: "./panel".to_string(),
            target_path: "/workspace/src/panel.ts".to_string(),
        }],
        rollup_chunks: vec![],
        vendor_chunk: true,
    })?;

    assert_eq!(plan[0].kind.as_deref(), Some("vendor"));
    assert_eq!(plan[1].kind.as_deref(), Some("base"));
    assert_eq!(plan[1].dependencies, vec!["main-vendor"]);
    let lazy = plan
        .iter()
        .find(|chunk| chunk.kind.as_deref() == Some("lazy"))
        .ok_or("lazy chunk")?;
    // Lazy chunks keep their existing dependency lists: Closure chunk deps
    // are transitive, and a panel reaches vendor through base. Verified
    // against the real compiler - a panel referencing a vendor symbol with
    // only a base dependency compiles clean and inlines correctly.
    assert_eq!(lazy.dependencies, vec!["main"]);
    Ok(())
}

#[test]
fn dotted_module_names_still_probe_extensions() -> Result<(), Box<dyn std::error::Error>> {
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
    Ok(())
}

#[test]
fn multi_dot_module_names_probe_extensions() -> Result<(), Box<dyn std::error::Error>> {
    let candidates = super::module_candidates(Path::new("/w/decorator_nested_scope.decorated"))
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(
        candidates.contains(&"/w/decorator_nested_scope.decorated.ts".to_string()),
        "{candidates:?}"
    );
    Ok(())
}

#[test]
fn a_real_js_extension_is_not_shadowed_by_an_appended_one() -> Result<(), Box<dyn std::error::Error>>
{
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
    Ok(())
}

#[test]
fn materialized_dependency_bundle_commonjs_is_allowed_by_signed_marker(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    let bundle_contents = "module.exports = 7;\n";
    temp_dir.write("src/__dep-bundles/eager/generated.js", bundle_contents)?;
    let hash = hash_content(bundle_contents);
    temp_dir.write("src/__dep-bundles/.gcc-ts-bundler-materialized-dependency-bundles.json",
    &format!(
        r#"{{"files":[{{"path":"eager/generated.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
    ),)?;
    temp_dir.write(
        "src/index.js",
        "import value from \"./__dep-bundles/eager/generated.js\"; export default value;\n",
    )?;

    let result = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    );

    assert!(result.is_ok(), "{result:?}");
    Ok(())
}

#[test]
fn authored_commonjs_stays_rejected_without_materialized_marker(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    temp_dir.write("src/authored.js", "module.exports = 7;\n")?;
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("authored CommonJS must remain rejected")?;

    assert!(error.contains("CommonJS is only supported"), "{error}");
    Ok(())
}

#[test]
fn authored_commonjs_rejects_forged_source_root_marker() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    let contents = "module.exports = 7;\n";
    let hash = hash_content(contents);
    temp_dir.write("src/authored.js", contents)?;
    temp_dir.write("src/.gcc-ts-bundler-materialized-dependency-bundles.json",
    &format!(
        r#"{{"files":[{{"path":"authored.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
    ),)?;
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("a source-root marker must not authorize authored CommonJS")?;

    assert!(error.contains("CommonJS is only supported"), "{error}");
    Ok(())
}

#[test]
fn dependency_bundle_marker_rejects_entries_outside_its_root(
) -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TestDir::new()?;
    let contents = "module.exports = 7;\n";
    let hash = hash_content(contents);
    temp_dir.write("src/authored.js", contents)?;
    temp_dir.write("src/__dep-bundles/.gcc-ts-bundler-materialized-dependency-bundles.json",
    &format!(
        r#"{{"files":[{{"path":"../authored.js","sha256":"{hash}"}}],"kind":"gcc-ts-bundler-materialized-dependency-bundles","version":1}}"#,
    ),)?;
    temp_dir.write(
        "src/index.js",
        "import value from \"./authored.js\"; export default value;\n",
    )?;

    let error = resolve_graph(
        vec![temp_dir.join("src/index.js").to_string_lossy().to_string()],
        temp_dir.join("src").to_string_lossy().to_string(),
        temp_dir.path.to_string_lossy().to_string(),
        "esm-only".to_string(),
    )
    .err()
    .ok_or("a bundle marker must not authorize paths outside __dep-bundles")?;

    assert!(error.contains("CommonJS is only supported"), "{error}");
    Ok(())
}

#[test]
fn every_known_module_extension_suppresses_appending() -> Result<(), Box<dyn std::error::Error>> {
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
    Ok(())
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
        output_name: "index.js".to_string(),
        source_path: "/workspace/src/main.js".to_string(),
        shim_path: "/workspace/entries/index.ts".to_string(),
    }];
    let graph = vec![
        DependencyGraphEntry {
            file_path: "/workspace/entries/index.ts".to_string(),
            dependencies: vec!["/workspace/src/main.js".to_string()],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/main.js".to_string(),
            dependencies: vec![
                "/workspace/src/atom.js".to_string(),
                "/workspace/src/polyfill.js".to_string(),
                "/workspace/src/ui.js".to_string(),
                "/workspace/node_modules/lib/index.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/ui.js".to_string(),
            dependencies: vec!["/workspace/node_modules/lib/index.js".to_string()],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/shared.js".to_string(),
            dependencies: vec!["/workspace/src/atom.js".to_string()],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/route-a.js".to_string(),
            dependencies: vec![
                "/workspace/src/shared.js".to_string(),
                "/workspace/src/ui.js".to_string(),
            ],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/route-b.js".to_string(),
            dependencies: vec!["/workspace/src/shared.js".to_string()],
        },
        DependencyGraphEntry {
            file_path: "/workspace/node_modules/lib/index.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/atom.js".to_string(),
            dependencies: vec![],
        },
        DependencyGraphEntry {
            file_path: "/workspace/src/polyfill.js".to_string(),
            dependencies: vec![],
        },
    ];
    let lazy_imports = vec![
        LazyImportEntry {
            importer_file_path: "/workspace/src/main.js".to_string(),
            module_id: "gcc.src.route-a".to_string(),
            specifier: "./route-a.js".to_string(),
            target_path: "/workspace/src/route-a.js".to_string(),
        },
        LazyImportEntry {
            importer_file_path: "/workspace/src/main.js".to_string(),
            module_id: "gcc.src.route-b".to_string(),
            specifier: "./route-b.js".to_string(),
            target_path: "/workspace/src/route-b.js".to_string(),
        },
    ];
    let rollup_chunk = |name: &str,
                        file_name: &str,
                        is_entry: bool,
                        module_files: &[&str],
                        imports: &[&str]| RollupChunkInput {
        file_name: file_name.to_string(),
        imported_chunk_file_names: imports.iter().map(|value| (*value).to_string()).collect(),
        is_entry,
        module_files: module_files
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
        ),
        rollup_chunk(
            "vendor",
            "vendor-bbbb.js",
            false,
            &["/workspace/node_modules/lib/index.js"],
            &[],
        ),
        rollup_chunk(
            "ui",
            "ui-cccc.js",
            false,
            &["/workspace/src/ui.js"],
            &["vendor-bbbb.js"],
        ),
        rollup_chunk(
            "shared",
            "shared-dddd.js",
            false,
            &["/workspace/src/shared.js"],
            &["vendor-bbbb.js"],
        ),
        rollup_chunk(
            "route-a",
            "route-a-eeee.js",
            false,
            &["/workspace/src/route-a.js"],
            &["shared-dddd.js", "ui-cccc.js"],
        ),
        rollup_chunk(
            "route-b",
            "route-b-ffff.js",
            false,
            &["/workspace/src/route-b.js"],
            &["shared-dddd.js"],
        ),
        rollup_chunk(
            "polyfill",
            "polyfill-gggg.js",
            false,
            &["/workspace/src/polyfill.js"],
            &[],
        ),
    ];
    (entries, graph, lazy_imports, rollup_chunks)
}

fn plan_mirror(rollup_chunks: Vec<RollupChunkInput>) -> Result<Vec<ChunkPlanChunkOutput>, String> {
    let (entries, graph, lazy_imports, _) = mirror_fixture();
    plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "index".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: entries,
        graph_entries: graph,
        lazy_imports,
        rollup_chunks,
        vendor_chunk: false,
    })
}

#[test]
fn mirrored_plan_reproduces_the_rollup_chunk_graph() -> Result<(), Box<dyn std::error::Error>> {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks)?;
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
        by_name["index"].entry_files.as_deref(),
        Some(["src/main.js".to_string()].as_slice())
    );
    assert!(plan
        .iter()
        .filter(|chunk| chunk.name != "index")
        .all(|chunk| chunk.entry_files.is_none()));

    // Rollup's dynamic imports become lazy roots that pruning can never erase.
    assert_eq!(by_name["route-a"].kind.as_deref(), Some("lazy"));
    assert_eq!(
        by_name["route-a"].lazy_module_ids.as_deref(),
        Some(["gcc.src.route-a".to_string()].as_slice())
    );
    assert_eq!(by_name["route-b"].kind.as_deref(), Some("lazy"));
    // A plain shared chunk keeps neither kind nor lazy ids, so an empty one is
    // still prunable.
    assert_eq!(by_name["shared"].kind, None);
    assert_eq!(by_name["shared"].lazy_module_ids, None);
    Ok(())
}

#[test]
fn mirrored_plan_gives_multi_root_rollup_graphs_one_closure_root(
) -> Result<(), Box<dyn std::error::Error>> {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks)?;

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
    Ok(())
}

#[test]
fn mirrored_plan_places_unassigned_files_at_the_deepest_shared_ancestor(
) -> Result<(), Box<dyn std::error::Error>> {
    let (_, _, _, rollup_chunks) = mirror_fixture();
    let plan = plan_mirror(rollup_chunks)?;
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
    Ok(())
}

#[test]
fn mirrored_plan_rejects_a_cyclic_rollup_chunk_graph() -> Result<(), Box<dyn std::error::Error>> {
    let (entries, graph, lazy_imports, mut rollup_chunks) = mirror_fixture();
    // Closure chunk dependencies are a DAG; a cycle has no legal ordering.
    rollup_chunks[1]
        .imported_chunk_file_names
        .push("ui-cccc.js".to_string());
    let error = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "index".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: entries,
        graph_entries: graph,
        lazy_imports,
        rollup_chunks,
        vendor_chunk: false,
    })
    .err()
    .ok_or("a cyclic chunk graph has no topological order")?;

    assert!(error.contains("import cycle"), "{error}");
    Ok(())
}

#[test]
fn absent_rollup_chunks_keep_the_standalone_lazy_planner() -> Result<(), Box<dyn std::error::Error>>
{
    let (entries, graph, lazy_imports, _) = mirror_fixture();
    let plan = plan_chunks(PlanChunksInput {
        chunk_mode: "bundler-runtime".to_string(),
        base_chunk_name: "index".to_string(),
        workspace_dir: "/workspace".to_string(),
        entry_files: entries,
        graph_entries: graph,
        lazy_imports,
        rollup_chunks: vec![],
        vendor_chunk: false,
    })?;

    assert_eq!(plan[0].name, "index");
    assert_eq!(plan[0].kind.as_deref(), Some("base"));
    assert!(plan
        .iter()
        .any(|chunk| chunk.kind.as_deref() == Some("lazy")));
    Ok(())
}
