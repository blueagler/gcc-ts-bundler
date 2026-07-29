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
        vec![
            "/workspace/entries/first.ts".to_string(),
            "/workspace/entries/second.ts".to_string(),
        ],
        false,
    )
    .unwrap();

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].name, "shared");
    assert_eq!(result[1].dependencies, vec!["shared"]);
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
                vendor_chunk,
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
