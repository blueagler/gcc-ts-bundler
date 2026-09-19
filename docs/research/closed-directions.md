# Closed directions: what not to re-derive

Index of research directions that are **finished**. No source changed by this
document; it only records conclusions reached elsewhere.

**The rule.** An entry here was measured or source-proven dead, not merely
judged unpromising. Reopening one requires new evidence that _contradicts the
cited measurement_ — a different app, a different compiler tag, or a reading of
the named source symbol showing it says something else. A new intuition is not
new evidence, and neither is a plausible mechanism story: every entry below
already has one.

The historical table and its numbered notes use the same trial app and compiler,
so those entries do not repeat the basis: an Ant Design Pro admin, 2,352 modules, 7.1 MB of JS
reaching the plugin of which **94.1% is dependency code**, compiler
`google-closure-compiler-java@20260811.0.0` (`--version` → `v20260811`), `raw` =
emitted client chunk bytes and `gzip` = `gzip -9`, both summed over all 52
chunks. Against pure Vite's 780.4 KB gzip the plugin's ADVANCED default is
**+31.3 KB gzip (+4.0%)** and **−79.4 KB raw (−3.3%)**; the two axes disagree,
which is why several entries below are closed on one axis only.

---

## The table

| #   | direction                                                                                                                  | why it is dead                                                                                                                                                             | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | established in                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Compilation-level tiering — run vendor at `SIMPLE`/`WHITESPACE_ONLY`                                                       | SIMPLE is worse than the ADVANCED default, not a conservative choice                                                                                                       | `compilationLevel: SIMPLE` measured **+9.9%** gzip vs esbuild (857.7 KB vs 780.4 KB); ADVANCED beats SIMPLE by **5.4% gzip (−46.0 KB)** and 12.5% raw                                                                                                                                                                                                                                                                                                                         | `advanced-renaming-vs-gzip.md` §TL;DR + §6.3; `optimization-architecture.md` §3 table                              |
| 2   | `@closureUnaware` on vendor files                                                                                          | It forces exactly the mode that measured worse                                                                                                                             | `ClosureUnawareOptions.setSafeOptimizationAssumptions` forces `CompilationLevel.SIMPLE_OPTIMIZATIONS` for the nested compilation — see entry 1                                                                                                                                                                                                                                                                                                                                | `advanced-renaming-vs-gzip.md` §4; `optimization-architecture.md` §3 table ("forces the mode that measured worse") |
| 3   | `AliasStrings`                                                                                                             | Unreachable from argv at this tag, and its own source says it hurts the axis we care about                                                                                 | `--alias_all_strings` and `--alias_strings` both rejected by the pinned jar; source: _"gzip actually prefers that strings are not aliased"_, class comment: enabling it _"usually hurts code size after gzip"_. `setAliasStringsMode` is present but Java-API only                                                                                                                                                                                                            | `advanced-renaming-vs-gzip.md` §2; `optimization-architecture.md` §7 table                                         |
| 4   | Multistage `save`/`restore` and TypedAST — **for size only**                                                               | Historical unchanged-program output is byte-identical, so there is no size to win. Not an incremental typechecker for JS/extern edits; see the current qualification below | End-to-end probe: stage 1 saved 511,605 bytes, stage 2 saved 550,469 bytes, final JS **byte-identical** to a one-shot ADVANCED run, **gzip delta 0**                                                                                                                                                                                                                                                                                                                          | `advanced-renaming-vs-gzip.md` §3; `optimization-architecture.md` §3 table                                         |
| 5   | `--renaming=false` under ADVANCED                                                                                          | The CLI hard-refuses the combination; there is no ADVANCED-minus-renaming mode on argv                                                                                     | `CommandLineRunner.java:1708-1713` errors with `renaming cannot be disabled when ADVANCED_OPTIMIZATIONS is used`; accepted under SIMPLE only. Reachable only as `setPropertyRenaming(OFF)` through the Java API                                                                                                                                                                                                                                                               | `advanced-renaming-vs-gzip.md` §2; `optimization-architecture.md` §2 (C5) and §7 table                             |
| 6   | Narrowing generated externs by module list — `externs.generate.includeDependencies: false`, `externs.generate.modules: []` | The pins do not come from the module list, so narrowing it changes nothing                                                                                                 | Both variants emit **byte-identical** output and **exactly 1233** pins (2314.0 KB raw / 811.7 KB gzip, unchanged), each in its own work directory. Pins originate in the React host-element hazard analysis (`compat.classMapCalls` in `reactPreset`)                                                                                                                                                                                                                         | `prior-art-closure-frameworks.md` §4 table + result 2; `optimization-architecture.md` §3                           |
| 7   | Blanket `@record` → `@interface` rewrite                                                                                   | `@interface` is nominal and rejects object literals a TS interface legally accepts — and production suppresses the diagnostic, so the break would be silent                | `object literal -> @interface param` yields `WARNING - [JSC_TYPE_MISMATCH] actual parameter 1 of readA does not match formal parameter`; production passes `--hide_warnings_for=/`, which suppresses it                                                                                                                                                                                                                                                                       | `structural-types-defeat-renaming.md` §3; `optimization-architecture.md` §M3                                       |
| 8   | Searching for a compiler flag that reuses property names without type information                                          | No such option exists anywhere in the compiler; the only type-free reuse is for variables and is already on                                                                | Searched the whole `jscomp` tree, the `@Option` list and `CompilerOptions` setters: _"There is no type-free path to property-name reuse anywhere in the compiler."_ Type-free reuse is `RenameVars` `LOCAL_VAR_PREFIX` (`RenameVars.java:188-191`) and `CoalesceVariableNames` (`CoalesceVariableNames.java:50-63`, comment "better gzip compression") — both already enabled, neither touches properties                                                                     | `advanced-renaming-vs-gzip.md` §1 + §6.4                                                                           |
| 9   | Graph-derived branding of object-literal shapes (plan Phase 4 / architecture M2) on vendor-dominated React                 | The transform works; the candidate set is a long tail. Hot names that dominate gzip are pinned, escaping, or dynamically keyed                                             | oxc-parser 0.144.0, 2,484 files, 0 parse failures. Graph names 9,465; renaming-map union **4,478** (the "~8,400" figure was 4,452 + 3,963 overlapping maps). Strict candidates 1,284 / 823 already renamed (18.4%). Hottest useful renamed candidates: `getParser` 25 local refs. Hot excluded: `length` 2,063, `key` 1,760, `current` 1,755, `value` 1,754, `children` 1,648, `className` 1,646. `[INFERENCE]` ~1.5 KB gzip (strict) / ~10 KB (partial brand) vs 31.3 KB gap | `plan-repoint-and-simplify.md` Phase 4; `optimization-architecture.md` §M2 + §9                                    |

