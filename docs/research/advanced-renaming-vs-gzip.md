# Does ADVANCED property renaming pay on the wire?

Research spike. No source changed by this document. Measured on a real
production app, not a generator: an Ant Design Pro admin (antd 6 +
`@ant-design/pro-components` + `@tanstack/react-start`), 2,352 modules,
7.1 MB of JS reaching the plugin, of which **94.1% is dependency code**
(6,662 KB across 2,246 files) against 418 KB of authored source in 238 files.
Compiler is the pinned `google-closure-compiler-java@20260811.0.0`
(`--version` → `v20260811`; upstream tag `v20260811`, commit `c095b038`).
`raw` = bytes of the emitted client chunks, `gzip` = `gzip -9`, both summed
over all 52 chunks of `client/assets`.

> **Correction notice.** An earlier revision of this document concluded that
> property renaming *caused* the gzip regression and recommended tiering
> vendor code to SIMPLE. A subsequent SIMPLE build of the same app refuted
> that: SIMPLE is **worse** than ADVANCED by 46 KB gzip. The renaming
> mechanism described below is real, but it is not the cause of the loss
> against pure Vite. The recommendation has been replaced.

---

## TL;DR verdict

| variant | raw | gzip | ratio | distinct ≤2ch | avg reuse |
|---|---|---|---|---|---|
| pure Vite (esbuild) | 2393.4 KB | **780.4 KB** | 3.07 | 349 | 16.0 |
| plugin, SIMPLE | 2645.4 KB | 857.7 KB | 3.08 | 307 | 19.8 |
| plugin, ADVANCED | 2314.0 KB | 811.7 KB | 2.85 | **2333** | **7.6** |
| plugin, ADVANCED, types off | 2316.2 KB | 812.3 KB | 2.85 | 2333 | 7.5 |

Three facts, in the order that matters:

1. **Pure Vite wins the wire.** Every plugin configuration ships more gzipped
   bytes than esbuild alone on this app.
2. **Renaming is not the culprit; it is the mitigation.** ADVANCED beats
   SIMPLE by 12.5% raw and **5.4% gzip (−46.0 KB)**. Same plugin, same graph,
   same externs, same DCE — the only difference is property renaming and the
   type-based passes.
3. **The loss is pipeline overhead.** At SIMPLE, i.e. with no property
   renaming at all, the plugin emits **+252 KB raw / +77.3 KB gzip** more than
   pure Vite. ADVANCED's renaming claws back 331 KB raw and 46 KB gzip of
   that, but cannot close the remaining 31.3 KB.

So the honest accounting against pure Vite's 780.4 KB gzip is:

```
+77.3 KB   plugin pipeline overhead (measured at SIMPLE)
-46.0 KB   recovered by ADVANCED renaming + type passes
---------
+31.3 KB   net regression  (+4.01%)
```

Renaming does genuinely damage compressibility — compression ratio falls
3.08 → 2.85 and average reuse per short name falls 19.8 → 7.6 while distinct
≤2-character names rise 307 → 2333. It is simply that the raw bytes it
removes outweigh the entropy it adds. **Both things are true at once, and the
earlier revision reported only the first.**

Type-based passes contribute nothing: `--use_types_for_optimization=false`
moves gzip by **0.08%**, confirming `typed-input.md`'s 0.03% at 30× scale.

---

## 1. Why renaming cannot do better: ambiguation never fires

`RenameProperties` and `AmbiguateProperties` pull in opposite directions:

- `RenameProperties.generateNames` (`RenameProperties.java:307-320`) walks
  properties by descending frequency, gives each `nameGenerator.generateNextName()`,
  then `reservedNames.add(p.newName)`. Every property gets its **own** name.
  `DefaultNameGenerator.generateNextName` is a sequential mint that never
  re-emits a name.
- `AmbiguateProperties` exists to undo exactly that. Class comment
  (`AmbiguateProperties.java:62-66`): *"Renames unrelated properties to the
  same name … This allows better compression as more properties can be given
  short names."*

Controlled probe on the pinned jar — identical source, one difference:

| receivers | A's names | B's names | shared |
|---|---|---|---|
| `@constructor @struct` on both | `g,h,i` | `g,h,i` | **yes** |
| unannotated | `g,h,i` | `j,l,m` | no |

