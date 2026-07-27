# Closure staged builds, TypedAST, and production instrumentation

Research spike: how much of Google's Bazel-internal Closure machinery is
usable from the OSS CLI we ship. **Research only** — nothing here is wired
into the build.

- Compiler: `node_modules/google-closure-compiler-linux-arm64/compiler`,
  v20260720 (GraalVM native image).
- Fallback: `node_modules/google-closure-compiler-java/compiler.jar`, same
  version, on OpenJDK 21.
- Workload: the real `bundler-runtime` chunk job from
  `examples/svelte-vite-spa` — 7 inputs / 310 KB of linked JS, 7 chunks,
  `ADVANCED`, `--env=CUSTOM` minimal platform externs,
  `--use_types_for_optimization`, `--rename_prefix_namespace=$gcc`. The exact
  argv was captured by shimming the compiler binary during a real
  `vite build`; it is reproduced in the appendix.
- Machine: linux-arm64, warm page cache, 3 runs per measurement unless noted.

## Baseline

| Configuration | Wall time |
| --- | --- |
| native, single-shot `ENTIRE_COMPILATION` | **710 ms** (724 / 717 / 700) |
| native, `--checks_only` only | 178 ms (179 / 176) |
| native, process startup floor (`--version`) | 7 ms |
| JAR, single-shot `ENTIRE_COMPILATION` | 2331 ms (2340 / 2322) |
| JAR, process startup floor (`--version`) | 170 ms |

The entire closure stage of this example build is one 710 ms process. That
number is the ceiling on anything below.

---

## 1. Staged builds — `--filename_to_save_to` / `--filename_to_restore_from` / `--segment_of_compilation_to_run`

### Semantics (from source)

