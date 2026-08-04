use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn make_temp_dir(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn emitted_type_metadata(
    path: &Path,
    counts: crate::closure_metadata::TypeMetadataCounts,
) -> crate::closure_metadata::EmittedTypeMetadata {
    crate::closure_metadata::EmittedTypeMetadata::new(
        path.to_string_lossy().to_string(),
        counts,
        Vec::new(),
    )
}

#[test]
fn prepares_bundler_runtime_jobs_with_runtime_assets() {
    let root = make_temp_dir("bundler-runtime-jobs");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(&emitted_out_dir).unwrap();
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-externs")).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(
        emitted_out_dir.join("src/main.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=boot; }});\n",
            to_bundler_runtime_module_id("gcc.src.main")
        ),
    )
    .unwrap();
    fs::write(
        emitted_out_dir.join("src/feature.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=renderMessage; }});\n",
            to_bundler_runtime_module_id("gcc.src.feature")
        ),
    )
    .unwrap();
    fs::write(
        package_root.join("closure-externs/runtime.js"),
        "/** @externs */\nWindow.prototype.external;\n",
    )
    .unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    fs::write(package_root.join("closure-lib/reflect.js"), "").unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(
        &native_extern,
        "/** @externs */\nWindow.prototype.nativeKeep;\n",
    )
    .unwrap();

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "bundler-runtime".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "script".to_string(),
        chunkPlan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entryFiles: Some(vec!["src/main.ts".to_string()]),
                files: vec!["src/main.ts".to_string()],
                kind: Some("base".to_string()),
                lazyModuleIds: None,
                name: "main".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["main".to_string()],
                entryFiles: None,
                files: vec!["src/feature.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazyModuleIds: Some(vec!["gcc.src.feature".to_string()]),
                name: "src-feature-lazy".to_string(),
            },
        ],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: "chunk-map.json".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![
            emitted_type_metadata(
                &emitted_out_dir.join("src/main.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    annotationCount: 1,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &emitted_out_dir.join("src/feature.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    enumDeclarationCount: 1,
                    memberAnnotationCount: 2,
                    unresolvedTypeReferenceCount: 2,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &emitted_out_dir.join("src/not-in-job.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    typeDeclarationCount: 9,
                    ..Default::default()
                },
            ),
        ],
    })
    .unwrap();

    assert_eq!(output.compileJobs.len(), 1);
    assert_eq!(output.postprocessActions.len(), 2);
    assert!(output.compileJobs[0].hasTypeMetadata);
    assert_eq!(
        output.compileJobs[0].typeMetadataCounts,
        crate::closure_metadata::TypeMetadataCounts {
            annotationCount: 1,
            enumDeclarationCount: 1,
            memberAnnotationCount: 2,
            typeDeclarationCount: 0,
            unresolvedTypeReferenceCount: 2,
        }
    );
    assert!(output
        .publishedOutputs
        .iter()
        .any(|path| path.ends_with("chunk-map.json")));
    assert!(output.generatedAssets.iter().any(|asset| {
        asset.path.ends_with("chunk-map.json")
            && asset.text.contains("\"baseChunk\": \"c")
            && asset.text.contains("\"css\": []")
            && asset.text.contains("\"modules\": [")
    }));
    assert!(output.generatedAssets.iter().any(|asset| {
        asset.path.ends_with("main.linked.js")
            && !asset.text.contains("__gcc_runtime__")
            && !asset.text.contains("initialized")
            // Neither fixture module preloads, so the preload alias is gated
            // out of the line along with `r.x` itself.
            && asset.text.contains(
                "var __runtime=globalThis[\"__g\"],__register=__runtime.r,__require=__runtime.q,__dynamicImport=__runtime.j;",
            )
            && !asset
                .text
                .contains("(function(__require,__dynamicImport,__preloadDynamicImport){")
            && asset.text.contains("__runtime.l(")
            && asset.text.contains("__runtime.n(")
            && !asset.text.contains("global.fetch(")
            && !asset.text.contains("__register(\"m")
    }));
    let lazy_asset = output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with("src-feature-lazy.linked.js"))
        .expect("lazy linked chunk");
    assert!(!lazy_asset.text.contains("__runtime.h("), "{lazy_asset:?}");
    assert!(
        lazy_asset.text.trim_end().ends_with("__runtime.l(1);"),
        "{lazy_asset:?}"
    );

    assert!(output.compileJobs[0].chunk.is_some());
    assert!(output.compileJobs[0]
        .propertyRenamingReportPath
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt")));
    assert!(!output.compileJobs[0]
        .externs
        .iter()
        .any(|file| file.ends_with("runtime-shared.externs.js")));
    assert!(output
        .postprocessActions
        .iter()
        .all(|action| action.kind == "copy"));
}