Ambiguation is scheduled (`DefaultPassConfig.java:616-619`, gated on
`shouldAmbiguateProperties() && propertyRenaming == ALL_UNQUOTED &&
isTypecheckingEnabled()`), and ADVANCED plus the default
`--use_types_for_optimization` already sets it. It does not fire because:

- `AmbiguateProperties.Property.addRelatedColor` sets `skipAmbiguating = true`
  for that **property name, program-wide**, when any related color
  `isInvalidating()` or `getPropertiesKeepOriginalName()`.
- `InvalidatingTypes.isAmbiguousOrStructuralType` falls through to
  `return true`, so **object literals are invalidating**. Upstream pins this:
  `AmbiguatePropertiesTest.testSimplePropInObjectLiteralPreventsPropertyRenaming`
  asserts `const obj = {m: 0}; class C {m() {}}` compiles unchanged.

antd, `@ant-design/cssinjs` and pro-components are object-literal and
theme-token soup, so the candidate set is empty before type coverage is even
considered. Raising app-side type coverage cannot fix this, and the 0.08% A/B
proves it empirically.

**There is no type-free path to property-name reuse anywhere in the
compiler.** Searched the whole `jscomp` tree, the `@Option` list, and
`CompilerOptions` setters. The only type-free reuse is for *variables*:
`RenameVars` `LOCAL_VAR_PREFIX` (`RenameVars.java:188-191`) and
`CoalesceVariableNames`, whose comment says "better gzip compression"
(`CoalesceVariableNames.java:50-63`). Both are already on. Neither touches
properties.

## 2. The hidden CLI surface

`--help` advertises 67 flags. Parsing `CONSTANT_Utf8` entries out of the 22
`CommandLineRunner*` class constant pools in the pinned jar yields 105 flag
literals. These 41 ship but are unadvertised:

```
--allow_dynamic_import --apply_input_source_maps
--assume_no_prototype_method_enumeration --assume_static_inheritance_is_not_used
--browser_resolver_prefix_replacements --chrome_pass --continue_after_errors
--create_renaming_reports --dev_mode --expected_diagnostics
--filename_to_restore_from --filename_to_save_to --flagfile --help_markdown
--ijs --incremental_check_mode --instrument_for_coverage_option
--instrument_mapping_report --j2cl_pass --jscomp_dev_mode --jszip
--logging_level --module --num_parallel_threads --parse_inline_source_maps
--preserve_type_annotations --print_ast --print_source_after_each_pass
--print_tree --print_tree_json --production_instrumentation_array_name
--property_map_input_file --remove_j2cl_asserts --renaming
--segment_of_compilation_to_run --source_map_format --summary_detail_level
--tracer_mode --translations_file --translations_project
--variable_map_input_file
```

Presence in the pool proves the literal ships; it does **not** prove the flag
is wired. `--ijs` is the counter-example: the string exists only as
`JsSourceType.IJS("ijs")` and in `IjsErrors`, and the jar rejects `--ijs` as
not a valid option. Always probe acceptance separately.

Two of these are already on our production argv when the persistent cache has
prior maps: `--property_map_input_file` and `--variable_map_input_file`
(`src/build/closure/run-closure.ts:559-588`).

Probed and notable:

- **`--renaming=false` cannot rescue ADVANCED.** `CommandLineRunner.java:1708-1713`
  hard-errors: `renaming cannot be disabled when ADVANCED_OPTIMIZATIONS is
  used`. Accepted under SIMPLE only. There is no ADVANCED-minus-renaming mode.
- `--assume_static_inheritance_is_not_used` already defaults **true**, i.e. we
  already inherit the aggressive setting. For React/antd, static inheritance
  *is* used — this is a correctness risk, not a size lever.
- `--assume_no_prototype_method_enumeration` (default false) maps to
  `setCrossChunkCodeMotionNoStubMethods`. Worth one A/B; it was a no-op on toy
  input because ADVANCED inlined the methods.
- `--rename_prefix_namespace` is rejected outright with
  `--chunk_output_type ES_MODULES`, so `RescopeGlobalSymbols` is unreachable
  for us.
