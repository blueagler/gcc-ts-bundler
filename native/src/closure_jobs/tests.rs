use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::pathing::{to_bundler_runtime_chunk_id, to_bundler_runtime_module_id};

use super::{
    prepare_closure_jobs, ClosureJobChunkPlanChunkInput, PrepareClosureJobsInput,
    PrepareClosureJobsOutput,
};

fn make_temp_dir(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let dir = std::env::temp_dir().join(format!("gcc-ts-bundler-{label}-{unique}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn emitted_type_metadata(
    path: &Path,
    counts: crate::closure_metadata::TypeMetadataCounts,
) -> super::ClosureJobTypeMetadata {
    super::ClosureJobTypeMetadata {
        emitted_file: path.to_string_lossy().to_string(),
        counts,
    }
}

#[test]
fn prepares_bundler_runtime_jobs_with_runtime_assets() -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("bundler-runtime-jobs")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(&emitted_out_dir)?;
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-externs"))?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(
        emitted_out_dir.join("src/main.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=boot; }});\n",
            to_bundler_runtime_module_id("gcc.src.main")
        ),
    )?;
    fs::write(
        emitted_out_dir.join("src/feature.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=renderMessage; }});\n",
            to_bundler_runtime_module_id("gcc.src.feature")
        ),
    )?;
    fs::write(
        package_root.join("closure-externs/runtime.js"),
        "/** @externs */\nWindow.prototype.external;\n",
    )?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    fs::write(package_root.join("closure-lib/reflect.js"), "")?;
    let native_extern = root.join("native.externs.js");
    fs::write(
        &native_extern,
        "/** @externs */\nWindow.prototype.nativeKeep;\n",
    )?;

    let explicit = root.join("explicit.js").to_string_lossy().to_string();
    fs::write(&explicit, "/* goog.module('external'); tslib */")?;
    let input = PrepareClosureJobsInput {
        chunk_mode: "bundler-runtime".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "script".to_string(),
        chunk_plan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: Some(vec!["src/main.ts".to_string()]),
                files: vec!["src/main.ts".to_string()],
                kind: Some("base".to_string()),
                lazy_module_ids: None,
                name: "main".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["main".to_string()],
                entry_files: None,
                files: vec!["src/feature.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazy_module_ids: Some(vec!["gcc.src.feature".to_string()]),
                name: "src-feature-lazy".to_string(),
            },
        ],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![explicit],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: "chunk-map.json".to_string(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![
            emitted_type_metadata(
                &emitted_out_dir.join("src/main.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    annotations: 1,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &emitted_out_dir.join("src/feature.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    enum_declarations: 1,
                    member_annotations: 2,
                    unresolved_type_references: 2,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &emitted_out_dir.join("src/not-in-job.js"),
                crate::closure_metadata::TypeMetadataCounts {
                    type_declarations: 9,
                    ..Default::default()
                },
            ),
        ],
    };
    let typed_main = root.join("typed-main.js").to_string_lossy().to_string();
    let typed_feature = root.join("typed-feature.js").to_string_lossy().to_string();
    fs::write(&typed_main, "/** @externs */\nvar mainContract;\n")?;
    fs::write(&typed_feature, "/** @externs */\nvar featureContract;\n")?;
    let mut scoped_input = input.clone();
    scoped_input.chunk_plan[0].entry_files = Some(vec![
        "src/main.ts".to_string(),
        "src/feature.ts".to_string(),
    ]);
    scoped_input.generated_externs = vec![
        super::GeneratedExternInput {
            path: typed_main.clone(),
            entry_files: vec!["src/main.ts".to_string()],
        },
        super::GeneratedExternInput {
            path: typed_feature.clone(),
            entry_files: vec!["src/feature.ts".to_string()],
        },
    ];
    let scoped_output = prepare_closure_jobs(scoped_input)?;
    assert_eq!(scoped_output.compile_jobs.len(), 1);
    assert_eq!(
        scoped_output.compile_jobs[0].externs,
        [
            package_root
                .join("closure-externs/runtime.js")
                .to_string_lossy()
                .to_string(),
            typed_main,
            typed_feature,
            native_extern.to_string_lossy().to_string(),
        ],
    );

    let output = prepare_closure_jobs(input.clone())?;
    assert!(!output.compile_jobs[0].js.iter().any(|path| {
        Path::new(path).parent() == Some(package_root.join("closure-lib").as_path())
    }));

    fs::write(
        emitted_out_dir.join("src/feature.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=goog.reflect.objectProperty('renderMessage', {{}}); }});",
            to_bundler_runtime_module_id("gcc.src.feature"),
        ),
    )?;
    let output = prepare_closure_jobs(input)?;
    let helper_inputs = output.compile_jobs[0]
        .js
        .iter()
        .filter(|path| Path::new(path).parent() == Some(package_root.join("closure-lib").as_path()))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        helper_inputs,
        ["base.js", "reflect.js"].map(|name| package_root
            .join("closure-lib")
            .join(name)
            .to_string_lossy()
            .to_string()),
    );
    assert!(output.generated_assets.iter().any(|asset| {
        asset.path.ends_with("src-feature-lazy.linked.js")
            && asset.text.contains("goog.reflect.objectProperty")
            && !Path::new(&asset.path).exists()
    }));

    assert_eq!(output.compile_jobs.len(), 1);
    assert_eq!(output.postprocess_actions.len(), 2);
    assert!(output.compile_jobs[0].has_type_metadata);
    assert_eq!(
        output.compile_jobs[0].type_metadata_counts,
        crate::closure_metadata::TypeMetadataCounts {
            annotations: 1,
            enum_declarations: 1,
            member_annotations: 2,
            type_declarations: 0,
            unresolved_type_references: 2,
        }
    );
    assert!(output
        .published_outputs
        .iter()
        .any(|path| path.ends_with("chunk-map.json")));
    assert!(output.generated_assets.iter().any(|asset| {
        asset.path.ends_with("chunk-map.json")
            && asset.text.contains("\"baseChunk\": \"c")
            && asset.text.contains("\"css\": []")
            && asset.text.contains("\"modules\": [")
    }));
    assert!(output.generated_assets.iter().any(|asset| {
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
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with("src-feature-lazy.linked.js"))
        .ok_or("lazy linked chunk")?;
    assert!(!lazy_asset.text.contains("__runtime.h("), "{lazy_asset:?}");
    assert!(
        lazy_asset.text.trim_end().ends_with("__runtime.l(1);"),
        "{lazy_asset:?}"
    );

    assert!(output.compile_jobs[0].chunk.is_some());
    assert!(output.compile_jobs[0]
        .property_renaming_report_path
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt")));
    assert!(!output.compile_jobs[0]
        .externs
        .iter()
        .any(|file| file.ends_with("runtime-shared.externs.js")));
    assert!(output
        .postprocess_actions
        .iter()
        .all(|action| action.kind == "copy"));
    Ok(())
}

#[test]
fn selects_custom_elements_adapter_only_for_legacy_native_dom_subclasses(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("off-no-es5-adapter")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(
        emitted_out_dir.join("src/entry.js"),
        "goog.module(\"gcc.src.entry\");\nexports.value = 1;\n",
    )?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let mut input = PrepareClosureJobsInput {
        chunk_mode: "off".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "script".to_string(),
        chunk_plan: vec![ClosureJobChunkPlanChunkInput {
            dependencies: vec![],
            entry_files: Some(vec!["src/entry.ts".to_string()]),
            files: vec!["src/entry.ts".to_string()],
            kind: Some("base".to_string()),
            lazy_module_ids: None,
            name: "entry".to_string(),
        }],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT5".to_string(),
        manifest_file: String::new(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![emitted_type_metadata(
            &emitted_out_dir.join("src/entry.js"),
            crate::closure_metadata::TypeMetadataCounts {
                annotations: 1,
                type_declarations: 1,
                ..Default::default()
            },
        )],
    };
    let output = prepare_closure_jobs(input.clone())?;

    assert!(!output
        .generated_assets
        .iter()
        .any(|asset| { asset.path.ends_with("custom-elements-es5-adapter.js") }));
    assert!(output.compile_jobs[0].has_type_metadata);
    assert_eq!(output.compile_jobs[0].type_metadata_counts.annotations, 1);
    assert_eq!(
        output.compile_jobs[0]
            .type_metadata_counts
            .type_declarations,
        1
    );
    fs::write(
        emitted_out_dir.join("src/entry.js"),
        "goog.module('gcc.src.entry'); exports.Element = class extends HTMLElement {};",
    )?;
    for (language_out, needs_adapter) in [
        ("ECMASCRIPT3", true),
        ("ECMASCRIPT5", true),
        ("ECMASCRIPT_NEXT", false),
    ] {
        input.language_out = language_out.to_string();
        let output = prepare_closure_jobs(input.clone())?;
        assert_eq!(
            output
                .generated_assets
                .iter()
                .any(|asset| { asset.path.ends_with("custom-elements-es5-adapter.js") }),
            needs_adapter,
        );
        assert_eq!(
            output.compile_jobs[0]
                .js
                .iter()
                .any(|path| { path.ends_with("custom-elements-es5-adapter.js") }),
            needs_adapter,
        );
    }
    Ok(())
}

#[test]
fn prepares_off_mode_jobs_and_filters_empty_externs() -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("off-jobs")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(
        emitted_out_dir.join("src/shared.js"),
        "goog.module(\"gcc.src.shared\");\nexports.shared = 1;\n",
    )?;
    fs::write(emitted_out_dir.join("src/entry-a.js"),
    "goog.module(\"gcc.src.entry_a\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",)?;
    fs::write(emitted_out_dir.join("src/entry-b.js"),
    "goog.module(\"gcc.src.entry_b\");\nconst shared = goog.require(\"gcc.src.shared\");\nexports.value = shared.shared;\n",)?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    let empty_extern = root.join("empty.externs.js");
    let real_extern = root.join("real.externs.js");
    let native_extern = root.join("native.externs.js");
    fs::write(&empty_extern, "/** @externs */\n")?;
    fs::write(
        &real_extern,
        "/** @externs */\nWindow.prototype.userKeep;\n",
    )?;
    fs::write(
        &native_extern,
        "/** @externs */\nWindow.prototype.nativeKeep;\n",
    )?;

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunk_mode: "off".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "script".to_string(),
        chunk_plan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: None,
                files: vec!["src/shared.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "shared".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entry_files: None,
                files: vec!["src/entry-a.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-a".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entry_files: None,
                files: vec!["src/entry-b.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-b".to_string(),
            },
        ],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: true,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![
            empty_extern.to_string_lossy().to_string(),
            real_extern.to_string_lossy().to_string(),
        ],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: String::new(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![],
    })?;

    assert_eq!(output.compile_jobs.len(), 1);
    assert!(output.compile_jobs[0].chunk.is_some());
    assert!(!output.compile_jobs[0]
        .externs
        .iter()
        .any(|path| path == &empty_extern.to_string_lossy()));
    assert!(output.compile_jobs[0]
        .externs
        .iter()
        .any(|path| path == &real_extern.to_string_lossy()));
    assert_eq!(output.postprocess_actions.len(), 3);
    assert!(output.compile_jobs[0]
        .property_renaming_report_path
        .as_deref()
        .is_some_and(|path| path.ends_with("property-renaming-report.txt")));
    assert!(output
        .postprocess_actions
        .iter()
        .all(|action| action.kind == "rewrite-gcc-exports"));
    Ok(())
}

#[test]
fn prepares_off_mode_jobs_for_disjoint_share_groups() -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("off-jobs-disjoint")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    for (name, module) in [
        ("shared-ab", "gcc.src.shared_ab"),
        ("entry-a", "gcc.src.entry_a"),
        ("entry-b", "gcc.src.entry_b"),
        ("shared-cd", "gcc.src.shared_cd"),
        ("entry-c", "gcc.src.entry_c"),
        ("entry-d", "gcc.src.entry_d"),
    ] {
        fs::write(
            emitted_out_dir.join(format!("src/{name}.js")),
            format!("goog.module(\"{module}\");\nexports.value = 1;\n"),
        )?;
    }
    fs::write(
        emitted_out_dir.join("src/entry-b.js"),
        "goog.module('gcc.src.entry_b'); goog.reflect.objectProperty('value', {});",
    )?;
    fs::write(
        emitted_out_dir.join("src/entry-d.js"),
        "goog.module('gcc.src.entry_d'); goog.require('tslib');",
    )?;
    for helper in ["base.js", "reflect.js", "tslib.js"] {
        fs::write(package_root.join("closure-lib").join(helper), "")?;
    }
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let input = PrepareClosureJobsInput {
        chunk_mode: "off".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "script".to_string(),
        chunk_plan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: None,
                files: vec!["src/shared-ab.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "shared".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entry_files: None,
                files: vec!["src/entry-a.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-a".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared".to_string()],
                entry_files: None,
                files: vec!["src/entry-b.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-b".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: None,
                files: vec!["src/shared-cd.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "shared2".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared2".to_string()],
                entry_files: None,
                files: vec!["src/entry-c.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-c".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["shared2".to_string()],
                entry_files: None,
                files: vec!["src/entry-d.ts".to_string()],
                kind: None,
                lazy_module_ids: None,
                name: "entry-d".to_string(),
            },
        ],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: String::new(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![],
    };
    let output = prepare_closure_jobs(input.clone())?;
    let helper_names = |job: &super::ClosureCompileJob| {
        job.js
            .iter()
            .filter(|path| {
                Path::new(path).parent() == Some(package_root.join("closure-lib").as_path())
            })
            .map(|path| {
                Path::new(path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .ok_or("missing helper file name")
            })
            .collect::<Result<Vec<_>, _>>()
    };
    assert_eq!(
        helper_names(&output.compile_jobs[0])?,
        ["base.js", "reflect.js"]
    );
    assert_eq!(
        helper_names(&output.compile_jobs[1])?,
        ["base.js", "tslib.js"]
    );

    let explicit = root.join("explicit.js").to_string_lossy().to_string();
    let support = root.join("support.js").to_string_lossy().to_string();
    fs::write(&explicit, "/* tslib */")?;
    fs::write(&support, "/* goog.reflect. */")?;
    let mut with_common_inputs = input.clone();
    with_common_inputs.explicit_js_inputs = vec![explicit.clone(), explicit.clone()];
    let explicit_output = prepare_closure_jobs(with_common_inputs.clone())?;
    assert_eq!(
        helper_names(&explicit_output.compile_jobs[0])?,
        ["base.js", "reflect.js", "tslib.js"],
    );
    assert_eq!(
        helper_names(&explicit_output.compile_jobs[1])?,
        ["base.js", "tslib.js"]
    );
    with_common_inputs.support_files = vec![support.clone(), support.clone()];
    let common_output = prepare_closure_jobs(with_common_inputs)?;
    for job in &common_output.compile_jobs {
        assert_eq!(helper_names(job)?, ["base.js", "reflect.js", "tslib.js"]);
        assert_eq!(job.js.iter().filter(|path| *path == &explicit).count(), 1);
        assert_eq!(job.js.iter().filter(|path| *path == &support).count(), 1);
    }

    let typed_a = root.join("typed-a.js").to_string_lossy().to_string();
    let typed_b = root.join("typed-b.js").to_string_lossy().to_string();
    let typed_c = root.join("typed-c.js").to_string_lossy().to_string();
    let unscoped = root.join("unscoped.js").to_string_lossy().to_string();
    for file in [&typed_a, &typed_b, &typed_c, &unscoped] {
        fs::write(file, "/** @externs */\nvar callerContract;\n")?;
    }
    let mut scoped = input.clone();
    for index in [1, 2, 4, 5] {
        scoped.chunk_plan[index].entry_files = Some(scoped.chunk_plan[index].files.clone());
    }
    scoped.generated_externs = vec![
        super::GeneratedExternInput {
            path: typed_a.clone(),
            entry_files: vec!["src/entry-a.ts".to_string()],
        },
        super::GeneratedExternInput {
            path: typed_b.clone(),
            entry_files: vec!["src/entry-b.ts".to_string()],
        },
        super::GeneratedExternInput {
            path: typed_c.clone(),
            entry_files: vec!["src/entry-c.ts".to_string()],
        },
        super::GeneratedExternInput {
            path: unscoped.clone(),
            entry_files: vec![],
        },
    ];
    let scoped_output = prepare_closure_jobs(scoped.clone())?;
    assert_eq!(
        scoped_output.compile_jobs[0].externs,
        [typed_a.clone(), typed_b.clone(), unscoped.clone()]
    );
    assert_eq!(
        scoped_output.compile_jobs[1].externs,
        [typed_c.clone(), unscoped.clone()]
    );
    assert_eq!(
        scoped_output.compile_jobs[0].entry_point,
        output.compile_jobs[0].entry_point
    );

    let mut independent = scoped.clone();
    independent
        .chunk_plan
        .retain(|chunk| chunk.entry_files.is_some());
    for chunk in &mut independent.chunk_plan {
        chunk.dependencies.clear();
    }
    let independent_output = prepare_closure_jobs(independent.clone())?;
    assert_eq!(
        independent_output
            .compile_jobs
            .iter()
            .map(|job| job.externs.clone())
            .collect::<Vec<_>>(),
        [
            vec![typed_a.clone(), unscoped.clone()],
            vec![typed_b.clone(), unscoped.clone()],
            vec![typed_c.clone(), unscoped.clone()],
            vec![unscoped.clone()],
        ],
    );
    independent.generated_externs[0].entry_files = vec!["src/entry-d.ts".to_string()];
    let changed_scope_output = prepare_closure_jobs(independent)?;
    assert_eq!(
        changed_scope_output.compile_jobs[0].externs,
        std::slice::from_ref(&unscoped)
    );
    assert_eq!(
        changed_scope_output.compile_jobs[3].externs,
        [typed_a.clone(), unscoped.clone()]
    );

    // The same file in two scopes is a union, while an explicit contract is global.
    scoped.generated_externs.push(super::GeneratedExternInput {
        path: typed_a.clone(),
        entry_files: vec!["src/entry-d.ts".to_string()],
    });
    scoped.explicit_extern_paths.push(typed_b.clone());
    let union_output = prepare_closure_jobs(scoped.clone())?;
    assert_eq!(
        union_output.compile_jobs[0].externs,
        [typed_b.clone(), typed_a.clone(), unscoped.clone()]
    );
    assert_eq!(
        union_output.compile_jobs[1].externs,
        [
            typed_b.clone(),
            typed_a.clone(),
            typed_c.clone(),
            unscoped.clone()
        ]
    );

    // An unowned terminal chunk cannot justify excluding any caller contract.
    scoped.chunk_plan[5].entry_files = None;
    scoped.generated_externs.pop();
    let incomplete_output = prepare_closure_jobs(scoped.clone())?;
    assert_eq!(
        incomplete_output.compile_jobs[1].externs,
        [
            typed_b.clone(),
            typed_a.clone(),
            typed_c.clone(),
            unscoped.clone()
        ]
    );
    scoped.generated_externs[0].entry_files = vec!["src/missing.ts".to_string()];
    assert!(matches!(
        prepare_closure_jobs(scoped.clone()),
        Err(error) if error.contains("no chunk entry ownership")
    ));
    scoped.generated_externs[0].entry_files = vec!["src/entry-a.ts".to_string()];
    fs::remove_file(&typed_a)?;
    assert!(matches!(
        prepare_closure_jobs(scoped),
        Err(error) if error.contains("Unable to read required extern")
    ));

    assert_eq!(output.compile_jobs.len(), 2);
    let job_chunk_names = output
        .compile_jobs
        .iter()
        .map(|job| {
            job.chunk
                .as_ref()
                .ok_or("missing chunk specifications")?
                .iter()
                .map(|spec| {
                    spec.split_once(':')
                        .map(|(name, _)| name.to_string())
                        .ok_or("missing chunk specification separator")
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        job_chunk_names,
        vec![
            vec![
                "shared".to_string(),
                "entry-a".to_string(),
                "entry-b".to_string()
            ],
            vec![
                "shared2".to_string(),
                "entry-c".to_string(),
                "entry-d".to_string()
            ],
        ]
    );
    assert_eq!(output.postprocess_actions.len(), 6);
    let postprocess_names = output
        .postprocess_actions
        .iter()
        .map(|action| {
            Path::new(&action.output_path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .ok_or("missing published output stem")
        })
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        postprocess_names,
        vec!["shared", "entry-a", "entry-b", "shared2", "entry-c", "entry-d"]
    );
    let report_stems = output
        .compile_jobs
        .iter()
        .map(|job| {
            Path::new(
                job.property_renaming_report_path
                    .as_ref()
                    .ok_or("missing property renaming report")?,
            )
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or("missing property renaming report filename")
        })
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        report_stems,
        vec![
            "shared.property-renaming-report.txt".to_string(),
            "shared2.property-renaming-report.txt".to_string(),
        ]
    );
    Ok(())
}

#[test]
fn prepares_esm_bundler_runtime_jobs() -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("bundler-runtime-esm-jobs")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(emitted_out_dir.join("src/main.js"),
    format!(
        "__register({:?}, function(__require, __exports) {{ __exports[0]=__dynamicImport({:?}); }});\n",
        to_bundler_runtime_module_id("gcc.src.main"),
        to_bundler_runtime_module_id("gcc.src.feature"),
    ),)?;
    fs::write(
        emitted_out_dir.join("src/feature.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=1; }});\n",
            to_bundler_runtime_module_id("gcc.src.feature")
        ),
    )?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let output = prepare_closure_jobs(PrepareClosureJobsInput {
        chunk_mode: "bundler-runtime".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "esm".to_string(),
        chunk_plan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: Some(vec!["src/main.ts".to_string()]),
                files: vec!["src/main.ts".to_string()],
                kind: Some("base".to_string()),
                lazy_module_ids: None,
                name: "main".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["main".to_string()],
                entry_files: None,
                files: vec!["src/feature.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazy_module_ids: Some(vec!["gcc.src.feature".to_string()]),
                name: "src-feature-lazy".to_string(),
            },
        ],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: String::new(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![],
    })?;

    let job = &output.compile_jobs[0];
    assert_eq!(job.chunk_output_type.as_deref(), Some("ES_MODULES"));
    // Closure rejects --rename_prefix_namespace outright under ES_MODULES.
    assert_eq!(job.rename_prefix_namespace, None);

    let base = output
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with("main.linked.js"))
        .ok_or("base linked chunk")?;
    let lazy = output
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with("src-feature-lazy.linked.js"))
        .ok_or("lazy linked chunk")?;

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
    Ok(())
}

#[test]
fn elides_runtime_for_single_eager_esm_chunk() -> Result<(), Box<dyn std::error::Error>> {
    let root = make_temp_dir("bundler-runtime-flat-esm")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(
        emitted_out_dir.join("src/main.js"),
        "globalThis.runtimeElisionAnswer = 42;\n",
    )?;
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let input = PrepareClosureJobsInput {
        chunk_mode: "bundler-runtime".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "esm".to_string(),
        chunk_plan: vec![ClosureJobChunkPlanChunkInput {
            dependencies: vec![],
            entry_files: Some(vec!["src/main.ts".to_string()]),
            files: vec!["src/main.ts".to_string()],
            kind: Some("base".to_string()),
            lazy_module_ids: None,
            name: "main".to_string(),
        }],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: "chunk-map.json".to_string(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "/app/".to_string(),
        support_files: vec![],
        type_metadata: vec![],
    };
    let output = prepare_closure_jobs(input.clone())?;

    let base = output
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with("main.linked.js"))
        .ok_or("base linked chunk")?;
    // Closure still sees the established runtime-shaped input so removing the
    // dead envelope cannot perturb optimization/name allocation in the app
    // body. The native capability gate marks the one published base output for
    // structurally validated post-Closure stripping.
    assert!(base.text.contains("globalThis[\"__g\"]"), "{base:?}");
    assert!(base.text.contains("runtimeElisionAnswer"), "{base:?}");
    assert_eq!(output.postprocess_actions.len(), 1);
    assert_eq!(output.postprocess_actions[0].kind, "strip-bundler-runtime");
    assert!(output
        .generated_assets
        .iter()
        .any(|asset| asset.path.ends_with("chunk-map.json")));
    assert_eq!(
        output.compile_jobs[0].chunk_output_type.as_deref(),
        Some("ES_MODULES")
    );

    let preserved_output = prepare_closure_jobs(PrepareClosureJobsInput {
        has_preserved_modules: true,
        ..input.clone()
    })?;
    assert_eq!(preserved_output.postprocess_actions[0].kind, "copy");

    fs::write(
        emitted_out_dir.join("src/main.js"),
        "new Worker('__VITE_WORKER_ASSET__12345678__');\n",
    )?;
    let worker_output = prepare_closure_jobs(input)?;
    assert_eq!(worker_output.postprocess_actions[0].kind, "copy");
    Ok(())
}

// --- vendor chunk assembly ----------------------------------------------

/// vendor -> base -> panel, the shape the vendor plan produces: vendor leads,
/// base depends on it, and the panel depends only on base.
fn prepare_vendor_jobs(
    label: &str,
    vendor: bool,
) -> Result<PrepareClosureJobsOutput, Box<dyn std::error::Error>> {
    let root = make_temp_dir(label)?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(emitted_out_dir.join("node_modules/lib"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
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
    )?;
    fs::write(
        emitted_out_dir.join("src/main.js"),
        format!(
        "__register({:?}, function(__require, __exports) {{ __exports[0]=__require({:?}); }});\n",
        to_bundler_runtime_module_id("gcc.src.main"),
        to_bundler_runtime_module_id("gcc.node_modules.lib.index"),
    ),
    )?;
    fs::write(
        emitted_out_dir.join("src/panel.js"),
        format!(
            "__register({:?}, function(__require, __exports) {{ __exports[0]=2; }});\n",
            to_bundler_runtime_module_id("gcc.src.panel"),
        ),
    )?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let vendor_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: vec![],
        entry_files: None,
        files: vec!["node_modules/lib/index.ts".to_string()],
        kind: Some("vendor".to_string()),
        lazy_module_ids: None,
        name: "main-vendor".to_string(),
    };
    let base_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: if vendor {
            vec!["main-vendor".to_string()]
        } else {
            vec![]
        },
        entry_files: Some(vec!["src/main.ts".to_string()]),
        files: if vendor {
            vec!["src/main.ts".to_string()]
        } else {
            vec![
                "node_modules/lib/index.ts".to_string(),
                "src/main.ts".to_string(),
            ]
        },
        kind: Some("base".to_string()),
        lazy_module_ids: None,
        name: "main".to_string(),
    };
    let panel_chunk = ClosureJobChunkPlanChunkInput {
        dependencies: vec!["main".to_string()],
        entry_files: None,
        files: vec!["src/panel.ts".to_string()],
        kind: Some("lazy".to_string()),
        lazy_module_ids: Some(vec!["gcc.src.panel".to_string()]),
        name: "src-panel-lazy".to_string(),
    };

    prepare_closure_jobs(PrepareClosureJobsInput {
        chunk_mode: "bundler-runtime".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "esm".to_string(),
        chunk_plan: if vendor {
            vec![vendor_chunk, base_chunk, panel_chunk]
        } else {
            vec![base_chunk, panel_chunk]
        },
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: "manifest.json".to_string(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![],
    })
    .map_err(Into::into)
}

fn linked_chunk_text<'a>(
    output: &'a PrepareClosureJobsOutput,
    chunk_name: &str,
) -> Result<&'a str, String> {
    output
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with(&format!("{chunk_name}.linked.js")))
        .map(|asset| asset.text.as_str())
        .ok_or_else(|| format!("missing linked chunk {chunk_name}"))
}

#[test]
fn vendor_chunk_leads_the_specs_and_base_depends_on_it() -> Result<(), Box<dyn std::error::Error>> {
    let output = prepare_vendor_jobs("vendor-specs", true)?;
    let specs = output.compile_jobs[0].chunk.as_ref().ok_or("chunk specs")?;
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
    Ok(())
}

#[test]
fn vendor_chunk_carries_the_runtime_core_and_base_keeps_the_manifest(
) -> Result<(), Box<dyn std::error::Error>> {
    let output = prepare_vendor_jobs("vendor-runtime-core", true)?;
    let vendor = linked_chunk_text(&output, "main-vendor")?;
    let base = linked_chunk_text(&output, "main")?;
    let panel = linked_chunk_text(&output, "src-panel-lazy")?;

    // Vendor executes first (base imports it), so it must build the runtime
    // before its own alias line dereferences it.
    assert!(vendor.contains("r.i=1;"), "{vendor}");
    assert!(vendor.contains("if(!r.i){"), "{vendor}");
    let alias_at = vendor
        .find("var __runtime_0=globalThis[\"__g\"],__register_0=__runtime_0.r,")
        .ok_or_else(|| format!("missing vendor alias line: {vendor}"))?;
    let initialized_at = vendor
        .find("r.i=1;")
        .ok_or("missing runtime initialization")?;
    assert!(initialized_at < alias_at, "{vendor}");
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
    Ok(())
}

#[test]
fn vendor_chunk_gets_a_manifest_row_with_its_deps_and_no_css(
) -> Result<(), Box<dyn std::error::Error>> {
    let output = prepare_vendor_jobs("vendor-manifest", true)?;
    let manifest = &output
        .generated_assets
        .iter()
        .find(|asset| asset.path.ends_with("manifest.json"))
        .ok_or("manifest")?
        .text;
    let parsed: serde_json::Value = serde_json::from_str(manifest)?;
    let vendor_id = to_bundler_runtime_chunk_id("main-vendor");
    let base_id = to_bundler_runtime_chunk_id("main");
    let vendor_row = &parsed["chunks"][&vendor_id];

    assert_eq!(vendor_row["css"], serde_json::json!([]));
    assert_eq!(vendor_row["deps"], serde_json::json!([]));
    assert_eq!(
        vendor_row["url"],
        serde_json::json!(format!("./{vendor_id}.js"))
    );
    assert_eq!(
        vendor_row["modules"]
            .as_array()
            .ok_or("missing vendor modules")?
            .len(),
        1
    );
    // Base names vendor, which is the edge the loader relies on.
    assert_eq!(
        parsed["chunks"][&base_id]["deps"],
        serde_json::json!([vendor_id])
    );
    assert_eq!(parsed["baseChunk"], serde_json::json!(base_id));
    // Every module is placed, vendor's included.
    assert_eq!(
        parsed["modules"]
            .as_object()
            .ok_or("missing manifest modules")?
            .len(),
        3
    );
    Ok(())
}

#[test]
fn a_plan_without_a_vendor_chunk_keeps_the_single_combined_preamble(
) -> Result<(), Box<dyn std::error::Error>> {
    // Regression guard for the flag-off path: base still emits core and
    // manifest as one IIFE, exactly as it always has.
    let output = prepare_vendor_jobs("vendor-absent", false)?;
    let base = linked_chunk_text(&output, "main")?;

    assert!(base.contains("if(!r.i){"), "{base}");
    assert!(base.contains("r.i=1;"), "{base}");
    assert!(base.contains("r.a("), "{base}");
    assert_eq!(
        base.matches(").call(this,globalThis);").count(),
        1,
        "{base}"
    );
    let specs = output.compile_jobs[0].chunk.as_ref().ok_or("chunk specs")?;
    assert!(
        specs[0].starts_with(&format!("{}:", to_bundler_runtime_chunk_id("main"))),
        "{specs:?}"
    );
    Ok(())
}

#[test]
fn vendor_chunk_pins_its_annotated_assigners_before_the_load_call(
) -> Result<(), Box<dyn std::error::Error>> {
    let output = prepare_vendor_jobs("vendor-pin", true)?;
    let vendor = linked_chunk_text(&output, "main-vendor")?;

    // Both halves are required: `@noinline` alone still loses to
    // CrossChunkCodeMotion, the pin alone still loses to inlining. Measured
    // on the real failing job, only the pair compiles.
    assert!(vendor.contains("/** @noinline */"), "{vendor}");
    let pin = "__runtime_0.v=[set_version$$1];";
    assert!(vendor.contains(pin), "{vendor}");
    // The pin uses this chunk's own alias and runs as part of the chunk, so
    // it sits between the module text and the trailing `l()`.
    let pin_at = vendor.find(pin).ok_or("missing assigner pin")?;
    let loaded_at = vendor
        .find("__runtime_0.l(0);")
        .ok_or("missing load completion")?;
    assert!(pin_at < loaded_at, "{vendor}");
    assert!(vendor.trim_end().ends_with("__runtime_0.l(0);"), "{vendor}");
    // Only annotated functions are pinned.
    assert!(!vendor.contains("pure_helper$$1]"), "{vendor}");
    assert!(!vendor.contains(",pure_helper$$1"), "{vendor}");
    Ok(())
}

#[test]
fn non_vendor_chunks_are_never_pinned() -> Result<(), Box<dyn std::error::Error>> {
    // Motion out of base and lazy chunks is legal and is what keeps them
    // small, so nothing there is pinned even if it carries the annotation.
    let output = prepare_vendor_jobs("vendor-pin-absent", false)?;
    for chunk_name in ["main", "src-panel-lazy"] {
        let text = linked_chunk_text(&output, chunk_name)?;
        assert!(!text.contains(".v=["), "{chunk_name}: {text}");
    }

    let split = prepare_vendor_jobs("vendor-pin-split", true)?;
    let panel = linked_chunk_text(&split, "src-panel-lazy")?;
    assert!(!panel.contains(".v=["), "{panel}");
    Ok(())
}

#[test]
fn split_jobs_aggregate_only_native_emitted_chunk_inputs() -> Result<(), Box<dyn std::error::Error>>
{
    let root = make_temp_dir("split-type-metadata")?;
    let emitted_out_dir = root.join("native-out");
    let out_dir = root.join("dist");
    let final_cache_dir = root.join("cache/final");
    let package_root = root.join("pkg");
    fs::create_dir_all(emitted_out_dir.join("src"))?;
    fs::create_dir_all(&out_dir)?;
    fs::create_dir_all(package_root.join("closure-lib"))?;
    fs::write(package_root.join("closure-lib/base.js"), "")?;
    let a = emitted_out_dir.join("src/a.js");
    let b = emitted_out_dir.join("src/b.js");
    let explicit = root.join("explicit.js");
    fs::write(&a, "goog.module('gcc.src.a');\n")?;
    fs::write(&b, "goog.module('gcc.src.b');\n")?;
    fs::write(&explicit, "globalThis.explicit = true;\n")?;
    let native_extern = root.join("native.externs.js");
    fs::write(&native_extern, "/** @externs */\n")?;

    let input = PrepareClosureJobsInput {
        chunk_mode: "split".to_string(),
        chunk_loader: "script".to_string(),
        chunk_output_type: "script".to_string(),
        chunk_plan: vec![
            ClosureJobChunkPlanChunkInput {
                dependencies: vec![],
                entry_files: None,
                files: vec!["src/a.ts".to_string()],
                kind: Some("base".to_string()),
                lazy_module_ids: None,
                name: "a".to_string(),
            },
            ClosureJobChunkPlanChunkInput {
                dependencies: vec!["a".to_string()],
                entry_files: None,
                files: vec!["src/b.ts".to_string()],
                kind: Some("lazy".to_string()),
                lazy_module_ids: None,
                name: "b".to_string(),
            },
        ],
        compilation_level: "ADVANCED".to_string(),
        diagnostics_verbose: false,
        emitted_out_dir: emitted_out_dir.to_string_lossy().to_string(),
        explicit_extern_paths: vec![],
        explicit_js_inputs: vec![explicit.to_string_lossy().to_string()],
        final_cache_dir: final_cache_dir.to_string_lossy().to_string(),
        generated_externs: vec![],
        language_out: "ECMASCRIPT_NEXT".to_string(),
        manifest_file: String::new(),
        has_preserved_modules: false,
        needs_css_runtime: false,
        native_extern_path: native_extern.to_string_lossy().to_string(),
        out_dir: out_dir.to_string_lossy().to_string(),
        package_root: package_root.to_string_lossy().to_string(),
        public_path: "./".to_string(),
        support_files: vec![],
        type_metadata: vec![
            emitted_type_metadata(
                &a,
                crate::closure_metadata::TypeMetadataCounts {
                    annotations: 2,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &b,
                crate::closure_metadata::TypeMetadataCounts {
                    type_declarations: 1,
                    unresolved_type_references: 3,
                    ..Default::default()
                },
            ),
            emitted_type_metadata(
                &explicit,
                crate::closure_metadata::TypeMetadataCounts {
                    enum_declarations: 7,
                    ..Default::default()
                },
            ),
        ],
    };
    let output = prepare_closure_jobs(input.clone())?;
    let job = &output.compile_jobs[0];
    assert!(job.has_type_metadata);
    assert_eq!(job.type_metadata_counts.annotations, 2);
    assert_eq!(job.type_metadata_counts.type_declarations, 1);
    assert_eq!(job.type_metadata_counts.enum_declarations, 0);
    assert_eq!(job.type_metadata_counts.unresolved_type_references, 3);
    Ok(())
}