#[test]
fn skips_es5_custom_elements_adapter_when_no_native_dom_subclasses_exist() {
    let root = make_temp_dir("off-no-es5-adapter");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(
        emitted_out_dir.join("src/entry.js"),
        "goog.module(\"gcc.src.entry\");\nexports.value = 1;\n",
    )
    .unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n").unwrap();

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "off".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "script".to_string(),
        chunkPlan: vec![ClosureJobChunkPlanChunkInput {
            dependencies: vec![],
            entryFiles: Some(vec!["src/entry.ts".to_string()]),
            files: vec!["src/entry.ts".to_string()],
            kind: Some("base".to_string()),
            lazyModuleIds: None,
            name: "entry".to_string(),
        }],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT5".to_string(),
        manifestFile: "".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![emitted_type_metadata(
            &emitted_out_dir.join("src/entry.js"),
            crate::closure_metadata::TypeMetadataCounts {
                annotationCount: 1,
                typeDeclarationCount: 1,
                ..Default::default()
            },
        )],
    })
    .unwrap();

    assert!(!output
        .generatedAssets
        .iter()
        .any(|asset| { asset.path.ends_with("custom-elements-es5-adapter.js") }));
    assert!(output.compileJobs[0].hasTypeMetadata);
    assert_eq!(output.compileJobs[0].typeMetadataCounts.annotationCount, 1);
    assert_eq!(
        output.compileJobs[0]
            .typeMetadataCounts
            .typeDeclarationCount,
        1
    );
}

#[test]
fn prepares_off_mode_jobs_and_filters_empty_externs() {
    let root = make_temp_dir("off-jobs");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(
        emitted_out_dir.join("src/shared.js"),
        "goog.module(\"gcc.src.shared\");\nexports.shared = 1;\n",
    )
    .unwrap();
    fs::write(
            emitted_out_dir.join("src/entry-a.js"),
            "goog.module(\"gcc.src.entry_a\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",
        )
        .unwrap();
    fs::write(
            emitted_out_dir.join("src/entry-b.js"),
            "goog.module(\"gcc.src.entry_b\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",
        )
        .unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    let empty_extern = root.join("empty.externs.js");
    let real_extern = root.join("real.externs.js");
    let native_extern = root.join("native.externs.js");
    fs::write(&empty_extern, "/** @externs */\n").unwrap();
    fs::write(
        &real_extern,
        "/** @externs */\nWindow.prototype.userKeep;\n",
    )
    .unwrap();
    fs::write(
        &native_extern,
        "/** @externs */\nWindow.prototype.nativeKeep;\n",
    )
    .unwrap();

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "off".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "script".to_string(),
        chunkPlan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entryFiles: None,
                files: vec!["src/shared.ts".to_string()],
                kind: None,
                lazyModuleIds: None,
                name: "shared".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entryFiles: None,
                files: vec!["src/entry-a.ts".to_string()],
                kind: None,
                lazyModuleIds: None,
                name: "entry-a".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entryFiles: None,
                files: vec!["src/entry-b.ts".to_string()],
                kind: None,
                lazyModuleIds: None,
                name: "entry-b".to_string(),
            },
        ],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: true,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![
            empty_extern.to_string_lossy().to_string(),
            real_extern.to_string_lossy().to_string(),
        ],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: "".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![],
    })
    .unwrap();

    assert_eq!(output.compileJobs.len(), 1);
    assert!(output.compileJobs[0].chunk.is_some());
    assert!(!output.compileJobs[0]
        .externs
        .iter()
        .any(|path| path == &empty_extern.to_string_lossy()));
    assert!(output.compileJobs[0]
        .externs
        .iter()
        .any(|path| path == &real_extern.to_string_lossy()));
    assert_eq!(output.postprocessActions.len(), 3);
    assert!(output.compileJobs[0]
        .propertyRenamingReportPath
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt")));
    assert!(output
        .postprocessActions
        .iter()
        .all(|action| action.kind == "rewrite-gcc-exports"));
}