- `AliasStrings` has no CLI at this tag (`--alias_all_strings` and
  `--alias_strings` both rejected) and would hurt anyway: its own source says
  *"gzip actually prefers that strings are not aliased"* and the class comment
  says enabling it *"usually hurts code size after gzip"*.

## 3. Multistage exists in this jar, and is a compile-time feature only

The earlier spike reported that Google's TypedAST multistage pipeline is not
exposed. That was half wrong. Hidden but fully wired:

- `--filename_to_save_to`, `--filename_to_restore_from`,
  `--segment_of_compilation_to_run` (`CommandLineRunner.java:262-279`) drive a
  three-segment `CHECKS → OPTIMIZATIONS → FINALIZATIONS` dance via
  `saveState`/`restoreState` (`Compiler.java:4279-4308`, `4317-4473`).
- End-to-end probe: stage 1 saved 511,605 bytes, stage 2 saved 550,469 bytes,
  and the final JS was **byte-identical to a one-shot ADVANCED run**. Gzip
  delta: **0**. Restore requires identical `--js` paths; a new path fails with
  `IllegalStateException: Missing …`.
- `--typed_ast_output_file__INTENRNAL_USE_ONLY` (the typo is load-bearing)
  emits a gzipped `TypedAst.List`. The **consume** side,
  `setTypedAstListInputFilename` / `initWithTypedAstFilesystem`, has no
  `@Option` at all — it is Java-API only, called by
  `bazel/typedast.bzl` and `TypedAstIntegrationTest`. That is precisely why
  Google's library-shard ADVANCED is unreachable from an argv pipeline.
- `--incremental_check_mode=GENERATE_IJS` works and runs
  `ConvertToTypedInterface`, which *"shrink[s] the AST, preserving only
  typing, not behavior"* — function bodies become empty. It is a type-summary
  generator, not a library, so it cannot replace a vendor implementation.

Multistage is incrementality, not size. Correctly identified as a dead end for
the wire number, now with the mechanism.

## 4. What Google actually does with untyped third-party code

The public FAQ answer — library + externs contract + app, don't ADVANCED-rename
the library — is now mechanized in the compiler itself, and this is the single
most relevant finding for this plugin:

