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
        "__exports[\"boot\"]=boot;\n",
    )
    .unwrap();
    fs::write(
        emitted_out_dir.join("src/feature.js"),
        "__exports[\"renderMessage\"]=renderMessage;\n",
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
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
    })
    .unwrap();

    assert_eq!(output.compileJobs.len(), 1);
    assert_eq!(output.postprocessActions.len(), 2);
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
            && asset
                .text
                .contains("var __runtime=globalThis[\"__g\"],__register=__runtime.r;")
            && asset.text.contains("__runtime.l(")
            && asset.text.contains("__runtime.n(")
            && !asset.text.contains("global.fetch(")
            && !asset.text.contains("__register(\"m")
    }));
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
        .all(|action| action.kind == "rewrite-decorator-metadata"));
    assert!(output.postprocessActions.iter().all(|action| action
        .propertyRenamingReportPath
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt"))));
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
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
    })
    .unwrap();

    assert!(!output.generatedAssets.iter().any(|asset| {
        asset.path.ends_with("custom-elements-es5-adapter.js")
    }));
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
        nativeExternPath: native_extern.to_string_lossy().to_string(),
        outDir: out_dir.to_string_lossy().to_string(),
        packageRoot: package_root.to_string_lossy().to_string(),
        publicPath: "./".to_string(),
        supportFiles: vec![],
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
        .all(|action| action.kind == "rewrite-gcc-exports-and-decorator-metadata"));
    assert!(output.postprocessActions.iter().all(|action| action
        .propertyRenamingReportPath
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt"))));
}