All three flags are `hidden = true` in
[`CommandLineRunner.java`](https://github.com/google/closure-compiler/blob/master/src/com/google/javascript/jscomp/CommandLineRunner.java)
(lines 262–279). `CompilerOptions.SegmentOfCompilationToRun` declares seven
values:

```java
ENTIRE_COMPILATION, CHECKS, OPTIMIZATIONS_FIRST_HALF,
OPTIMIZATIONS_SECOND_HALF, OPTIMIZATIONS, OPTIMIZATIONS_AND_FINALIZATIONS,
FINALIZATIONS
```

but `initConfigFromFlags` only wires up four of them:

```java
case CHECKS        -> // must NOT restore; saves state "1"
case OPTIMIZATIONS -> // restores state "1", saves state "2"
case FINALIZATIONS -> // restores state "2"; must NOT save
case ENTIRE_COMPILATION -> {}
default -> throw new IllegalStateException("Cannot run %s segment of compilation: ...");
```

Confirmed empirically — `--segment_of_compilation_to_run OPTIMIZATIONS_AND_FINALIZATIONS`
throws `IllegalStateException` at `CommandLineRunner.java:1800`. The
`*_HALF` and `..._AND_FINALIZATIONS` values exist only for Google's internal
runner. **From the CLI there is exactly one split: CHECKS → OPTIMIZATIONS →
FINALIZATIONS.**

### Blocker: the native image cannot save state at all

```
$ compiler <real job args> --segment_of_compilation_to_run CHECKS \
    --filename_to_save_to checks.state
com.oracle.svm.core.jdk.UnsupportedFeatureError: SerializationConstructorAccessor
class not found for declaringClass: com.google.javascript.jscomp.Compiler$CompilerState
  ... at com.google.javascript.jscomp.Compiler.lambda$saveState$25(Compiler.java:4276)
exit 254, checks.state = 10 bytes (truncated garbage)
```

Save/restore uses plain Java serialization of `Compiler$CompilerState`, and
that class is not in the native image's `serialization-config.json`. This is
not fixable from our side; it needs a change to the upstream native-image
build config. So staged builds are **JAR-only** for us today.

### Measurements (JAR, since native cannot participate)

| Stage | Wall time | Artifact |
| --- | --- | --- |
| `CHECKS` + save | 1097 ms | `a.state` 204 488 B |
| `OPTIMIZATIONS` restore + save | 1628 ms | `b.state` 186 072 B |
| `FINALIZATIONS` restore | 1166 ms | 7 chunks + renaming reports |
| **total staged (JAR)** | **3891 ms** | |
| single-shot (JAR) | 2331 ms | |
| single-shot (native) | 710 ms | |

Splitting costs **+67 % over the JAR single-shot** and is **5.5× slower than
the native single-shot** we actually ship. Three JVM startups (~510 ms) plus
two serialize/deserialize round-trips of a ~200 KB state blob more than eat
the theoretical savings.

Output correctness is fine: all 7 chunks plus both renaming reports are
**byte-identical** between staged and single-shot.

### Does restore tolerate any input change? No — and it fails unsafely

Three mutations of the input set, each replaying a saved `CHECKS` state:

1. **Drop one `--js`** → hard failure, `Not enough JS files specified.
   Expected 7 but found 6`.
2. **Same content at a different path** → hard failure,
   `IllegalStateException: Missing InputId: .../main.linked.js` at
   `Compiler.deserializeCompilerState(Compiler.java:4397)`, then
   `JSC_COULD_NOT_DESERIALIZE_AST`.
3. **Changed content at the *same* path** (appended
   `var ZZZ_MARKER=1;window["zz"]=ZZZ_MARKER;` to `main.linked.js`) →
   **exit 0, and the output is byte-identical to the unmutated baseline.**
   The marker is nowhere in the output.

Case 3 is the dangerous one. The saved state carries the AST; `--js` is
validated only by *count* and *path identity*, never by content. A stale
restore silently produces a build from the old sources with no diagnostic.
Any cache keyed on anything less than the full content hash of every input
is a correctness bug — and once you hash every input, you have exactly the
key our existing `closure-jobs` content cache already uses, so the staged
state buys nothing over `getCompileJobArtifactFiles` restore.

### Per-depset saved state: not viable

The state is per-*compilation*, not per-library. `CHECKS` is run over the
whole `--js` set and the resulting `InputId` list is baked into the blob, so
there is no way to save "the checks for depset X" and reuse it in a
compilation whose input list differs. Any change to the chunk graph — which
is precisely what a rebuild changes — invalidates it (case 1/2 above).

Even granting a perfect per-job CHECKS cache with zero restore cost, the
native `--checks_only` measurement says the ceiling is **178 ms of the
710 ms job (25 %)**, on a build whose total wall time is 2.68 s. And that
ceiling is only reachable on a compiler that cannot save state.

### Verdict: **dead end**

Blocked on the native image (no serialization support), 5.5× slower even on
the JAR, silently wrong on content changes, and the best-case saving is
~180 ms behind a cache key we already compute. Revisit only if upstream both
(a) adds `Compiler$CompilerState` to the native-image serialization config
and (b) makes restore validate input content — neither is on any roadmap.

---

## 2. TypedAST — `--typed_ast_output_file__INTENRNAL_USE_ONLY`

Output works, including on the native image:

```
$ compiler <real job args> --checks_only \
    --typed_ast_output_file__INTENRNAL_USE_ONLY out.typedast
221 ms
```

| Metric | Value |
| --- | --- |
| input JS | 309 536 B |
| `out.typedast` on disk | 182 895 B (gzip) |
| ungzipped | 779 885 B |

Format is a gzipped protobuf (`TypedAst`); the header is a string pool —
`JSCOMPILER_PRESERVE`, `JSCompiler_renameProperty`, `global`, `Symbol`, … .
`CompilerOptions.setTypedAstOutputFile` is documented in-tree as *"Sets file
to output in-progress TypedAST format. DO NOT USE! … currently a gzipped
TypedAst proto but this is not stable."*

**There is no input path in the OSS CLI.**
`AbstractCommandLineRunner.CommandLineConfig` has
`setTypedAstListInputFilename` (line 2542) driving
`initWithTypedAstFilesystem` / `initChunksWithTypedAstFilesystem` (lines
1423/1436), but grepping every `@Option(name = "--…")` in
`CommandLineRunner.java` (101 flags) turns up no flag that calls it. Only
Google's internal Bazel runner constructs that config. There is likewise no
CLI surface for `setMergedPrecompiledLibraries`.

Library-level precompilation would therefore require us to bypass
`CommandLineRunner` and drive `AbstractCommandLineRunner`/`Compiler`
in-process from the JAR — abandoning the native image (3.3× slower baseline)
to chase a saving on a 710 ms job, on an explicitly unstable format with no
compatibility guarantee across compiler releases.

### Verdict: **dead end** (revisit if a `--typed_ast_input` flag ever lands)

Output-only is genuinely interesting for *analysis* though — see "possible
follow-up" below.

---

## 3. Production instrumentation — `--instrument_for_coverage_option=PRODUCTION`

Works on the native image. Requires the array name to be declared in externs
so it survives renaming:

```js
/** @type {!Array<string>} */
var ist_arr;
```

```
compiler <real job args> --externs instr-externs.js \
  --instrument_for_coverage_option PRODUCTION \
  --production_instrumentation_array_name ist_arr \
  --instrument_mapping_report mapping.txt
```

### Cost

Compile time 855 ms vs 710 ms baseline (**+20 %**). Size:

| Chunk | raw | raw instr | Δ | gzip | gzip instr | Δ |
| --- | --- | --- | --- | --- | --- | --- |
| `c02c7329c` (main) | 57 046 | 108 160 | **+89 %** | 21 028 | 30 767 | **+46 %** |
| `cd0dddb03` | 2 852 | 4 173 | +46 % | 1 324 | 1 589 | +20 % |
| `c21c4112e` | 2 894 | 4 100 | +41 % | 1 330 | 1 542 | +15 % |
| `c36791106` | 6 582 | 8 681 | +31 % | 2 550 | 2 922 | +14 % |
| `c39611043` | 2 036 | 2 650 | +30 % | 942 | 1 048 | +11 % |
| `c9f0fa41f` | 1 002 | 1 269 | +26 % | 557 | 615 | +10 % |
| `c4db9667a` | 69 | 69 | +0 % | 80 | 80 | +0 % |

The main chunk gets **2 378 `ist_arr.push("…")` sites (2 373 unique ids)**.
Runtime cost is one unconditional string push per function entry and per
branch: measured **16.7 ns/push** on this box, and the array grows without
bound (5 M pushes ≈ 40 MB of retained references). It is a
staging/canary-only build mode, never a production ship. `mapping.txt` is
61 KB for this app — another 61 KB of build output to store per release.

### Decoding the mapping — prototype works

Format (from `ProductionCoverageInstrumentationCallback.ParameterMapping`):
a `VariableMap` file of `<id>:<value>` lines, where three special keys
` FileNames`, ` FunctionNames`, ` Types` hold JSON arrays, and every other
line maps a **Base64-VLQ-encoded unique id** to a Base64-VLQ 5-tuple
`[fileIndex, functionIndex, typeIndex, lineNo, colNo]`. `Types` is
`["BRANCH","BRANCH_DEFAULT","FUNCTION"]`.

Prototype decoder: `/tmp/decode_instr_map.mjs` (kept out of `src/` per the
research-only constraint; ~70 lines, no dependencies — Base64 VLQ is the
same encoding our source-map handling already implies).

```
$ node decode_instr_map.mjs mapping.txt *.js
files=6 fns=509 types=BRANCH,BRANCH_DEFAULT,FUNCTION points=3786
ids referenced in chunks: 2628, unresolved: 0
++B {"file":".../main.linked.js","fn":"_Batch$$10.prototype.schedule",
     "type":"BRANCH_DEFAULT","line":2512,"col":8}
--- points per file
  3598 main.linked.js
    88 src-src-panels-NavigationRailPanel__svelte-lazy.linked.js
    35 src-src-panels-DialogPanel__svelte-lazy.linked.js
    27 src-src-panels-MenuPanel__svelte-lazy.linked.js
    26 src-src-panels-CheckboxPanel__svelte-lazy.linked.js
    12 src-src-panels-ButtonPanel__svelte-lazy.linked.js
```

Every id emitted into a chunk resolves (0 unresolved). Note 3 786 mapping
entries vs 2 628 emitted call sites — ~30 % of instrumentation points are
registered in the mapping and then removed by later optimization passes, so
"absent from the mapping" and "absent from the output" are different
questions and the report over-counts.

### Feeding this back into dead-code / externs analysis

Attractive in principle: we already parse renaming reports in
`src/build/closure/run-closure.ts` (`persistRenamingMaps` /
`applyStableRenamingMaps`), so a second report parser is cheap and the
plumbing precedent exists.

Two real obstacles:

1. **Granularity is post-link, not source.** `FileNames` holds our *linked*
   intermediate paths (`bundler-runtime/main.linked.js`), and
   `FunctionNames` holds post-transform names (`_Batch$$10.prototype.schedule`,
   `y$jscomp$5`, 509 entries with many `<Anonymous>`). Mapping a cold
   function back to a `.svelte`/`.ts` source span needs the source map plus a
   name-demangling step we do not have. Without that, "this function never
   ran" is not actionable feedback to a user.
2. **Coverage is unsound as a removal signal.** Closure's own dead-code
   elimination is a *proof*; runtime coverage is a *sample*. A function that
   no canary session touched is not dead. It can safely inform advisory
   reporting ("these 40 functions were never executed across N sessions —
   consider deleting or lazy-loading") but must never drive automatic
   removal or externs pruning.

There is one cheap, sound consumer: **chunk-splitting feedback**. Per-chunk
execution counts tell us which code in the eager `main` chunk is actually
cold and should move behind a lazy chunk — a hint to the chunk planner, not
a correctness claim. That is where the value is if we ever pick this up.

### Verdict: **future**, and only as an opt-in diagnostic

Not shippable in a production bundle (+46 % gzip, unbounded array). Worth a
future `--coverage-probe` build mode that emits an instrumented bundle plus
the decoded mapping for a canary, feeding advisory dead-code and
chunk-splitting reports. Blocked on source-map-based demangling before the
output is user-facing.

---

## 4. XTB / `goog.getMsg` translations

`--translations_file` (XTB only) and `--translations_project` are both
`hidden = true` in `CommandLineRunner.java` (lines 682/688). Smoke test on
the native image: the flag parses and a compile with an XTB bundle succeeds,
falling through to the original message when no translation id matches.

Adoption would require, in order:

1. Emitting `goog.getMsg('…', {…})` assignments to `MSG_*`-prefixed
   variables with `@desc` JSDoc from our TypeScript front end — i18n
   authoring in a Closure-specific dialect, not something a Svelte/Vue/React
   app writes.
2. Message **extraction**, to produce the XMB that translators consume. The
   OSS CLI has no extraction flag (all 101 `@Option` names checked); Google
   uses an internal `JsMessageExtractor`. We would have to write and maintain
   the extractor ourselves.
3. Generating XTB with Google's message-id hash for every locale, then
   compiling **N times, once per locale** — multiplying our closure stage
   cost by the locale count, since `--translations_file` is a
   whole-compilation input.

Every mainstream i18n library for the frameworks we target (`svelte-i18n`,
`vue-i18n`, `react-intl`) does runtime or build-time message loading that
needs none of this, and the per-locale-recompile model is a poor fit for a
Vite plugin.

### Verdict: **not applicable**

Recorded as such. The one thing to preserve is a negative: our externs and
property-renaming setup must not accidentally break an app that *does* use
`goog.getMsg`, but no such app exists in `examples/`.

---

## Summary

| Item | Verdict | One-line reason |
| --- | --- | --- |
| Staged builds (save/restore/segment) | **dead end** | Native image cannot serialize state at all; JAR staging is 3.9 s vs 0.71 s native, and restore silently ignores content changes. |
| TypedAST precompilation | **dead end** | Output works (183 KB gz, 221 ms) but the OSS CLI exposes no input flag — Bazel-only — on an explicitly unstable format. |
| Production instrumentation | **future** | Works today; +46 % gzip and 16.7 ns/push make it canary-only. Mapping decoder prototyped and validated. Needs source-map demangling first. |
| XTB / `goog.getMsg` | **not applicable** | Requires Closure-dialect i18n authoring, an extractor we'd have to write, and one compile per locale. |

### Possible follow-up (not part of this spike)

`--typed_ast_output_file__INTENRNAL_USE_ONLY --checks_only` is 221 ms on the
native image and produces a full typed AST of the whole app. Even without an
input path, that proto is a ready-made **analysis** artifact — resolved types
for every node, which is strictly more than the property-renaming report we
parse today. If we ever want type-aware externs generation or a "why did
this property survive renaming" diagnostic, decoding this proto is the
cheapest source of truth. The blocker is format instability, so any consumer
must be version-pinned and fail soft.

---

## Appendix: reproducing the workload

Captured argv from a real `examples/svelte-vite-spa` build (paths shortened;
`$C` = `~/.cache/gcc-ts-bundler/<project>/final/<key>`):

```
--assume_function_wrapper=true
--compilation_level=ADVANCED
--externs=<project>/.gcc-ts-bundler-vite/<h>/generated.externs.js
--externs=closure-externs/{browser-extra,closure,commonjs,lazy-runtime,tslib,worker}.js
--externs=$C/raw/platform-externs.c02c7329c.js
--js=$C/bundler-runtime/main.linked.js
--js=$C/bundler-runtime/main-shared.linked.js
--js=$C/bundler-runtime/src-src-panels-{Button,Checkbox,Dialog,Menu,NavigationRail}Panel__svelte-lazy.linked.js
--language_in=UNSTABLE
--language_out=ECMASCRIPT_NEXT
--rewrite_polyfills=false
--warning_level=QUIET
--chunk=c02c7329c:1
--chunk=c4db9667a:1:c02c7329c
--chunk=c9f0fa41f:1:c02c7329c,c4db9667a
--chunk=cd0dddb03:1:c02c7329c,c4db9667a
--chunk=c21c4112e:1:c02c7329c,c4db9667a
--chunk=c39611043:1:c02c7329c,c4db9667a
--chunk=c36791106:1:c02c7329c,c4db9667a
--chunk_output_path_prefix=$C/raw/
--property_renaming_report=$C/raw/property-renaming-report.txt
--variable_renaming_report=$C/raw/variable-renaming-report.txt
--rename_prefix_namespace=$gcc
--env=CUSTOM
--use_types_for_optimization=true
```

To re-capture on any future compiler version, temporarily wrap the binary:

```bash
cd node_modules/google-closure-compiler-linux-arm64
mv compiler compiler.real
printf '#!/bin/bash\n{ printf "=== ARGV\\n"; for a in "$@"; do printf "%%s\\n" "$a"; done; } >> /tmp/closure-argv.log\nexec "$(dirname "$0")/compiler.real" "$@"\n' > compiler
chmod +x compiler
# ... run the build, then: mv compiler.real compiler
```

Ad-hoc flag experiments do not need the wrapper — `GCC_CLOSURE_EXTRA_FLAGS`
(see `applyInternalClosureDebugOptions` in `src/build/closure/compiler.ts`)
appends space-separated `--flag[=value]` pairs to every job.