**`@closureUnaware`.** A `@fileoverview @closureUnaware` annotation marks a
file whose AST is compiled in a *nested* compilation.
`ClosureUnawareOptions.setSafeOptimizationAssumptions` forces
`CompilationLevel.SIMPLE_OPTIMIZATIONS`, `setAssumePropertiesAreStaticallyAnalyzable(false)`,
and the default (non-Closure) coding convention. Its stated purpose is *"to
protect arbitrary 3P code from breaking under advanced JSCompiler
optimizations."* `PerFileClosureUnawareMode` is `{UNSPECIFIED, SIMPLE,
WHITESPACE}`, where `WHITESPACE` skips even the nested optimization and only
strips whitespace and comments.

Public `rules_closure` 0.15.0 has no equivalent. Its 3P doors — `lenient`,
`suppress`, `no_closure_library`, `legacy=true` — only quiet *diagnostics*;
sources still go through ADVANCED and their properties are still renamed. So
"Google runs ADVANCED over everything" is stale relative to this compiler tag.

Also confirmed, all dead ends for renaming quality: `closure_js_library`'s
`.i.js` is consumed only by parent *library checks*, never by the binary
(`closure_js_binary.bzl` lists `js.srcs` and `js.infos`, not `ijs_files`), so
every ADVANCED binary re-parses every original source; the Bazel persistent
worker is JVM warmth with an `InputCache` that no program wires up;
`--conformance_configs`, `--isolation_mode=IIFE`, `--browser_featureset_year`,
`--inject_libraries`, `--rewrite_polyfills`, `@closurePrimitive` and
`goog.requireType` change nothing about renaming on a vendor-dominated ES-module
app.

## 5. Readings retracted during this work

Recorded so they are not rediscovered:

- **Renaming is not the cause of the wire regression.** Retracted on the
  SIMPLE measurement. See the correction notice.
- **Per-chunk deltas are unsound.** `provider` appears to grow 107 KB raw, but
  marker tokens (`antCls` 18→17, `motionDurationSlow` 10→9) show modules
  *moved*, not duplicated. `CrossChunkCodeMotion` relocates declarations to a
  common ancestor. Only whole-app totals are comparable.
- **No downleveling occurs.** `esnext` → `ECMASCRIPT_NEXT`
  (`closure_capabilities.rs:197`); `class`/`async`/`await`/spread all survive.
- **Vite content-hashed filenames are not a content oracle here.** The plugin
  rewrites chunk bodies after Vite has hashed them, so two builds at different
  compilation levels share all 52 filenames while sharing zero bytes. Compare
  digests, not names.
- **A "+133 KB of string literals" reading was a bad regex** pairing quotes
  inside minified code. A state-machine scan gave literals +32 KB and
  non-literal code +72 KB.

## 6. Recommendation

Ranked by evidence strength.

1. **Target the 77 KB of pipeline overhead, not the renaming.** This is the
   corrected priority and it is now the largest measured lever: at SIMPLE, with
   renaming entirely absent, the plugin still ships 77.3 KB gzip more than
   esbuild. That overhead is what makes the plugin unable to win on this class
   of app. Attribution work is not done — the SIMPLE output carries 7,560
   distinct long identifiers against ADVANCED's 3,804, plus 201 module-factory
   registrations — so the next step is to decompose those 252 KB raw into
   runtime preamble, module registration, and chunk-conversion costs before
   choosing a fix.
2. **Try `@closureUnaware` on vendor, but measure it; do not assume it wins.**
   It is the documented and now mechanized answer for untyped 3P, and it is
   reachable by emitting a `@fileoverview` annotation on materialized
   dependency files. But note the tension this spike created: nested
   `SIMPLE` is the mode `@closureUnaware` forces, and SIMPLE measured *worse*
   than ADVANCED here. `WHITESPACE` mode plus the existing esbuild
   `finalMinify` pass is the more promising variant, because it lets esbuild —
   which currently wins outright — do the minification of vendor while
   ADVANCED still handles authored code. Expected value is genuinely unknown;
   this is the one experiment worth running next.
3. **Do not expect much from tiering by compilation level.** 94.1% of input is
   dependency code, so ADVANCED can only ever apply to 5.9% of the graph. Any
   scheme that keeps vendor out of ADVANCED is bounded above by roughly the
   pure-Vite number, i.e. it removes a regression rather than delivering a win.
4. **Stop looking for a flag.** No type-free property-name-reuse option exists;
   `--renaming=false` is refused under ADVANCED; `AliasStrings` is unreachable
   and would hurt; multistage is byte-identical; the gzip-aware machinery that
   does exist (`CoalesceVariableNames`, `OptimizeLetAndConstPeephole`,
   `RenameVars` same-length ordering, the `DefaultNameGenerator` alphabet,
   `CompactCodePrinter` preferred newlines) is already on.
5. **Guard the wire number.** Gzip is already computed
   (`src/shared/lifecycle-size.ts`, `scripts/build-self.mjs`), Vite prints it
   per chunk, and `README.md` tabulates plugin-versus-pure gzip for the
   examples. What is missing is a *gate*: nothing fails, or even warns, when
   the plugin ships more bytes than no plugin at all. On this app it did, by
   4.0%, and every automated check stayed green.

## 7. Measuring this in future

- Type coverage: `--jscomp_warning=reportUnknownTypes` emits
  `JSC_UNKNOWN_EXPR_TYPE`; the summary prints `TypeCheck.getTypedPercent()`.
- Did ambiguation run: `--tracer_mode` and `--print_source_after_each_pass` are
  both accepted (unadvertised). A `--property_renaming_report` full of
  *original* long names is evidence of skipping; after a successful ambiguation
  the report shows post-color names, and unrelated originals map to the *same*
  short name.
- Wire size: always compare summed `gzip -9` over all emitted chunks, compare
  file digests rather than Vite's filenames, and never attribute a delta to a
  single named chunk without first checking that chunk composition matches.
- Hidden-flag archaeology: parse `CONSTANT_Utf8` entries from the
  `CommandLineRunner*` class constant pools in the jar and diff against
  `--help`, then probe each candidate for acceptance on a throwaway input.