#[test]
fn prepares_esm_bundler_runtime_jobs() {
    let root = make_temp_dir("bundler-runtime-esm-jobs");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(
        emitted_out_dir.join("src/main.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=__dynamicImport({:?}); }});\n",
            to_bundler_runtime_module_id("gcc.src.main"),
            to_bundler_runtime_module_id("gcc.src.feature"),
        ),
    )
    .unwrap();
    fs::write(
        emitted_out_dir.join("src/feature.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=1; }});\n",
            to_bundler_runtime_module_id("gcc.src.feature")
        ),
    )
    .unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n").unwrap();

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "bundler-runtime".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "esm".to_string(),
        chunkPlan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entryFiles: Some(vec!["src/main.ts".to_string()]),
                files: vec!["src/main.ts".to_string()],
                kind: Some("base".to_string()),
                lazyModuleIds: None,
                name: "main".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["main".to_string()],
                entryFiles: None,
                files: vec!["src/feature.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazyModuleIds: Some(vec!["gcc.src.feature".to_string()]),
                name: "src-feature-lazy".to_string(),
            },
        ],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: String::new(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![],
    })
    .unwrap();

    let job = &output.compileJobs[0];
    assert_eq!(job.chunkOutputType.as_deref(), Some("ES_MODULES"));
    // Closure rejects --rename_prefix_namespace outright under ES_MODULES.
    assert_eq!(job.renamePrefixNamespace, None);

    let base = output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with("main.linked.js"))
        .expect("base linked chunk");
    let lazy = output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with("src-feature-lazy.linked.js"))
        .expect("lazy linked chunk");

    // Per-chunk-unique aliases, declarations and references together.
    assert!(
        base.text
            .contains("var __runtime_0=globalThis[\"__g\"],__register_0=__runtime_0.r,"),
        "{base:?}"
    );
    assert!(base.text.contains("__register_0("), "{base:?}");
    assert!(base.text.contains("__dynamicImport_0("), "{base:?}");
    assert!(
        lazy.text
            .contains("var __runtime_1=globalThis[\"__g\"],__register_1=__runtime_1.r,"),
        "{lazy:?}"
    );
    assert!(lazy.text.contains("__register_1("), "{lazy:?}");
    assert!(
        lazy.text.trim_end().ends_with("__runtime_1.l(1);"),
        "{lazy:?}"
    );
    // No chunk may declare another chunk's alias: that is JSC_IMPORT_ASSIGN.
    assert!(!lazy.text.contains("__register_0"), "{lazy:?}");
    assert!(!base.text.contains("__register_1"), "{base:?}");

    // Loader: relative specifier + native import(), no script injection.
    assert!(base.text.contains("import(b[1])"), "{base:?}");
    assert!(!base.text.contains("createElement(\"script\")"), "{base:?}");
    assert!(!base.text.contains("currentScript"), "{base:?}");
    let lazy_specifier = format!(
        "\"./{}.js\"",
        to_bundler_runtime_chunk_id("src-feature-lazy")
    );
    assert!(base.text.contains(&lazy_specifier), "{base:?}");
}

