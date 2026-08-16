# Closed directions: what not to re-derive

Index of research directions that are **finished**. No source changed by this
document; it only records conclusions reached elsewhere.

**The rule.** An entry here was measured or source-proven dead, not merely
judged unpromising. Reopening one requires new evidence that *contradicts the
cited measurement* — a different app, a different compiler tag, or a reading of
the named source symbol showing it says something else. A new intuition is not
new evidence, and neither is a plausible mechanism story: every entry below
already has one.

All size numbers come from the same trial app and compiler, so the entries do
not repeat the basis: an Ant Design Pro admin, 2,352 modules, 7.1 MB of JS
reaching the plugin of which **94.1% is dependency code**, compiler
`google-closure-compiler-java@20260811.0.0` (`--version` → `v20260811`), `raw` =
emitted client chunk bytes and `gzip` = `gzip -9`, both summed over all 52
chunks. Against pure Vite's 780.4 KB gzip the plugin's ADVANCED default is
**+31.3 KB gzip (+4.0%)** and **−79.4 KB raw (−3.3%)**; the two axes disagree,
which is why several entries below are closed on one axis only.

---

## The table

| # | direction | why it is dead | evidence | established in |
|---|---|---|---|---|
| 1 | Compilation-level tiering — run vendor at `SIMPLE`/`WHITESPACE_ONLY` | SIMPLE is worse than the ADVANCED default, not a conservative choice | `compilationLevel: SIMPLE` measured **+9.9%** gzip vs esbuild (857.7 KB vs 780.4 KB); ADVANCED beats SIMPLE by **5.4% gzip (−46.0 KB)** and 12.5% raw | `advanced-renaming-vs-gzip.md` §TL;DR + §6.3; `optimization-architecture.md` §3 table |
| 2 | `@closureUnaware` on vendor files | It forces exactly the mode that measured worse | `ClosureUnawareOptions.setSafeOptimizationAssumptions` forces `CompilationLevel.SIMPLE_OPTIMIZATIONS` for the nested compilation — see entry 1 | `advanced-renaming-vs-gzip.md` §4; `optimization-architecture.md` §3 table ("forces the mode that measured worse") |
| 3 | `AliasStrings` | Unreachable from argv at this tag, and its own source says it hurts the axis we care about | `--alias_all_strings` and `--alias_strings` both rejected by the pinned jar; source: *"gzip actually prefers that strings are not aliased"*, class comment: enabling it *"usually hurts code size after gzip"*. `setAliasStringsMode` is present but Java-API only | `advanced-renaming-vs-gzip.md` §2; `optimization-architecture.md` §7 table |
| 4 | Multistage `save`/`restore` and TypedAST — **for size only** | Output is byte-identical, so there is no size to win. Still the right tool for build-time incrementality | End-to-end probe: stage 1 saved 511,605 bytes, stage 2 saved 550,469 bytes, final JS **byte-identical** to a one-shot ADVANCED run, **gzip delta 0** | `advanced-renaming-vs-gzip.md` §3; `optimization-architecture.md` §3 table |
| 5 | `--renaming=false` under ADVANCED | The CLI hard-refuses the combination; there is no ADVANCED-minus-renaming mode on argv | `CommandLineRunner.java:1708-1713` errors with `renaming cannot be disabled when ADVANCED_OPTIMIZATIONS is used`; accepted under SIMPLE only. Reachable only as `setPropertyRenaming(OFF)` through the Java API | `advanced-renaming-vs-gzip.md` §2; `optimization-architecture.md` §2 (C5) and §7 table |
| 6 | Narrowing generated externs by module list — `externs.generate.includeDependencies: false`, `externs.generate.modules: []` | The pins do not come from the module list, so narrowing it changes nothing | Both variants emit **byte-identical** output and **exactly 1233** pins (2314.0 KB raw / 811.7 KB gzip, unchanged), each in its own work directory. Pins originate in the React host-element hazard analysis (`compat.classMapCalls` in `reactPreset`) | `prior-art-closure-frameworks.md` §4 table + result 2; `optimization-architecture.md` §3 |
| 7 | Blanket `@record` → `@interface` rewrite | `@interface` is nominal and rejects object literals a TS interface legally accepts — and production suppresses the diagnostic, so the break would be silent | `object literal -> @interface param` yields `WARNING - [JSC_TYPE_MISMATCH] actual parameter 1 of readA does not match formal parameter`; production passes `--hide_warnings_for=/`, which suppresses it | `structural-types-defeat-renaming.md` §3; `optimization-architecture.md` §M3 |
| 8 | Searching for a compiler flag that reuses property names without type information | No such option exists anywhere in the compiler; the only type-free reuse is for variables and is already on | Searched the whole `jscomp` tree, the `@Option` list and `CompilerOptions` setters: *"There is no type-free path to property-name reuse anywhere in the compiler."* Type-free reuse is `RenameVars` `LOCAL_VAR_PREFIX` (`RenameVars.java:188-191`) and `CoalesceVariableNames` (`CoalesceVariableNames.java:50-63`, comment "better gzip compression") — both already enabled, neither touches properties | `advanced-renaming-vs-gzip.md` §1 + §6.4 |

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
ceiling *and* the measured SIMPLE penalty.

An earlier revision of `advanced-renaming-vs-gzip.md` recommended vendor tiering
before the SIMPLE build existed; its correction notice is the reason entry 1 is
here rather than in a plan. Do not resurrect the retracted recommendation from
the mechanism description that still sits below it.

The one variant *not* closed is `PerFileClosureUnawareMode.WHITESPACE` — nested
whitespace-only plus the existing esbuild pass, letting esbuild minify vendor
while ADVANCED handles authored code. That is untested, so it is not an entry.

### 4 is closed on the size axis only

Multistage is incrementality, not size. The byte-identical result kills it as a
*wire-size* lever and simultaneously recommends it as a build-time one: caching
the `CHECKS` segment is exactly what `save`/`restore` is for, against 153 ms of
JVM start and jar load per spawn on a ~17 s compile
(`optimization-architecture.md` §8). Restore requires identical `--js` paths;
a new path fails with `IllegalStateException: Missing …`.

The *consume* side of TypedAST — `setTypedAstListInputFilename` /
`initWithTypedAstFilesystem` — has no `@Option` at all and is called only from
`bazel/typedast.bzl` and `TypedAstIntegrationTest`, which is why Google's
library-shard ADVANCED is unreachable from an argv pipeline
(`advanced-renaming-vs-gzip.md` §3, `optimization-architecture.md` §7). Pursuing
it as a build-time or per-library feature is open; pursuing it for bytes is not.

### 5 is closed for argv, not for the compiler

`setPropertyRenaming(OFF)` combined with ADVANCED is a supported `CompilerOptions`
state that the CLI refuses to express. Everything this research called
"unreachable" was unreachable *from argv*
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
reuse moves 7.6 → 7.9 while distinct ≤2-character names go *up*, 2333 → 2419 —
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

What is closed is the *blanket* rewrite. Per-interface classification at
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
were unrepresentative: the real build's persisted renaming maps show 3963 and
4452 property entries mapping to 3963 and 4452 *distinct* short names, **0
shared**. Zero of ~8,400 properties are ambiguated
(`prior-art-closure-frameworks.md` §4).
