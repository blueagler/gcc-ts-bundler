use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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
        vec![
            "/workspace/entries/first.ts".to_string(),
            "/workspace/entries/second.ts".to_string(),
        ],
    )
    .unwrap();

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].name, "shared");
    assert_eq!(result[1].dependencies, vec!["shared"]);
    assert_eq!(result[2].dependencies, vec!["shared"]);
}