#[test]
fn elides_runtime_for_single_eager_esm_chunk() {
    let root = make_temp_dir("bundler-runtime-flat-esm");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(
        emitted_out_dir.join("src/main.js"),
        "globalThis.runtimeElisionAnswer = 42;\n",
    )
    .unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n").unwrap();

    let input = PrepareClosureJobsInput {
        chunkMode: "bundler-runtime".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "esm".to_string(),
        chunkPlan: vec![ClosureJobChunkPlanChunkInput {
            dependencies: vec![],
            entryFiles: Some(vec!["src/main.ts".to_string()]),
            files: vec!["src/main.ts".to_string()],
            kind: Some("base".to_string()),
            lazyModuleIds: None,
            name: "main".to_string(),
        }],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: "chunk-map.json".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "/app/".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![],
    };
    let output = prepare_closure_jobs(input.clone()).unwrap();

    let base = output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with("main.linked.js"))
        .expect("base linked chunk");
    // Closure still sees the established runtime-shaped input so removing the
    // dead envelope cannot perturb optimization/name allocation in the app
    // body. The native capability gate marks the one published base output for
    // structurally validated post-Closure stripping.
    assert!(base.text.contains("globalThis[\"__g\"]"), "{base:?}");
    assert!(base.text.contains("runtimeElisionAnswer"), "{base:?}");
    assert_eq!(output.postprocessActions.len(), 1);
    assert_eq!(output.postprocessActions[0].kind, "strip-bundler-runtime");
    assert!(output
        .generatedAssets
        .iter()
        .any(|asset| asset.path.ends_with("chunk-map.json")));
    assert_eq!(
        output.compileJobs[0].chunkOutputType.as_deref(),
        Some("ES_MODULES")
    );

    let preserved_output = prepare_closure_jobs(PrepareClosureJobsInput {
        hasPreservedModules: true,
        ..input.clone()
    })
    .unwrap();
    assert_eq!(preserved_output.postprocessActions[0].kind, "copy");

    fs::write(
        emitted_out_dir.join("src/main.js"),
        "new Worker('__VITE_WORKER_ASSET__12345678__');\n",
    )
    .unwrap();
    let worker_output = prepare_closure_jobs(input).unwrap();
    assert_eq!(worker_output.postprocessActions[0].kind, "copy");
}

#[test]
fn accepts_esm_output_for_unchunked_mode() {
    let root = make_temp_dir("esm-mode-basic");
    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "off".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "esm".to_string(),
        chunkPlan: vec![],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: root.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: root.join("cache").to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: String::new(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: root.join("n.js").to_string_lossy().to_string(),
        outDir: root.join("dist").to_string_lossy().to_string(),
        packageRoot: root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![],
    })
    .expect("basic builds may request an ESM envelope");
    assert_eq!(
        output.compileJobs[0].chunkOutputType.as_deref(),
        Some("ES_MODULES")
    );
}

// --- vendor chunk assembly ----------------------------------------------