---

## Notes

Only the entries whose closure is conditional or whose failure mode is
non-obvious. The table is sufficient for the rest.

### 1 and 2 are the same result, reached twice

Tiering is bounded above by the pure-Vite number, because 94.1% of input is
dependency code and ADVANCED can therefore apply to at most 5.9% of the graph:
any scheme that keeps vendor out of ADVANCED removes a regression rather than
delivering a win (`advanced-renaming-vs-gzip.md` §6.3). `@closureUnaware` is the
compiler's own mechanized version of that scheme, so it inherits the same
ceiling _and_ the measured SIMPLE penalty.

An earlier revision of `advanced-renaming-vs-gzip.md` recommended vendor tiering
before the SIMPLE build existed; its correction notice is the reason entry 1 is
here rather than in a plan. Do not resurrect the retracted recommendation from
the mechanism description that still sits below it.

The one variant _not_ closed is `PerFileClosureUnawareMode.WHITESPACE` — nested
whitespace-only plus the existing esbuild pass, letting esbuild minify vendor
while ADVANCED handles authored code. That is untested, so it is not an entry.

### 4 is closed on the size axis only

The historical byte-identical result closes this unchanged-program probe as a
_wire-size_ lever. It does not establish incremental checking after edits.
CHECKS snapshots contain the whole checked JS/extern program; changes to those
inputs invalidate them, and restoring a snapshot does not replay its check
diagnostics. Restore also requires identical `--js` paths; a new path fails
with `IllegalStateException: Missing …`. The resident JVM already amortizes
startup, and identical jobs already use the output cache. See the
[v20260909 measurements and reuse constraints](optimization-architecture.md#v20260909-build-time-verification)
before adding another cache.

The _consume_ side of TypedAST — `setTypedAstListInputFilename` /
`initWithTypedAstFilesystem` — has no `@Option` at all and is called only from
`bazel/typedast.bzl` and `TypedAstIntegrationTest`, which is why Google's
library-shard ADVANCED is unreachable from an argv pipeline
(`advanced-renaming-vs-gzip.md` §3, `optimization-architecture.md` §7). A
per-library architecture remains a separate possible feature, not a small
cached-externs shortcut: consumption requires the relevant inputs to be
prechecked TypedAST and skips checks for the merged program.

### 5 is closed for argv, not for the compiler

`setPropertyRenaming(OFF)` combined with ADVANCED is a supported `CompilerOptions`
state that the CLI refuses to express. Everything this research called
"unreachable" was unreachable _from argv_
(`optimization-architecture.md` §2 C5). So entry 5 closes the flag hunt, not the
capability: it is one of the things a resident compiler driver unlocks.

### 6 — the pins are a hazard-rule output, not a module-list output

All three configurations ran as separate jobs in separate work directories, so
the option signature genuinely changed and the identical output is a real
negative rather than a cache hit. React compares host prop keys as runtime
strings, so the pin set is a function of the hazard rules; the module list never
enters into it.

Two adjacent facts, so they are not re-measured either. The pins do cost
**10.7 KB gzip / 75.8 KB raw**, measured by building with the React preset
removed (independently corroborated by a static estimate of 73.8 KB across
17,703 references). And removing every pin does **not** enable ambiguation —
reuse moves 7.6 → 7.9 while distinct ≤2-character names go _up_, 2333 → 2419 —
so pins and structural types are two independent blockers
(`prior-art-closure-frameworks.md` §4 results 1 and 3). The lever is fewer
hazard sites, not fewer modules.

### 7 — the danger is the silence, not the mismatch

`@record` is the faithful emission for a TypeScript interface: TS interfaces are
structurally typed and any matching object literal satisfies them, which is
`@record`'s semantics and not `@interface`'s
(`structural-types-defeat-renaming.md` §3). A blanket rewrite would feed the
optimizer a type graph that contradicts the program, and because production
passes `--hide_warnings_for=/` the `JSC_TYPE_MISMATCH` never surfaces.

What is closed is the _blanket_ rewrite. Per-interface classification at
emission time — `@interface` + `@implements` only where every satisfier in the
program is a class the pipeline also annotates, `@record` otherwise — is the
open version of the same idea (`structural-types-defeat-renaming.md` §4.1,
`optimization-architecture.md` §M3). Its ceiling is bounded by how many
interfaces are class-only, and by the fact that ambiguation poisoning is
per-property-name and program-wide: a React app shares `value`, `type`,
`children`, `className` and `current` with vendor object literals, so those names
stay unambiguatable however the app's own types are emitted.

### 8 — why the search cannot be repeated productively

The negative is exhaustive over the searched surface: the `jscomp` tree, the
`@Option` list, and the `CompilerOptions` setters. `AmbiguateProperties` is the
only pass that reuses property names, it is scheduled only when
`isTypecheckingEnabled()` (`DefaultPassConfig.java:616-619`), and it declines
because `InvalidatingTypes.isAmbiguousOrStructuralType` falls through to
`return true` for structural types, after which
`AmbiguateProperties.Property.addRelatedColor` sets `skipAmbiguating = true` for
that property name program-wide. Type information is the mechanism, not a
convenience — a flag that skipped it would have to be a different pass.

Production confirmation, so nobody re-runs the flag hunt hoping the toy probes
were unrepresentative: the real build's persisted renaming maps show 3,963 and
4,452 property entries mapping to 3,963 and 4,452 _distinct_ short names, **0
shared**. Those two files overlap; the union is **4,478**. Zero of 4,478
distinct renamed properties are ambiguated
(`prior-art-closure-frameworks.md` §4).

### 9 — the transform is not the constraint; the graph is

Phase 2 proved that a synthesized `@constructor @struct` brand plus a `@type`
cast is enough to make `AmbiguateProperties` fire on untyped object literals
(`g,h,i` / `j,l,m` → both `g,h,i`). That result still stands. What entry 9
closes is _applying_ it to this fixture: 18% of renamed names qualify, they
are a long tail, and the names that would move compression ratio (`value`,
`children`, `className`, `key`, `current`) fail every safety test. The
technique stays. Reopening the _fixture_ claim requires a different app
shape (authored-dominant, class-based TypeScript) or a measurement showing
the hot names are newly brandable. A better delivery mechanism
(`addCustomPass`) is not new evidence; a second fixture is.

## Newer API probes: scoped decisions, not global closures

These measurements use `google-closure-compiler@20260909.0.0` and separate
synthetic fixtures, **not** the historical Ant Design Pro application. They do
not establish official-example size gains or an end-to-end build speedup.

An 80-class Java-API probe produced 4,609 raw output bytes in 1,364 ms:

| Change                                         | Observation                                                                             | Decision                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Disable compiler threads                       | 1,351–1,375 ms; byte-identical output                                                   | No material repeatable benefit established; retain the existing policy |
| Disable property renaming through the Java API | 1,363–1,377 ms; 7,824 raw bytes                                                         | Do not trade a clear size regression for no demonstrated latency gain  |
| Save and restore `CHECKS` state                | Save about 1,089 ms; restore 932–956 ms; state 544,076 gzip bytes / 2,978,379 raw bytes | Not adopted as a production cache                                      |

The state-restore probe first failed with a null-pointer exception without
source-map state. Explicit source-map output allowed completion and preserved
the observed runtime values `[10, 89, 11]`, but produced 10,553 raw bytes rather
than the 4,609-byte baseline. Thus successful restore and a few matching values
did **not** establish equivalent optimization quality. This newer probe narrows
the historical recommendation to investigate incrementality; it does not prove
that all supported multistage paths are ineffective.

The resident worker remains a startup optimization with a fresh compiler and
runner per job, not a saved compiler-state cache. On a separate 217-byte output
fixture, native-image runs took 533–609 ms, cold JVM runs 1,371–1,530 ms, and warm
resident jobs 311–417 ms. Those timings do not imply resident JVMs beat native
images on every input.

Related ownership probes justified using existing APIs rather than adding new
cache layers:

- A 248-module native graph fixture improved from a seven-run median of
  11.25 ms to 6.92 ms. Pre-existing graph fields and nine dynamic-import/error
  cases matched; the newly introduced const-enum classification was explicitly
  empty on this enum-free fixture. This is graph-resolution latency, not a
  whole-build speedup.
- One TypeScript declaration emit plus five independent bundles took 440 ms
  versus 794 ms for repeated emits on the measured entry set.
- Invocation-scoped TypeScript resolution reuse reduced
  `fileExists`/`readFile`/`directoryExists` calls from `205/55/300` to `38/8/56`,
  and the measured batch from about 15 ms to 3.65 ms. A fresh invocation still
  observed a newly created package.
- Oxc scoping-only analysis retained 25,803 symbols, 25,801 references, 1,202
  scopes and identical binding fingerprints while reducing stored semantic
  nodes from 158,412 to zero. Paired median timings were
  5,199/5,892 µs with nodes and 4,259/4,395 µs without them. Measured child peak
  RSS stayed 48,392 KiB in all four runs: **no RSS reduction was established**.
  Hoist reference-ancestor analysis still needs the node store and retains it.

## 2026-09-16 pipeline experiments: scoped dispositions

This appendix records all 39 candidates, not 39 new optimizations. **Retained
(preexisting)** means a validated cut already present in the frozen baseline;
**retained (this pass)** identifies a new change. **Rejected** closes the
proposed cut for this evidence set, not every possible implementation.
**Unchanged** preserves the existing contract without claiming a new gain.
Decisions distinguish reduced work, fixture-only size opportunities and measured
whole-build behavior; a successful isolated rewrite is not a production escape
or ownership proof.

The experiment used Linux ARM64, the repository self-build and synthetic
semantic, ownership, cache and runtime fixtures, with Closure
`20260909.0.0`, Oxc `0.150.0` and runtime TypeScript `6.0.3` (the manifest
requests `6.0.2`; the project runtime resolves `6.0.3`). It does not
remeasure the historical Ant Design Pro application or official examples.
Frozen baseline/foundation snapshots and isolated variants separated earlier
cuts from this pass. Ordinary timing, instrumented work counts, warm JVMs and
cold processes are different populations; do not pool them. Later overlapping
representation/lifecycle runs are correctness evidence, not clean speed data.

### Measurement foundation

| #   | Exact task title                                    | Decision             | Boundary and evidence                                                                                                                                                                                |
| --- | --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Record frozen baseline and verification contracts   | Retained (this pass) | Frozen source/addon identities; compare runtime, CLI output and complete public declarations, not only successful compilation.                                                                       |
| 2   | Measure exclusive stage times and work counts       | Retained (this pass) | Opt-in versioned profile receipts partition wall time with `exclusiveMs`; nested build/self-build receipts and concurrent job durations must not be added. Disabled profiling emits no receipt.      |
| 3   | Separate cold unchanged and edited build benchmarks | Retained (this pass) | Separate cold, final-cache hit, implementation-edit and public-contract-edit states; the two-job probe observed cold 0 hits/2 misses, stabilized map reuse 2/0, body edit 1/1 and contract edit 0/2. |

The [workflow profiling contract](../development/workflows.md#debugging-controls)
defines receipt interpretation. Work-count reductions below are not inferred
wall-time savings, and a cache hit still validates and republishes artifacts.

### Frontend and semantic work

| #   | Exact task title                                        | Decision               | Boundary and evidence                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Share invocation resolution and file identity indices   | Retained (preexisting) | Resolution reuse is invocation/declaration-batch scoped; earlier calls fell from 205/55/300 to 38/8/56 (`fileExists`/`readFile`/`directoryExists`). Never retain process-wide negative results.                                                                  |
| 5   | Preserve source provenance throughout downstream stages | Retained (preexisting) | Authored identity survives lowering and Vite sidecars; relocation/symlink-retarget probes retained runtime 7 for identical content, then observed 9 after target edit and warm reuse.                                                                            |
| 6   | Invalidate resolution edges from complete dependencies  | Retained (this pass)   | Track consulted manifest bytes, declaration identity/content and importer-local lookup roots. Newly appearing/nearer declarations invalidate stale hits and preserve authored TS2322 location; identical-byte rewrites remain hits.                              |
| 7   | Reuse preflight semantic work during IR extraction      | Retained (preexisting) | Keep the same TypeWorld/checker, not a second program. Instrumented preflight recorded 371 types/330 instantiations; subsequent IR 3/3 and repeated IR 0/0.                                                                                                      |
| 8   | Evaluate incremental TypeScript program reuse           | Rejected               | No persistent TypeScript program/host added. Eleven edit epochs matched fresh semantics, but default `oldProgram` reparsed 144/144 files; content-owned reuse kept 143/144 while reading about 2.99 MB to validate. No production lifecycle benefit established. |
| 9   | Separate diagnostic coverage from emission requirements | Retained (preexisting) | Syntax filtering must not narrow preflight coverage; exact ordered diagnostics, error paths and recursive cases were compared. Vite metadata delivery still does not promise original-source semantic checking.                                                  |
| 10  | Index syntax once for metadata collectors               | Retained (this pass)   | SourceFile-identity index, unchanged collector order. Repeated scan/policy walks 177/88 → 0/0; cold metadata median 53.318 → 49.785 ms and repeated 18.634 → 17.890 ms. Quick/cold indexing does extra work; not a universal scan speedup.                       |
| 11  | Memoize repeated context safe semantic queries          | Retained (this pass)   | Successful checker-local alias/spelling/identity queries only; alias calls 175 → 13, type spelling 168 → 83, symbol spelling 249 → 6, canonical realpath 60 → 1. Failed-query count stayed 4.                                                                    |
| 12  | Separate semantic facts from Closure rendering          | Unchanged              | Existing semantic handoff and renderer ownership remain. Do not cache rendered types or recursion-sensitive diagnostics across contexts; no new persistent semantic representation justified.                                                                    |
| 13  | Emit metadata from proven consumer requirements         | Retained (preexisting) | Keep delivered declaration/member counts and real consumer templates; required diagnostic discovery is not removed merely because a native consumer only needs counts. No additional pruning adopted.                                                            |

Three isolated semantic samples preserved metadata, ordered diagnostics and
public/runtime contracts; IR-after-preflight median was 55.15 → 44.78 ms,
repeat 28.73 → 22.96 ms. Syntax equivalence covered 12 workers. These local
measurements do not add up to an end-to-end percentage. Ownership and lifetime
are specified in [Type metadata and the Oxc envelope](../development/architecture.md#type-metadata-and-the-oxc-envelope).

### Contract ownership and native emission

| #   | Exact task title                                         | Decision                                  | Boundary and evidence                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | Share Node ambient discovery across compiler jobs        | Retained (this pass)                      | One prepared-job invocation and complete free-global-set keys; 11 global sets, shadowing, legacy scripts and missing/broken-input behavior matched. Real ADVANCED Node runtime passed. Three self-build medians 17,614 → 17,593 ms establish no end-to-end gain. |
| 15  | Scope generated external contracts by proven ownership   | Unchanged                                 | Retain existing complete declaration fragments and owner-based selection. Reject new per-job extern pruning: the probe still generated the aggregate and would need job-local native replacement; smaller selected text is not avoided generation.               |
| 16  | Keep explicit and serialized boundary contracts complete | Retained (preexisting)                    | Explicit/public typed externs, native carriers, namespace initializers and serialized keys remain. Same-TypeWorld aggregate/selected consumer probes preserved full contracts and typed-statement multiplicity; producer-variable uniqueness remains checked.    |
| 17  | Collapse ownership cycles into component graph           | Retained (this pass)                      | Iterative SCC analysis only when declaration closures overlap; preserve order, independent diagnostic multiplicity and shared namespace ownership. Forty randomized graphs and a 50,000-node chain matched.                                                      |
| 18  | Propagate compact canonical module owner sets            | Retained (this pass)                      | Compact BigInt owner sets cover 1–129 modules, cycles and late overlap; disjoint closures bypass SCC factoring. Namespace sharing alone is not declaration overlap.                                                                                              |
| 19  | Measure ownership factoring crossover and overhead       | Retained (this pass)                      | Nine-sample medians, 20,000 symbols/129 modules: shared 575.27 → 10.14 ms, disjoint 10.02 → 9.12 ms. Real 486-symbol declarations regressed 1.195 → 1.475 ms; retain for scaling, not a claimed real-build win.                                                  |
| 20  | Eliminate proven duplicate native reads and conversions  | Retained (this pass and preexisting cuts) | Ordinary PURE discovery now borrows parsed source; decorator effective-file fallback stays. Nine paired runs preserved result/artifact bytes; medians 35.599 → 35.691 ms show no latency win. No measured syscall reduction claimed.                             |
| 21  | Preserve narrow native preparation metadata transfer     | Retained (preexisting)                    | N-API preparation transfers counts and emitted filenames, not full templates or rewritten source. TypeScript consumers retain their complete declarations; no extra native/source cache.                                                                         |
| 22  | Evaluate dependency aware incremental native emission    | Rejected                                  | No new incremental native graph/state cache. Keep existing emitted-artifact identities including chunk membership, opaque externals and runtime-map sidecars; nine identity epochs passed with profiling both enabled and disabled.                              |

[External-boundary ownership](../development/architecture.md#external-boundaries-and-compilation)
and the [persistent-cache contract](../development/architecture.md#persistent-cache)
are the durable implementation boundaries. Node same-set rendering took
16.545 → 0.022 ms in one ordered probe, not a repeatable whole-build estimate.
Its sampled process-tree RSS was 1,742 versus 1,715 MiB; child-only peaks would
misrepresent the tradeoff. Native source borrowing is retained as elimination
of known duplicate work despite neutral timings, not as a measured speed claim.

### Compiler critical path

| #   | Exact task title                                            | Decision                                | Boundary and evidence                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | Compare single and dual resident compiler workers           | Retained (this pass), opt-in only       | Default one lazy worker; `GCC_CLOSURE_CONCURRENCY=2` permits at most two. Four matched self-build walls: one 18,702/18,518 ms, two 18,029/18,263 ms; exact runtime/CLI/declaration contracts matched.                                                                                        |
| 24  | Overlap independent core and preset compiler jobs           | Retained (this pass), opt-in only       | Only independent prepared jobs overlap; a connected core graph is not split. Eight-job/three-round synthetic batches: one 23,727/23,491 ms, two 15,857/15,053 ms; no surviving workers after those performance probes.                                                                       |
| 25  | Schedule compiler work using measured job costs             | Rejected                                | No production cost sort. Three-run medians: foundation 17,614, ambient 17,593, sort 17,574, ambient+sort 17,635 ms; semantics and scheduling/error/result-order probes passed, but no repeatable benefit.                                                                                    |
| 26  | Measure startup warmth contention and memory tradeoffs      | Retained (this pass), default unchanged | Priming is not timing evidence. Real-self-build tree RSS: one 1,592/1,587 MiB, two 2,097/2,098 MiB; about 2.5% lower wall time costs about 32% more sampled RSS. All 22 final one/two-worker lifecycle cases passed with zero survivors.                                                     |
| 27  | Remove unnecessary generated scaffolding before Closure     | Unchanged                               | Reject blanket namespace/getter/reverse-map/registry removal. Closed-fixture alternatives below preserve observed runtime but do not prove production escape, initialization-order or ownership eligibility. CommonJS dependency order and receiver identity remain required.                |
| 28  | Identify representations causing repeated optimization work | Unchanged                               | Instrumented baseline/alternate pairs for enum, helper, literal namespace and static re-export all retained `removeUnusedCode` 6, `inlineFunctions` 2, `inlineVariables` 4 and peephole 5 iterations. No iteration reduction or causal churn improvement established; no new pass installed. |
| 29  | Measure optimization output size and runtime equivalence    | Unchanged                               | Three-sample runtime/raw/gzip comparisons below preserve both successful closed alternatives and falsified shortcuts. Overlapping timing samples establish no latency win; fixture-only byte savings do not authorize a general rewrite.                                                     |
| 30  | Evaluate shared preparation core Vite job partitioning      | Rejected                                | Actual core/CLI/Vite entries share one connected compiler component. Keep shared preparation and complete contracts; do not invent independent jobs or claim a speedup from fewer extern lines.                                                                                              |

Resident reuse amortizes startup but always creates a fresh compiler/runner per
job; no persistent compiler-state/CHECKS cache is introduced. RSS is the sampled
sum across the child tree, not PSS or an exact between-sample maximum.

The final lifecycle matrix passed **11 scenarios at each of one and two
workers**, including compiler errors, disabled-driver fallback, corrupt replies,
worker/startup exits, parent exits during startup/in-flight work, stubborn
shutdown and hung readiness/jobs. Every supervisor recorded zero surviving
owned processes. Hung-job cases took **633.55 / 632.36 seconds** with production
timeouts unchanged; no shortened test timeout stood in for recovery.
The containing experiment matrix retained its earlier observer/applicability
failures; corrected native-identity, exact-extern, scheduling and representation
receipts supersede those failures, not the known live-update baseline failure.

The representation probes exercised actual native-linked inputs and ADVANCED
output. Counts and bytes below are per fixture, not the self-build:

| Probe-only alternate                  | Matched edits | Emitted raw bytes | Emitted gzip bytes | Decision                                                                                              |
| ------------------------------------- | ------------- | ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| Plain namespace object                | 1             | 1,521 → 1,309     | 818 → 753          | Reject: loses getter/read-only behavior and null prototype despite stable identity                    |
| Eager immutable cross-chunk re-export | 2             | 1,748 → 1,700     | 914 → 904          | Runtime values and repeated lazy identity match; no general initialization/cycle proof, not installed |
| Forward-only closed numeric enum      | 96            | 2,822 → 2,001     | 1,097 → 860        | Runtime matches; no production escape classifier proven, not installed                                |
| Reflected enum reverse-map removal    | 3             | 128 → 103         | 116 → 101          | Reject: reflected runtime values change                                                               |
| Literal-only namespace IIFE           | 32            | 1,277 → 1,135     | 598 → 523          | Closed fixture matches; fresh-owner/alias proof is not generalized, not installed                     |
| Namespace side effects and closures   | 0             | 548 → 548         | 260 → 260          | Guard correctly preserves the boundary; a no-op is not a win                                          |
| Pooled helper function declaration    | 1             | 1,867 → 1,867     | 1,041 → 1,041      | Equivalent output; no measured size benefit, not installed                                            |

The cross-static and literal-namespace probes initially matched zero edits
because their matchers did not recognize actual generated binding getters and
`const local = namespace.member = literal` bodies. Corrected matchers exercised
the reported edits; original no-op receipts were not counted as successes.
The cross-chunk live-update **baseline** failed when emitted lazy code attempted
to increment an imported read-only binding. Both original lanes failed before
a meaningful alternate comparison; this is a recorded baseline limitation,
not proof that a shortcut is safe or that this pass fixed it.

Residual CommonJS registration was exercised through a supported ESM package
wrapper, not unsupported authored CommonJS. Dependency order, `module.exports`,
top-level receiver equality and repeated lazy identity passed; registration is
load-bearing and remains. Self-build measurements contained no emitted enum
candidate, so the closed-enum fixture gain is not a self-build gain.

### Incremental reuse and publication

| #   | Exact task title                                            | Decision               | Boundary and evidence                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 31  | Reuse unchanged file syntax discovery safely                | Retained (this pass)   | Reuse by unchanged SourceFile identity only; content-owned incremental-host experiments are not installed as persistent production state. Fresh invocations must observe new resolution results.                                                                                                                         |
| 32  | Reuse semantic results with dependency fingerprints         | Unchanged              | Existing validated artifacts remain; no process-global semantic cache. Ambient/dependency/resolution edits changed semantics even with the same file count and own public-declaration digest. Shape/count/mtime are insufficient keys.                                                                                   |
| 33  | Separate implementation and public contract invalidation    | Retained (preexisting) | Two-job probe: implementation edit reused one job, public-contract edit reused neither; emitted artifacts and runtime values were checked. Do not infer semantic stability solely from own declaration bytes.                                                                                                            |
| 34  | Invalidate only genuinely affected Closure compiler jobs    | Retained (preexisting) | Effective JS, externs, environment, inference and renaming-map identity govern reuse. Stable-map unchanged work hit 2/2; version/environment/inference/artifact-corruption fences passed. No broader shortcut added.                                                                                                     |
| 35  | Verify compiler snapshot reuse boundaries after edits       | Retained (preexisting) | Fresh shipped-content snapshots detect add, same-size edit, rename and native-addon edit; restores match. Source-only TS outside shipped identity intentionally does not invalidate. No process-lifetime snapshot memo.                                                                                                  |
| 36  | Avoid redundant postprocessing copies and unchanged writes  | Rejected               | Keep current publisher. Two-artifact CJS probe: unchanged production copied two, cache-off copied zero; candidate skipped two but read/hashed them. Single-probe cold 0.393 → 0.808 ms, unchanged 0.132 → 0.170 ms justify no speed claim or new no-copy scheme.                                                         |
| 37  | Preserve atomic publication and resource cleanup guarantees | Retained               | Keep existing publication/cleanup ownership. The probe-only publisher preserved old bytes on pre-rename failure; after first rename, one new/one old complete file remained. Recovery, no staging leftovers and an unowned sentinel passed. This does not establish production batch atomicity or filesystem durability. |

The [publication and failure invariants](../development/architecture.md#delivery-invariants)
remain authoritative: validate canonical bytes, stage before committing, drain
writers before cleanup, retain lock ownership and report cleanup errors. An
unchanged cache hit still republishes rather than trusting destination bytes.

### Final acceptance

| #   | Exact task title                                      | Decision                          | Boundary and evidence                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38  | Run full correctness size and performance gates       | Retained (this pass), scope below | Correctness, matched end-to-end and complete application/package size measurements are recorded below. Application output is byte-identical; compiler package growth and neutral build timing are explicit costs, not hidden by a passing fixture gate. |
| 39  | Record every retained and rejected experiment outcome | Retained (this pass)              | This six-phase inventory records every title once, separates preexisting cuts from new changes and preserves negative/inapplicable results without inventing gains.                                                                                     |

Completed proof supplied by the executing coordinator: **435 Bun tests in 40
files, 2,179 assertions, zero failures** against freshly rebuilt outputs;
**208 Rust tests**, Rust formatting/Clippy; both TypeScript configurations,
Oxlint and repository format check passed. The combined cache-off two-stage
self-build was **byte-identical**, with 273 sources, six entries and 12 declared
paths. These checks preceded this documentation-only appendix; none was rerun
to write it. A self-hosting fixpoint is not proof of every consumer's runtime.

Final profile-disabled self-builds alternated baseline/current/current/baseline/
baseline/current with the same logical workspace and pinned addons. Baseline
walls were **18,340 / 18,759 / 18,670 ms**; combined walls were **18,645 / 18,430 /
18,562 ms**. Median 18,670 → 18,562 ms (about 0.6%) establishes **no material
whole-build speedup**. Sampled tree-RSS peaks were baseline **1,651 / 1,640 /
1,643 MiB**, combined **1,682 / 1,676 / 1,824 MiB**. All six preserved exact CLI
output, public declarations and the emitted compiler's runtime result `42`.
With the concurrency override unset, each observed at most one resident JVM.

The nine cold/warm/edit/resolution/corruption fixture scenarios preserved exact
diagnostics, runtime values, cache-hit behavior and all 24 emitted artifacts.
The zero-tolerance application size gate passed on both raw and gzip axes.
Because the existing gate selects `.js` only, the `.mjs` artifacts were copied
byte-for-byte into owned staging paths ending in `.mjs.js`; content hashes were
checked before measuring. No source or output was rewritten to satisfy the gate.

Separately, all 14 emitted compiler `.js`/`.mjs` files totaled **409,579 →
414,154 raw bytes** and **130,258 → 132,130 gzip bytes**: **+4,575 raw (+1.12%)**
and **+1,872 gzip (+1.44%)**. This is compiler-package growth, not an application
size win; the passing application gate does not conceal it. Measurements and
boundaries are recorded here rather than relying solely on disposable probes.

### Measured critical-path continuation

This continuation froze the completed 39-item implementation above as its new
baseline. The selected compiler was bootstrapped separately, then every timed
self-build compiled the same frozen source tree in the same logical workspace
with the same native addon. Instrumentation did not become part of the input
workload. Three initial baseline runs and the instrumented run produced exactly
the same complete emitted artifact inventories, hashes and public declarations.

Detailed profiling found full IR extraction at **2,686 ms**: external-origin
discovery **1,284 ms**, per-file ownership **629 ms**, and per-file metadata
collection **696 ms**. Extern planning took **1,711 ms**, of which usage discovery
was **1,604 ms**, including **64,294 `getSymbolAtLocation` calls** costing
**1,504 ms**. Declaration scanning was only **24 ms**; repeated declaration
discovery was not the dominant target. These are instrumented partitions,
not additive end-to-end speed estimates.

Two changes were retained:

- **Origins-owned immutable lookup reuse.** Ordered type identities, normalized
  source filenames and file-provenance answers are cached within one collection.
  File-origin inputs are finalized before cache construction. Membership in the
  subsequently populated boundary-type and owned-property sets stays live;
  recursion-sensitive boundary results are not memoized. A real-checker smoke
  exercised merged interfaces, generic aliases, recursive unions, shadows,
  boundary-set updates and different origins collections over the same Program.
- **Conservative extern query filtering.** A statement-list index gathers
  namespace-import spellings before use traversal, including declaration files
  and nested ambient modules. Unrelated identifiers skip semantic lookup;
  candidates still resolve symbols, and local export aliases remain semantic
  regardless of spelling. Existing selection tests gained forward-reference
  and nested ambient-type cases. Export/member coverage was not pruned.

Initial three-sample self-build medians were **17,700 ms baseline**,
**17,009 ms IR-only**, and **17,133 ms extern-only**. All six isolated builds
matched complete baseline outputs. Final uninstrumented runs alternated
baseline/combined/combined/baseline/baseline/combined. Baseline walls were
**17,647 / 17,943 / 17,496 ms**; combined walls were
**16,866 / 16,754 / 16,664 ms**. Median **17,647 → 16,754 ms** is a measured
**5.1% whole-self-build improvement** for this workload, not a general
application-build guarantee.

Sampled process-tree RSS was baseline **1,683 / 1,683 / 1,685 MiB**, combined
**1,632 / 1,652 / 1,805 MiB**. Each observed at most one JVM. The combined
high-water sample was higher; no memory-reduction claim is made.

Complete matched self-build artifacts, CLI output, public declarations and
runtime result `42` remained equal. The nine cache/edit/resolution/corruption
scenarios and aggregate/fragment extern contracts, including accepted and
rejected Closure consumers, matched the fresh baseline. All **24 application
artifacts** remained byte-identical: **1,968 raw / 2,208 gzip bytes** on each
side. The existing zero-tolerance size gate passed using exact-byte `.mjs.js`
staging copies. Separately, all **14 shipped compiler `.js`/`.mjs` files**
grew **414,154 → 414,670 raw bytes (+516, 0.12%)** and
**132,130 → 132,362 gzip bytes (+232, 0.18%)**, measured with the same Bun
`gzipSync` level 9 implementation as the project gate.

Production verification passed both TypeScript configurations, Oxlint, source
formatting, **435 Bun tests / 2,181 assertions / zero failures**, the rebuilt
CLI help path and a cache-off two-stage **byte-identical self-hosting fixpoint**.
Public declarations remained byte-identical. No Rust source changed; the prior
208-test Rust proof was reused rather than presented as a new run.

Raw receipts, profiler output, candidate source snapshots, smoke code and final
gate logs are archived in `.tmp/critical-path-20260916.tar.gz`. Temporary probe
drivers were removed after archive integrity and readback verification.

### Contextual property-fact continuation

The next pass froze the updated compiler above and profiled contextual ownership
again. Pair visitation was already deduplicated; no additional pair-result cache
or traversal pruning was added. The remaining repetition was in checker facts:

| Contextual checker operation | Before calls | After calls |
| --- | ---: | ---: |
| Property type at declaration | 2,387,512 | 19,860 |
| Property lookup by type/name | 1,261,190 | 58,141 |
| Property enumeration | 152,722 | 152,722 |
| Type arguments | 9,804 | 9,804 |

Retained phase-local reuse removes **99.2%** of property-type queries and
**95.4%** of property lookups. Property types retain both symbol and declaration
identity; instantiated generic properties must not collapse onto their shared
declaration. Receiver-type/name lookups also retain missing-property answers
only for this phase. Use-site queries, traversal, ownership accumulation and
recursion handling remain unchanged. Enumeration was only about 20 ms in the
probe and was deliberately left alone. Observer overhead scales with query
count, so instrumented phase timings are not treated as the measured speedup.

Two balanced, profile-disabled comparisons supplied six runs per version.
Baseline walls were **17,168 / 16,981 / 16,921 / 16,884 / 17,105 / 16,888 ms**;
candidate walls were **16,764 / 16,876 / 16,788 / 16,676 / 16,415 / 16,655 ms**.
Median **16,951 → 16,720 ms** is a further **1.36% whole-self-build improvement**
against this pass's updated baseline. It is not an additive percentage or an
application-build guarantee. All twelve emitted complete baseline artifact
inventories, hashes, CLI output, runtime result `42` and public declarations.
Sampled tree RSS ranged **1,586–1,657 MiB baseline** and
**1,599–1,668 MiB candidate**; each observed at most one JVM. No memory win is
claimed.

The retained regression exercises ownership through a forwarded external call
and distinguishes required generic properties from unrelated local properties.
A direct imported call intentionally preserves the complete actual argument
graph and would not isolate this contextual path. The regression passes on the
baseline and candidate, but a deliberate declaration-only cache mutation loses
the second generic instantiation's ownership and fails. A separate real-checker
smoke also compared full ownership snapshots for recursive unions, generic
aliases, mapped/readonly containers and repeated collections.

Both TypeScript configurations, Oxlint, formatting and **436 Bun tests /
2,185 assertions / zero failures** passed. The cache-off two-stage self-hosting
build remained byte-identical. Fresh cache/edit/resolution/corruption and
aggregate/fragment extern-contract receipts matched. All **24 application
artifacts** remained byte-identical and passed the zero-tolerance size gate:
**1,968 raw / 2,208 gzip bytes** on each side. Public declarations were unchanged.
The complete **14-file compiler JavaScript** inventory grew
**414,670 → 414,890 raw bytes (+220, 0.05%)** and
**132,362 → 132,427 gzip bytes (+65, 0.05%)**, using the project gate's Bun
gzip level 9 implementation. No Rust source changed; no new Rust run is claimed.

Evidence, source snapshots, mutation/smoke fixtures and gate logs are archived
in `.tmp/contextual-facts-20260916.tar.gz`. The owned temporary workspaces were
removed after archive integrity and readback verification.

### Conservative namespace IIFE unwrap

The earlier probe-only "Literal-only namespace IIFE" alternate (1,277 → 1,135 raw,
598 → 523 gzip) replaced the generated object. That remains rejected: it needs a
fresh-owner/alias proof that production code does not have.

A later pass only unwraps the IIFE. Eligibility is a non-ambient, non-exported,
unmerged top-level namespace in an ESM file with a real import/export marker,
DirectEval-free, whose body is unread `export const` identifier bindings with
TS-peeled literals, and whose SymbolId has no authored writes, redeclarations, or
export. After oxc lowering, the generated pair must be `var N;` plus
`(function(_N){ const a = _N.a = lit; })(N||(N={}))` with the empty-object init
as the sole outer write. Flattening keeps that init and every property write in
order, rewriting only the parameter identifier onto `N`. Private-class helper
rebuilds skip the pass because SymbolIds would be stale. Unary minus, objects,
local reads, exported/merged namespaces, and setter-driven reassignment of `N`
keep the wrapper.

This is not reverse-map deletion. Inherited setters still observe each write;
`this` is the namespace object. The existing tests "literal namespace
initialization preserves inherited setters and their owner" and "namespace
initialization retains its captured owner after setter reassignment" both pass.
The second case has an authored write, so it is not flattened and still uses the
IIFE-captured parameter after `N` is replaced.

ADVANCED corpus (15 programs, chunks off / bundler-runtime / split; numeric,
repeated, mixed, 1–32 members) never grew. Runtime strings matched frozen.
Numeric/repeated cases lost the extra `b=a||={}` alias, e.g. two-member output
`var a,b=a||={};b.a=0,b.b=1` → `var a;a||={},a.a=0,a.b=1`. Mixed cases with
unary minus stayed byte-identical. Totals **6,016 → 5,662 raw (−354)** and
**3,489 → 3,254 gzip (−235)**. All **24 application fixture artifacts** stayed
**1,968 raw / 2,208 gzip**, byte-identical. No compiler JavaScript inventory
change; native lowering only.