/// vendor -> base -> panel, the shape the vendor plan produces: vendor leads,
/// base depends on it, and the panel depends only on base.
fn prepare_vendor_jobs(label: &str, vendor: bool) -> PrepareClosureJobsOutput {
    let root = make_temp_dir(label);
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(emitted_out_dir.join("node_modules/lib")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    // A registry-form module in vendor: it calls __register at top level, so
    // the aliases must already be usable when vendor executes.
    fs::write(
        emitted_out_dir.join("node_modules/lib/index.js"),
        format!(
            concat!(
                "__register({:?}, function(__require, __exports) {{ __exports[0]=1; }});\n",
                // Shaped like what hoisted emission writes for a vendor module
                // that mutates its own state: the annotation is the channel the
                // pin list is read back out of.
                "/** @noinline */\nfunction set_version$$1(value) {{ version$$1 = value; }}\n",
                "function pure_helper$$1() {{ return version$$1; }}\n",
            ),
            to_bundler_runtime_module_id("gcc.node_modules.lib.index"),
        ),
    )
    .unwrap();
    fs::write(
        emitted_out_dir.join("src/main.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=__require({:?}); }});\n",
            to_bundler_runtime_module_id("gcc.src.main"),
            to_bundler_runtime_module_id("gcc.node_modules.lib.index"),
        ),
    )
    .unwrap();
    fs::write(
        emitted_out_dir.join("src/panel.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=2; }});\n",
            to_bundler_runtime_module_id("gcc.src.panel"),
        ),
    )
    .unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n").unwrap();

    let vendor_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: vec![],
        entryFiles: None,
        files: vec!["node_modules/lib/index.ts".to_string()],
        kind: Some("vendor".to_string()),
        lazyModuleIds: None,
        name: "main-vendor".to_string(),
    };
    let base_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: if vendor {
            vec!["main-vendor".to_string()]
        } else {
            vec![]
        },
        entryFiles: Some(vec!["src/main.ts".to_string()]),
        files: if vendor {
            vec!["src/main.ts".to_string()]
        } else {
            vec![
                "node_modules/lib/index.ts".to_string(),
                "src/main.ts".to_string(),
            ]
        },
        kind: Some("base".to_string()),
        lazyModuleIds: None,
        name: "main".to_string(),
    };
    let panel_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: vec!["main".to_string()],
        entryFiles: None,
        files: vec!["src/panel.ts".to_string()],
        kind: Some("lazy".to_string()),
        lazyModuleIds: Some(vec!["gcc.src.panel".to_string()]),
        name: "src-panel-lazy".to_string(),
    };

    prepare_closure_jobs(PrepareClosureJobsInput {
        chunkMode: "bundler-runtime".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "esm".to_string(),
        chunkPlan: if vendor {
            vec![vendor_chunk, base_chunk, panel_chunk]
        } else {
            vec![base_chunk, panel_chunk]
        },
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: "manifest.json".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![],
    })
    .unwrap()
}

fn linked_chunk_text<'a>(output: &'a PrepareClosureJobsOutput, chunk_name: &str) -> &'a str {
    &output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with(&format!("{chunk_name}.linked.js")))
        .unwrap_or_else(|| panic!("missing linked chunk {chunk_name}"))
        .text
}

#[test]
fn vendor_chunk_leads_the_specs_and_base_depends_on_it() {
    let output = prepare_vendor_jobs("vendor-specs", true);
    let specs = output.compileJobs[0].chunk.as_ref().expect("chunk specs");
    let vendor_id = to_bundler_runtime_chunk_id("main-vendor");
    let base_id = to_bundler_runtime_chunk_id("main");
    let panel_id = to_bundler_runtime_chunk_id("src-panel-lazy");

    // Vendor is spec 0, so it absorbs the leading js inputs and closure-lib
    // files, and base names it as a dependency.
    assert!(specs[0].starts_with(&format!("{vendor_id}:")), "{specs:?}");
    // No dependency suffix: vendor depends on nothing, so exactly one colon.
    assert_eq!(specs[0].matches(':').count(), 1, "{specs:?}");
    assert_eq!(specs[1], format!("{base_id}:1:{vendor_id}"), "{specs:?}");
    // The panel keeps its existing dependency list. Closure chunk deps are
    // transitive, and this was verified against the real compiler: a panel
    // referencing a vendor symbol through base alone compiles clean.
    assert_eq!(specs[2], format!("{panel_id}:1:{base_id}"), "{specs:?}");
}

#[test]
fn vendor_chunk_carries_the_runtime_core_and_base_keeps_the_manifest() {
    let output = prepare_vendor_jobs("vendor-runtime-core", true);
    let vendor = linked_chunk_text(&output, "main-vendor");
    let base = linked_chunk_text(&output, "main");
    let panel = linked_chunk_text(&output, "src-panel-lazy");

    // Vendor executes first (base imports it), so it must build the runtime
    // before its own alias line dereferences it.
    assert!(vendor.contains("r.i=1;"), "{vendor}");
    assert!(vendor.contains("if(!r.i){"), "{vendor}");
    let alias_at = vendor
        .find("var __runtime_0=globalThis[\"__g\"],__register_0=__runtime_0.r,")
        .unwrap_or_else(|| panic!("{vendor}"));
    assert!(vendor.find("r.i=1;").unwrap() < alias_at, "{vendor}");
    assert!(vendor.trim_end().ends_with("__runtime_0.l(0);"), "{vendor}");
    // Vendor must stay app-independent: the manifest holds chunk URLs that
    // change on every app edit, and vendor keeping its filename across app
    // edits is the whole point of the chunk.
    assert!(!vendor.contains("r.a("), "{vendor}");

    // Base runs second and only applies the manifest; re-running the core
    // would be wasted bytes, and the `if(!r.i)` guard makes it a no-op.
    assert!(base.contains("r.a("), "{base}");
    assert!(!base.contains("r.i=1;"), "{base}");
    assert!(!base.contains("if(!r.i){"), "{base}");
    assert!(
        base.contains("var __runtime_1=globalThis[\"__g\"]"),
        "{base}"
    );

    // Ordinary non-base chunks are untouched: no core, no manifest.
    assert!(!panel.contains("r.i=1;"), "{panel}");
    assert!(!panel.contains("r.a("), "{panel}");
    assert!(panel.trim_end().ends_with("__runtime_2.l(2);"), "{panel}");
}

#[test]
fn vendor_chunk_gets_a_manifest_row_with_its_deps_and_no_css() {
    let output = prepare_vendor_jobs("vendor-manifest", true);
    let manifest = &output
        .generatedAssets
        .iter()
        .find(|asset| asset.path.ends_with("manifest.json"))
        .expect("manifest")
        .text;
    let parsed: serde_json::Value = serde_json::from_str(manifest).unwrap();
    let vendor_id = to_bundler_runtime_chunk_id("main-vendor");
    let base_id = to_bundler_runtime_chunk_id("main");
    let vendor_row = &parsed["chunks"][&vendor_id];

    assert_eq!(vendor_row["css"], serde_json::json!([]));
    assert_eq!(vendor_row["deps"], serde_json::json!([]));
    assert_eq!(
        vendor_row["url"],
        serde_json::json!(format!("./{vendor_id}.js"))
    );
    assert_eq!(vendor_row["modules"].as_array().unwrap().len(), 1);
    // Base names vendor, which is the edge the loader relies on.
    assert_eq!(
        parsed["chunks"][&base_id]["deps"],
        serde_json::json!([vendor_id])
    );
    assert_eq!(parsed["baseChunk"], serde_json::json!(base_id));
    // Every module is placed, vendor's included.
    assert_eq!(parsed["modules"].as_object().unwrap().len(), 3);
}

#[test]
fn a_plan_without_a_vendor_chunk_keeps_the_single_combined_preamble() {
    // Regression guard for the flag-off path: base still emits core and
    // manifest as one IIFE, exactly as it always has.
    let output = prepare_vendor_jobs("vendor-absent", false);
    let base = linked_chunk_text(&output, "main");

    assert!(base.contains("if(!r.i){"), "{base}");
    assert!(base.contains("r.i=1;"), "{base}");
    assert!(base.contains("r.a("), "{base}");
    assert_eq!(
        base.matches(").call(this,globalThis);").count(),
        1,
        "{base}"
    );
    let specs = output.compileJobs[0].chunk.as_ref().expect("chunk specs");
    assert!(
        specs[0].starts_with(&format!("{}:", to_bundler_runtime_chunk_id("main"))),
        "{specs:?}"
    );
}

#[test]
fn vendor_chunk_pins_its_annotated_assigners_before_the_load_call() {
    let output = prepare_vendor_jobs("vendor-pin", true);
    let vendor = linked_chunk_text(&output, "main-vendor");

    // Both halves are required: `@noinline` alone still loses to
    // CrossChunkCodeMotion, the pin alone still loses to inlining. Measured
    // on the real failing job, only the pair compiles.
    assert!(vendor.contains("/** @noinline */"), "{vendor}");
    let pin = "__runtime_0.v=[set_version$$1];";
    assert!(vendor.contains(pin), "{vendor}");
    // The pin uses this chunk's own alias and runs as part of the chunk, so
    // it sits between the module text and the trailing `l()`.
    assert!(
        vendor.find(pin).unwrap() < vendor.find("__runtime_0.l(0);").unwrap(),
        "{vendor}"
    );
    assert!(vendor.trim_end().ends_with("__runtime_0.l(0);"), "{vendor}");
    // Only annotated functions are pinned.
    assert!(!vendor.contains("pure_helper$$1]"), "{vendor}");
    assert!(!vendor.contains(",pure_helper$$1"), "{vendor}");
}

#[test]
fn non_vendor_chunks_are_never_pinned() {
    // Motion out of base and lazy chunks is legal and is what keeps them
    // small, so nothing there is pinned even if it carries the annotation.
    let output = prepare_vendor_jobs("vendor-pin-absent", false);
    for chunk_name in ["main", "src-panel-lazy"] {
        let text = linked_chunk_text(&output, chunk_name);
        assert!(!text.contains(".v=["), "{chunk_name}: {text}");
    }

    let split = prepare_vendor_jobs("vendor-pin-split", true);
    let panel = linked_chunk_text(&split, "src-panel-lazy");
    assert!(!panel.contains(".v=["), "{panel}");
}

#[test]
fn split_jobs_aggregate_only_native_emitted_chunk_inputs() {
    let root = make_temp_dir("split-type-metadata");
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src")).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    fs::create_dir_all(package_root.join("closure-lib")).unwrap();
    fs::write(package_root.join("closure-lib/base.js"), "").unwrap();
    let a = emitted_out_dir.join("src/a.js");
    let b = emitted_out_dir.join("src/b.js");
    let explicit = root.join("explicit.js");
    fs::write(&a, "goog.module('gcc.src.a');\n").unwrap();
    fs::write(&b, "goog.module('gcc.src.b');\n").unwrap();
    fs::write(&explicit, "globalThis.explicit = true;\n").unwrap();
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n").unwrap();

    let input = PrepareClosureJobsInput {
        chunkMode: "split".to_string(),
        chunkLoader: "script".to_string(),
        chunkOutputType: "script".to_string(),
        chunkPlan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entryFiles: None,
                files: vec!["src/a.ts".to_string()],
                kind: Some("base".to_string()),
                lazyModuleIds: None,
                name: "a".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["a".to_string()],
                entryFiles: None,
                files: vec!["src/b.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazyModuleIds: None,
                name: "b".to_string(),
            },
        ],
        compilationLevel: "ADVANCED".to_string(),
        diagnosticsVerbose: false,
        emittedOutDir: emitted_out_dir.to_string_lossy().to_string(),
        explicitExternPaths: vec![],
        explicitJsInputs: vec![explicit.to_string_lossy().to_string()],
        finalCacheDir: final_cache_dir.to_string_lossy().to_string(),
        generatedExternPaths: vec![],
        languageOut: "ECMASCRIPT_NEXT".to_string(),
        manifestFile: "".to_string(),
        hasPreservedModules: false,
        needsCssRuntime: false,
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
        typeMetadata: vec![
            emitted_type_metadata(
                &a,
                crate::closure_metadata::TypeMetadataCounts {
                    annotationCount: 2,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &b,
                crate::closure_metadata::TypeMetadataCounts {
                    typeDeclarationCount: 1,
                    unresolvedTypeReferenceCount: 3,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &explicit,
                crate::closure_metadata::TypeMetadataCounts {
                    enumDeclarationCount: 7,
                    ..Default::default()
                },
            ),
        ],
    };
    let output = prepare_closure_jobs(input.clone()).unwrap();
    let job = &output.compileJobs[0];
    assert!(job.hasTypeMetadata);
    assert_eq!(job.typeMetadataCounts.annotationCount, 2);
    assert_eq!(job.typeMetadataCounts.typeDeclarationCount, 1);
    assert_eq!(job.typeMetadataCounts.enumDeclarationCount, 0);
    assert_eq!(job.typeMetadataCounts.unresolvedTypeReferenceCount, 3);

    let mut invalid = input;
    invalid.typeMetadata[0].hasTypeMetadata = false;
    let error = prepare_closure_jobs(invalid).expect_err("derived boolean is authoritative");
    assert!(
        error.contains("Invalid emitted type metadata boolean"),
        "{error}"
    );
}
