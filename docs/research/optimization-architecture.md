# The size problem is structural: value model, constraints, and where to change

Historical design rationale, not the current implementation reference.
Measurements, line counts, and “today” statements below describe the investigated
snapshot; proposed changes are not a list of remaining work. See
[Architecture](../development/architecture.md) for the implemented pipeline and
[closed directions](closed-directions.md) for scoped negative results.

This document takes the measurements in
`advanced-renaming-vs-gzip.md`,
`structural-types-defeat-renaming.md`, and
`prior-art-closure-frameworks.md` as given and asks what the
architecture should be. Every number below is measured on the Ant Design Pro
trial app (2,352 modules, 94.1% dependency bytes) with the pinned compiler
`v20260811`, except where marked `[INFERENCE]`. That app is a **negative
fixture** for an ultimate optimizer — a worst-case fact graph — not the
product fitness function.

---

## 1. The root problem is a value inversion, and it is arithmetic

Closure ADVANCED offers three things. Priced individually on this app:

| what ADVANCED offers         | measured contribution                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- |
| whole-program DCE + inlining | part of a **−46.0 KB gzip** win over SIMPLE                                     |
| property renaming            | the other part of that −46.0 KB, but it _costs_ compression ratio (3.08 → 2.85) |
| property **ambiguation**     | **0 KB. 0 of ~8,400 properties ambiguated.**                                    |

And the plugin's own pipeline costs, measured at SIMPLE where no property
renaming exists at all:

```
plugin overhead vs esbuild        +77.3 KB gzip
optimization value extracted      -46.0 KB gzip
                                  -----------
net                               +31.3 KB gzip   (+4.0%)
```

**The overhead exceeds the entire optimization value the pipeline extracts.**
That is the root problem stated exactly. It is not "renaming is bad" — renaming
is worth 46 KB here. It is that we pay 77 KB to collect 46 KB, while the one
pass that would make the trade decisively profitable contributes nothing.

Of the 77.3 KB overhead, 10.7 KB is the 1233 generated `Object.prototype.X`
extern pins, measured by building without the React preset. The remaining
~20 KB (after renaming's recovery) is runtime preamble, 181 module-registry
calls, chunk conversion, and Closure's non-renaming minification being weaker
than esbuild's on this code.

## 2. Five constraints that any architecture must respect

These are load-bearing and each is measured or source-proven.

**C1 — Ambiguation is the only gzip-positive type-driven pass, and it requires
nominal receivers.** `AmbiguateProperties` exists to give unrelated types the
_same_ short name ("This allows better compression"). `RenameProperties` does
the opposite: `generateNames` mints a unique name per property and reserves it.
Our output has 2,333 distinct ≤2-char names at reuse 7.6; esbuild's has 349 at
reuse 16.0. That gap _is_ the regression.

**C2 — No type-free property-name reuse exists anywhere in the compiler.**
Searched the whole `jscomp` tree, the `@Option` list, and `CompilerOptions`. The
only type-free reuse is for variables (`RenameVars` `LOCAL_VAR_PREFIX`,
`CoalesceVariableNames`) and is already on. There is no flag to find.

**C3 — Our type emission is structurally incapable of enabling C1.** We emit
`/** @record */` for TypeScript interfaces (`closure_metadata.rs:266`).
`@record` is structural; `InvalidatingTypes.isAmbiguousOrStructuralType` returns
true for structural types; `addRelatedColor` then bans that property name
program-wide. `@interface` + `@implements` and plain ES classes do ambiguate —
but `@interface` is nominal and rejects the object literals a TS interface
legally accepts, and our `--hide_warnings_for=/` would swallow that mismatch.

**C3 is a property of what we emit, not a property of the input.** Measured on
the pinned jar with the production flag set (`--compilation_level ADVANCED
--warning_level QUIET --jscomp_warning=checkTypes --hide_warnings_for=/`): two
unrelated **untyped** three-property object literals, each consumed through a
plain function, rename to `g,h,i` and `j,l,m` — **six distinct short names, no
ambiguation**. The same literals with a synthesized nominal brand — a
`/** @constructor @struct */ function Brand$A(){}` declaration per shape,
`@type {number}` prototype members, the reader functions annotated
`@param {!Brand$A}`, and each literal wrapped in a `/** @type {!Brand$A} */ (…)`
cast — both shapes rename to `g,h,i`: **identical names, ambiguation fires.**

That is the decisive result in this corpus. Ambiguation needs a nominal
_receiver_, not TypeScript. A brand plus a cast is sufficient, and it is
sufficient on exactly the shape 94.1% of our bytes are: untyped vendor object
literals. C3 therefore states a defect in our emitter, not a ceiling on the
input, and §7 records what follows from that.

**C4 — The correctness barrier is a global name ban, and it is an independent
blocker.** Removing all 1233 pins recovers 10.7 KB gzip but does **not** enable
ambiguation (reuse 7.6 → 7.9, distinct short names _up_). Pins and structural
types are two separate walls; clearing one leaves the other.

**C5 — The CLI is a strict subset of the compiler.** Closure jobs still speak
argv (resident CLI worker, or `java -jar` fallback). Decisive controls exist only behind `CompilerOptions`:
`setPropertyRenaming(OFF)` combined with ADVANCED (the CLI hard-errors:
`renaming cannot be disabled when ADVANCED_OPTIMIZATIONS is used`),
`setTypedAstListInputFilename` / `initWithTypedAstFilesystem` (the multistage
_consume_ side has no `@Option` at all), `setAliasStringsMode`,
`setNameGenerator`. Everything this research found "unreachable" was unreachable
_from argv_, not from the compiler.

## 3. Why patches keep failing

Every configuration lever measured this week landed at or below noise, or
negative:

| lever                                         | result                                    |
| --------------------------------------------- | ----------------------------------------- |
| `--use_types_for_optimization` on/off         | 0.08%                                     |
| `compilationLevel: SIMPLE`                    | **+9.9%** vs esbuild (worse)              |
| `externs.generate.includeDependencies: false` | byte-identical                            |
| `externs.generate.modules: []`                | byte-identical                            |
| `chunks.mode: "split"`                        | byte-identical                            |
| `finalMinify: false`                          | byte-identical (overridden by design; §6) |
| multistage save/restore                       | byte-identical                            |
| `@closureUnaware` (nested SIMPLE)             | forces the mode that measured worse       |

They fail for one reason: they all operate _inside_ the inverted value model of
§1. None of them changes what the compiler is being asked to do.

Those four byte-identical rows are not one defect. They split:

- **`chunks.mode`**, **`chunks.publicPath`**, and **`chunks.vendorChunk`**
  are overwritten. `createCompilerOptions` hardcodes `mode: "bundler-runtime"`,
  `publicPath` from `runtime.publicPath ?? config.base`, and `vendorChunk:
false` because the planner mirrors Rollup. Those fields are type errors on
  the Vite surface, so a caller who writes them fails at compile time instead
  of being silently ignored.
- **`compiler.externs` is not discarded.** `resolveCompilerExterns` in
  `src/vite/compiler-externs/index.ts` reads and resolves the
  paths, then unions them into `renameBarriers`, which `createCompilerOptions`
  writes through as `externs`. `test/vite/plugin.test.mjs`
  and `docs/reference/vite.md` treat this as the live explicit-externs path. The old
  reading that line 104 of `config.ts` replaced the caller's list wholesale was
  wrong: that line is the composed-input parameter, not a drop.
- **`externs.generate.includeDependencies`** is live only on the
  boundary-aware `generateExterns` path. The default Vite runtime-aware path
  does not read it. **`externs.generate.modules`** is written into the
  generated comment and is otherwise unused for pins: pins come from proven
  hazard sites, not the module list. Byte-identical output is that design.
- **`finalMinify`** is overridden by design, not inert.
  `src/vite/plugin-compile/compile.ts:96-100` sets `finalMinify: false` on the
  Closure stage so hashing and URL rewrite can finish first. `emitViteGraph`
  (`src/vite/plugin-compile/emit/index.ts:15-32`) calls `finalizeCompiledEmit`
  (`src/vite/plugin-compile/emit/outputs.ts:23-41`), which calls
  `preserveCompiledChunkIdentities`; its `rewriteAndRenameCompiledFiles` path
  performs preserved-import rewriting, `minifyFinalJavaScriptText`, and
  identity rewriting in one file read and write
  (`src/vite/naming/identities-rewrite.ts:48-78`). There is exactly one
  post-pass. See §6.

`compilationLevel` — which the Vite path does not manage — still passes through
and visibly changed the build; `1d5f29d` now warns once on a non-ADVANCED
value. The `barriers.ts` advice that named two of the ineffective generate
options was rewritten in the same commit to state the measured cost and the
real lever (fewer hazard sites, not fewer modules).

## 4. Four structural moves

Ordered by leverage, not by ease.

### M1 — Replace argv with a compiler driver

Today: TS options object → snake_case argv → resident CLI worker (or `java -jar` fallback). This caps us at 67
advertised flags plus the 41 hidden ones, and C5 says the interesting controls
are not there.

Move to a driver that constructs `CompilerOptions` directly — a small Java shim
speaking a protocol over stdin, or JNI. This is not a new dependency class: we
already ship a JVM dependency and a Rust native addon.

What it unlocks immediately:

- **`setPropertyRenaming(OFF)` under ADVANCED.** Keep DCE, inlining, and
  cross-chunk motion; stop minting 2,333 unique names. The CLI refuses this
  combination outright; it is a supported options state.
- The multistage **consume** side, i.e. real per-library compilation.
- Direct control of ambiguation and the name generator, and — most valuable for
  diagnosis — the ability to _ask_ the compiler which properties were skipped
  and why, instead of inferring it from a renaming report.

Cost and risk: coupling to compiler internals across versions. Mitigated by the
existing hard pin plus a capability probe at startup. The driver is still wanted
for `setPropertyRenaming(OFF)`, multistage incrementality, and JVM warmth. It is
no longer a prerequisite for the thesis: the brand+cast transform in C3 / §7
rides the existing JSDoc channel.

### M2 — Turn bundler graph facts into nominal types

This is the project's thesis, corrected. "TypeScript types let Closure optimize
better" is false as stated: TS types are structural, and the property optimizer
ignores structural types by construction (C1, C3). But ambiguation does not
actually require _types_. It requires a **sound disjointness proof**. Types are
merely the one source of such proofs that Closure happens to have.

A bundler has a different and equally sound source: **the module graph and
escape information.** Two property names that are only ever accessed inside
disjoint module subgraphs, on objects that never escape those subgraphs and are
never key-accessed dynamically, are provably unrelated — with no type
information at all.

So: synthesize nominal `@constructor @struct` shadow declarations for
object-literal shapes the bundler can prove cannot mix, and brand them at their
construction sites. That converts graph knowledge — which rollup has and Closure
does not — into the exact currency Closure's optimizer accepts.

This is the differentiator no other tool can have. Rollup knows the graph and
cannot optimize properties. Closure optimizes properties and knows nothing about
modules. This plugin is the only place both facts coexist.

Scope it honestly before building: vendor object literals that flow into React
props are provably _not_ disjoint, so the achievable set on _this fixture_ is
bounded by C4-style reachability. **Measured on the fixture, not killed as a
technique.** oxc-parser 0.144.0, 2,484 files: 9,465 names; map union 4,478;
823 already-renamed strict candidates (18.4%); hot protocol names excluded;
hottest useful candidate `getParser` at 25 local refs. `[INFERENCE]` ~1.5 KB
gzip strict / ~10 KB partial against a 31.3 KB fixture gap. M2 will not close
antd-pro. M2 is still how an ultimate optimizer _states_ a proof. Judge it
on a graph that has proofs.

### M3 — Make type lowering _optimizing_ rather than _faithful_

Today the metadata emitter translates each TS declaration to its most faithful
Closure equivalent, per file. Faithful is why we emit `@record`, and `@record` is
why nothing ambiguates.

The emitter should instead _choose_, per declaration, the Closure form that
maximizes optimization subject to soundness:

- every satisfier in the program is a class we also annotate → `@interface` +
  `@implements`
- any object literal satisfies it → `@record`, and accept that its names are
  unambiguatable

That decision needs the whole-program satisfier set, which means the emitter
must become program-wide instead of per-file. That is an architecture change, not
a flag — and it is the same assignability information `tsc` already computes.

### M4 — Move the correctness barrier from names to a data boundary

1233 program-wide name bans are a global answer to a local question. React reads
_host-element_ prop keys as runtime strings; that is a **wire protocol**, and the
prior art's answer (2017, `angular/angular#8550`) was quoted access scoped to the
one dynamic site, never `Object.prototype` externs.

Treat host props as a serialization boundary: construct them as quoted-key
objects at the JSX boundary, and forbid dot access downstream. This is precisely
the "parse at the boundary" discipline the repo's own anti-slop rules enforce on
our source. It converts a program-wide ban into a site-local invariant, and the
`classMapCalls` machinery already identifies the sites.

## 5. Two coherent end states, and the derived conclusion

**E1, ambiguation-capable:** nominal receivers exist; renaming and ambiguation
both run. The C3 brand+cast experiment already produced that state at source
level (`g,h,i` / `j,l,m` → both `g,h,i`). The fixture does not have the
proofs to scale it. That falsifies "win antd-pro with brands," not E1.

**E2, ambiguation-incapable:** via M1, turn property renaming _off_ on names
and regions with no proof, while keeping ADVANCED DCE and inlining. The
correct policy on the fixture's hot names. A global E2 is a hedge
(`[INFERENCE]` ~782–830 KB gzip, raw between 2,314 and 2,645). A _per-name_
E2 plus E1 where proofs exist is the ultimate optimizer.

Derived conclusion: **M1 is the foundation, not a consolation prize.**
Per-name policy is unreachable from argv. M2 and M3 are how proofs get
stated. M4 is how protocols stay correct. The fixture taught us not to
run one policy on a 94%-vendor React graph. It did not teach us to stop.

Today's configuration is the worst cell of the matrix: renaming on, ambiguation
off. We pay the entropy cost of renaming and collect none of its compensating
prize.

## 6. What to delete

Structural simplification is part of the fix:

- **Three overlapping optimizers.** rollup tree-shakes, Closure DCEs and
  renames, OXC re-minifies (`native/src/minify.rs`, `oxc_minifier`,
  `CompressOptions::smallest()`). Each was chosen independently. The overlap
  worth investigating is rollup's tree-shaking versus Closure's DCE, not the
  minifier: `src/vite/plugin-compile/compile.ts:96-100` sets `finalMinify:
false` for the Closure stage. `emitViteGraph` calls `finalizeCompiledEmit`,
  which calls `preserveCompiledChunkIdentities`; the latter's
  `rewriteAndRenameCompiledFiles` path applies preserved-import rewriting,
  `minifyFinalJavaScriptText`, and identity rewriting in memory between one
  file read and write (`src/vite/naming/identities-rewrite.ts:48-78`). There
  is exactly one post-pass, deliberately placed after hashing and URL rewrite
  — not a redundant pair.
- **Ineffective generate options** (§3). `compiler.externs` is live;
  `chunks.mode` is now a type error (`1d5f29d`); the generate include/module
  knobs remain honored but do not change pins. The `barriers.ts` advice was
  rewritten in the same commit.
- **Raw-size reporting as a success signal.** Landed in `1d5f29d`
  (`scripts/size-gate.mjs`): report both axes and gate against a no-plugin
  baseline.

## 7. The backdoor: Closure is a library and we are using it as a CLI

Everything this research declared impossible was impossible **only through
argv**. Verified by reading the pinned jar's class list and the `CompilerOptions`
constant pool, not from docs:

| extension point                                                                                            | status in the pinned jar                                                                                    | what it unlocks                                        |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `CompilerOptions.addCustomPass`                                                                            | **present**                                                                                                 | inject our own AST pass into the pipeline              |
| `CustomPassExecutionTime`                                                                                  | **present**: `BEFORE_CHECKS`, `BEFORE_OPTIMIZATIONS`, `BEFORE_OPTIMIZATION_LOOP`, `AFTER_OPTIMIZATION_LOOP` | a slot _before typechecking_, i.e. before colors exist |
| `Compiler.setPassConfig` + `PassConfig` (`getChecks`/`getOptimizations`/`getFinalizations`/`getPassGraph`) | **present**                                                                                                 | replace or reorder the entire pass pipeline            |
| `CompilerPass` interface (`process(externs, root)`)                                                        | **present**                                                                                                 | trivial to implement                                   |
| `Compiler.initWithTypedAstFilesystem`                                                                      | **present**                                                                                                 | real per-library compilation; no `@Option` exists      |
| `setPropertyRenaming` / `setRenamingPolicy`                                                                | **present**                                                                                                 | `OFF` _with_ ADVANCED — the CLI hard-refuses this      |
| `setAmbiguateProperties` / `setDisambiguateProperties`                                                     | **present**                                                                                                 | direct control, no CLI flag exists                     |
| `setNameGenerator`                                                                                         | **present**                                                                                                 | control the name alphabet and reuse                    |
| `setAliasStringsMode`                                                                                      | **present**                                                                                                 | no CLI flag exists                                     |
| `AmbiguateProperties.makePassForTesting`                                                                   | **present**                                                                                                 | run and inspect ambiguation out of band                |

`addCustomPass(BEFORE_CHECKS, …)` is still the cleanest injection slot, but the
underlying transform no longer waits on it. The C3 experiment — two untyped
three-property literals renaming to `g,h,i` and `j,l,m` (no ambiguation), then
both to `g,h,i` once each shape carries a `/** @constructor @struct */`
`Brand$A` plus a `@type` cast — was run as ordinary JSDoc against the pinned
jar. What remains unproven is only the `addCustomPass` _delivery mechanism_,
not the transform. The plugin already emits JSDoc from
`native/src/transpile/type_metadata{,_oxc}.rs`; emitting brands is the same
channel. M2 can therefore start without a resident driver. The driver is still
wanted for `setPropertyRenaming(OFF)`, multistage incrementality, and JVM
warmth, and it is still the only way to inject a `CompilerPass` — but it is no
longer a prerequisite for the thesis.

That reframes the thesis a third time. Not "TypeScript types make Closure
optimize better" (false — TS types are structural). Not even "emit better JSDoc
of the TypeScript the user wrote" (M3, still negotiating through a lossy
channel). The real statement is:

> **We can write the analysis Closure is missing and inject it.** The bundler
> knows the module graph; Closure knows how to exploit disjointness. A brand
> plus a cast is the currency; a custom pass is one wire, and the existing
> JSDoc emitter is another.

And `setPassConfig` means we can stop paying for passes we cannot benefit from:
drop `RenameProperties` while keeping DCE, inlining and cross-chunk motion, which
is exactly the E2 end state that the CLI refuses to express.

This does not come free. A driver couples us to compiler internals across
versions, where argv is a stability contract. Mitigations: the compiler is
already hard-pinned, `makePassForTesting` gives a cheap capability probe, and the
blast radius is one process boundary we already own.

## 8. Performance: we have been conflating two axes and gating on neither

Every number in this corpus so far is **gzip**, which is transfer cost. That is
not the only cost, and on this workload the two axes disagree:

| axis                         | scales with                      | our result vs esbuild                                           |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------- |
| network / transfer           | **gzip** bytes                   | **+31.3 KB (+4.0%)** — we lose                                  |
| CPU: parse, compile, execute | **raw** bytes, plus work removed | **−79.4 KB (−3.3%)** — we win, before counting inlining and DCE |

V8 parses and compiles the bytes it receives _after_ decompression, so raw size
drives main-thread cost while gzip drives the network. Today's verdict is
therefore not "the plugin loses". It is: **we trade 31 KB of transfer for 79 KB
of parse, plus whatever the inlining and dead-code removal save at runtime.** On
a fast network and a slow phone that is a win; on a slow network it is a loss.

Two consequences that change the roadmap:

- **E2 (property renaming off) is worse than §5 implied.** It recovers
  compression ratio but gives back the raw win, so it concedes the CPU axis to
  buy near-parity on the network axis. It is a hedge, not a fix.
- **E1 (ambiguation fires) is the only end state that would win both axes** —
  fewer raw bytes _and_ higher compressibility — and M2 cannot reach it on
  this app. Do not lead with the 57 KB / 754 KB estimates; they assumed
  coverage we measured we do not have.

Landed in `1d5f29d`: `scripts/size-gate.mjs` reports both axes and fails on
gzip regression against a no-plugin baseline. `[INFERENCE]` Neither axis has
been measured against a real device here; a parse/compile trace and a
throttled-network TTI comparison are the missing experiments, and until they
run the CPU-side claim is arithmetic, not evidence.

### Build performance, and why it converges on the same move

Measured on the pinned jar and the trial app:

- **153 ms** JVM start + jar load, best of three, was paid on **every spawn** when
  the pipeline shelled out to `java -jar` per job — and then handed a cold JIT a
  ~17 s compile. The resident CLI worker now reuses one JVM for sequential argv jobs.
- `--num_parallel_threads` now defaults to at most four available CPUs. In
  `v20260909` it runs parallel AST/dependency prebuilding, not parallel type
  checking or optimization.
- The historical multistage `save`/`restore` probe produced **byte-identical
  output**. That is evidence about that unchanged program, not incremental
  type checking after a source edit. A `CHECKS` snapshot contains the whole
  checked JS/extern world: changing either invalidates it. Identical programs
  already hit our output cache; changing only optimization inputs such as
  renaming maps is a narrower possible use.

The resident worker already provides JVM warmth. A Java API driver would
unlock additional controls, but is not by itself a build-time improvement or
permission to skip checks.

### v20260909 build-time verification

The September 2026 ARM64 investigation used the actual four self-build
compiler jobs, preserving ADVANCED, type inference/checking, externs, chunk
graphs and renaming reports. `--tracer_mode=TIMING_ONLY` identified the costs:

| Job                        | Pass time | Type inference | Type checking | Parsing |
| -------------------------- | --------: | -------------: | ------------: | ------: |
| Preset job 1               |  2,473 ms |         749 ms |        419 ms |  313 ms |
| Preset job 2               |  1,290 ms |         329 ms |        327 ms |  168 ms |
| Preset job 3               |  1,025 ms |         239 ms |        317 ms |   86 ms |
| Main compiler/plugin graph |  4,897 ms |         720 ms |        659 ms |  386 ms |

The presets each read the same 12 extern sources (43,947 lines), but have
different JS inputs. Their shrinking type-checker times reflect JVM warmup,
not a shared checked AST. The main graph also spends substantial time in
ordinary optimizations; parsing alone cannot remove that cost.

Captured inputs were replayed without tracing, in both configuration orders.
Every compared run matched JavaScript bytes, renaming reports and diagnostics.

| Execution policy                             | First four-job batch | Warm four-job batch |
| -------------------------------------------- | -------------------: | ------------------: |
| Resident JVM, one parse thread               |             10.286 s |             6.482 s |
| Resident JVM, four parse threads             |             10.146 s |             6.274 s |
| Native-image compiler, fresh process per job |             14.573 s |            14.283 s |

Resident figures are medians of two fresh JVMs and six subsequent batches per
configuration. Native-image figures have one initial and three subsequent
batches; each job still starts its own native-image process. These are one
workload on OpenJDK 21/ARM64, not cross-platform guarantees.

Four parse threads saved about 1.4% cold and 3.2% warm here. The implementation
now defaults to `min(4, available CPUs)` and preserves explicit threading
overrides, including `GCC_CLOSURE_EXTRA_FLAGS="--num_parallel_threads=1"` for
contention-sensitive builds. The gain is workload-dependent and type checking
stays serial. Keeping repeated builds in the same Node process preserves the
larger existing JVM-warmup benefit without new daemon or cache infrastructure.

Single traced self-build probes rejected `-XX:TieredStopAtLevel=1`
(15.62 s inside Closure) and `-XX:CICompilerCount=2` (13.91 s), versus 11.19 s
with default JVM settings. The native image was also slower on the replay
corpus. Do not trade away the resident JVM or its optimizing JIT on the
assumption that lower startup overhead makes compilation faster.

The pinned [Compiler implementation](https://github.com/google/closure-compiler/blob/v20260909/src/com/google/javascript/jscomp/Compiler.java)
and [command runner](https://github.com/google/closure-compiler/blob/v20260909/src/com/google/javascript/jscomp/AbstractCommandLineRunner.java)
also establish the reuse boundary: CHECKS state is whole-program and does not
replay check diagnostics. TypedAST consumption requires every relevant input
to be present and skips checks; it is not a supported way to combine cached
externs with fresh, unchecked JS. Google's
[library-shard producer](https://github.com/google/closure-compiler/blob/v20260909/bazel/typedast.bzl)
is a different architecture, not a small watch-mode cache. Retain the current
output cache and full checking/optimization policy rather than adding that
machinery for ordinary edits.

#### Correcting per-job ambient extern selection

The next investigation captured every real job input instead of assuming
that the declarations were all necessary. Each preset received an 8,886-line
explicit public API extern file, a 20,084-line assembled dependency/native
extern file, and a 4,850-line Node ambient extern file. The last file was
spurious: emitted-JS fallback analysis looked up every identifier in an
unrelated TypeScript source scope. Closure library locals named `fetch` and
`require`, plus goog.module's implicit `exports`, were mistaken for Node
globals.

Emitted inputs now get a lightweight lexical binding pass with no libraries
or dependency resolution. Only unresolved value references are looked up
in the existing Node type world. Module scopes remain independent and
shorthand property reads still seed real globals. The preset Node extern
files disappear entirely; the main job's Node file drops from 11,415 to
9,972 lines. Off-mode jobs also select Closure helpers from their own
component plus explicit/support inputs, rather than inheriting another
component's `reflect.js` or `tslib.js`.

The full runtime suite also exposed an accidental dependency on those false
roots: `digest` had only remained pinned because an unrelated Node declaration
mentioned it. Removing that root broke persistent-cache validators in the
self-compiled package. The self-build boundary registry now explicitly follows
`ContentIdentity` from `src/shared/file-state.ts`, and its required-name check
includes `digest`. Preserve the actual serialized contract, not a large
unrelated platform type graph.

Do not replace the remaining typed extern world with flat barriers. Explicit
files are caller contracts; generated external declarations carry both
transitive type relationships and program-wide property pins. A namespace
not appearing in JS does not prove those pins irrelevant, and the barrier
accounting report is not a complete static/namespace-property dependency
graph. This change removes false ambient roots, not required declarations,
type checking, diagnostics, or optimization passes.

The final controlled replay held the captured JS and other extern inputs
fixed, with the required `ContentIdentity` barrier retained in both policies.
Only the baseline additionally received the old ambient externs and unrelated
helper. Each policy ran in two fresh JVMs, in forward/reverse policy order,
with three subsequent batches per JVM. Timings exclude tracing and probe
snapshot I/O:

| Policy                                          | Cold four-job median | Warm four-job median |
| ----------------------------------------------- | -------------------: | -------------------: |
| Previous extern/helper inputs, one parse thread |             10.104 s |              6.331 s |
| Corrected inputs, four parse threads            |              9.719 s |              5.966 s |

The combined change saves 3.8% cold and 5.8% warm **inside Closure**, not across
the entire build. Across 64 timed jobs, diagnostics were identical. The three
preset outputs stayed byte-identical; the main graph changed renaming after
the false ambient roots were removed, saving 478 raw bytes and 45 gzip bytes
across its Closure JS outputs. Repeated runs of each policy produced identical
JS and renaming reports. These remain single-workload ARM64 results, not
universal speed guarantees.

Validation for that earlier change passed: 425 Bun tests (including
packed-package runtime consumers and persistent-cache restoration), 208 Rust
tests, TypeScript and lint/format gates, and a cache-off two-stage self-build
with byte-identical stage-1/stage-2 artifacts. This is a historical receipt,
not validation of the subsequent review corrections below.

A Java source-launcher probe constructed the real `CommandLineRunner` with all
four captured argv lists, without compiling. After the worker-style version
initialization, the first four-job setup took 21.54 ms; the median of 19 further
setups was 3.30 ms. This measures CLI construction/argument processing, not the
later compiler passes. Replacing that small setup with direct Java API calls
cannot explain away seconds of type checking and optimization. Closure and
the resident worker already execute in Java; no orchestration rewrite was
adopted.

#### Review correction and retained scan reductions

Review found a remaining false negative: TypeScript can resolve an emitted
`require(arg)` call to its synthetic `requireSymbol`, which has no declarations.
That symbol is not evidence of a lexical binding. The retained fix suppresses
a Node candidate only when the emitted symbol has declarations; regression
coverage now includes actual free `require(arg)` calls and shadowed calls,
not merely identifier reads.

The retained scan reductions reuse only location-independent Node candidates
within one invocation, while checking lexical bindings at each reference site.
Native helper selection likewise reuses per-file facts within preparation,
never another component's merged requirements. In off mode, modern output
targets bypass the legacy custom-elements adapter content scan; ECMAScript 3/5
still perform it. Full type checking, diagnostics, transitive/public types,
explicit extern contracts and the serialized `ContentIdentity`/`digest`
boundary remain intact. No cross-build cache or worker framework was added.

Controlled probes distinguished narrow preparation work from compilation:

| Probe and input                                                       | Samples | Before median | After median |
| --------------------------------------------------------------------- | ------: | ------------: | -----------: |
| Ambient scan, actual combined repository helpers                      |      21 |     15.777 ms |    14.689 ms |
| Ambient scan, synthetic 7,200 repeated `process` references           |      21 |     65.650 ms |    58.864 ms |
| Native job preparation, synthetic shared-support graph, modern output |      11 |     20.882 ms |     1.860 ms |
| Same native graph, ES5 output                                         |      11 |     21.097 ms |     3.147 ms |

The ambient probe measured `renderNodeAmbientGlobals` with the shared
TypeWorld constructed outside timing. The real helper input improves
6.9%; the repeated-reference stress input improves 10.3%. Selected globals and
rendered text match except for the intentional free-`require` correction,
whose output matches the authored baseline.

The native probe measured only the `prepareClosureJobs` N-API call,
including returned JS marshaling. Its synthetic graph has 24 independent
two-chunk components and 12 large shared support files (1,573,364 support bytes
including the DOM fixture). Complete ordered jobs and generated assets match
after normalizing output-directory prefixes; missing-extern errors also
remain equal. Fixture setup, addon loading, equality checks and serialization
are outside timing. These are preparation microbenchmarks, not whole-build
speed promises; the large synthetic support graph is not a production
self-build measurement.

#### Tested and rejected: grouped self-build extern closures

The bounded follow-up regenerated complete public/transitive extern closures
for separate compiler, React, Svelte and Vue build groups, rather than filtering
declarations by namespace. A successful build capture recorded 8,228 compiler
extern lines and 224/222/226 preset lines respectively. Every group retained the shared
188-line explicit native/serialized boundary, including `digest`. The capture
is evidence of generated inputs, not a clean timing run. The experiment also
passed the packed-package/cache regression run: 17 tests, 97 expectations.
Packed preset public-boundary guards remain after rejecting the partition.

Two fresh cache-off stage-1 self-builds per policy in the same environment
gave the following whole-build times, separate from the historical
Closure-only results:

| Self-build policy           |       Run 1 |       Run 2 |
| --------------------------- | ----------: | ----------: |
| Existing shared preparation | 18.333883 s | 18.275591 s |
| Grouped preparation         | 18.685081 s | 19.079574 s |

Grouped preparation was **3.15% slower on average**. The second grouped log
records three extra preset native Closure-IR preparations of
1.214/1.087/1.034 s. Smaller extern inputs did not establish a net win once
repeated TypeWorld/IR preparation and output merging were included.

The grouped partition and its output-merge machinery were therefore rejected;
the shared self-build preparation remains. This rejects that measured
implementation, not the need for transitive or public boundary types. No
broad extern filter, Java/API rewrite, or new cache/worker framework was added
to rescue it. The retained deliverable is the `require` fix, invocation-local
scan reductions and packed public-boundary regression coverage.

Final validation of the retained implementation passed: 425 Bun tests across
40 files (2,087 expectations), 208 Rust tests, TypeScript checks, Clippy,
formatting and lint gates. The cache-off two-stage self-build verified all
12 declared package paths in each stage and produced byte-identical stages.
The full suite includes the strengthened packed Node/Bun preset consumers and
persistent-cache restoration. A separate real Closure `CUSTOM`-environment
check of `var api = require("node:fs")` with the selected Node extern completed
without the previously reproduced undefined-variable error. Temporary
measurement and capture artifacts were removed after recording these results.

#### Retained: ownership-factored externs and narrow native metadata

The broader follow-up retained shared preparation rather than repeating the
rejected grouped builds. Its reusable rule is: select semantic export roots,
compute their complete dependency closures once, then factor declarations by
the set of module roots that require them. Each symbol block and namespace
initializer belongs to one fragment. Original source-entry ownership selects
those fragments for connected Closure jobs; shared jobs receive their union.
Explicit/unscoped externs and native preservation contracts remain global.

An intermediate implementation emitted a complete file per module. Individual
consumers passed, but combining modules with shared constructors caused Closure
duplicate-declaration errors. Those overlapping projections were rejected.
Disjoint ownership fragments preserve both independent and combined consumers,
without duplicate suppression, namespace-text filtering or another TypeWorld.

On frozen public package declarations, the aggregate remained byte-identical:
565,183 bytes, with no generator diagnostics or degraded occurrences. Five
fragments reconstructed the exact aggregate declaration multiset. Selecting
each module's fragments matched an independently generated complete closure,
including multiplicity, after namespace normalization:

| Public module | Selected typed bytes |
| --- | ---: |
| root | 531,101 |
| Vite | 4,003 |
| React preset | 10,260 |
| Svelte preset | 10,125 |
| Vue preset | 10,390 |

The real self-build still used one preparation pipeline and four compiler jobs.
Its compiler/Vite job received both corresponding fragments; each preset job
received only its preset fragment. Native boundary externs, bundled contracts
and generated external-boundary externs remained in every job. Actual preset
public-API inputs were 10,171–10,436 bytes after the new API declarations were
included, rather than the previous full public aggregate.

`exports: "used"` now resolves all requested modules in one application-source
traversal, using module and lexical symbol identity. It retains complete
declarations for selected roots; uncertain namespace escapes, unknown keys,
rest/spread and dynamic loads retain the affected module conservatively.
Synthetic free `require` remains distinct from a local binding. Self-build
external typed property pins fell from 2,563 to 737; no symbol-depth reduction
was used.

Native job preparation now accepts only `{counts, emittedFile}` metadata.
TypeScript passes its existing full objects structurally, without constructing
replacement objects; Rust no longer converts unused declaration templates and
diagnostics. A process-local probe replayed the real preparation input against
the frozen and current addons, alternating order over six measured runs after
warmup. With externs unscoped and the old planner's absent entry metadata
represented equivalently, their outputs were identical. Mean preparation time
fell from 10.308 ms to 2.887 ms (72.0%). The accepted metadata shape's JSON-size
proxy fell from 3,540,683 to 66,875 UTF-16 code units; production does not
serialize this handoff as JSON.

Two uninstrumented cache-off stage-1 builds per policy, with a warm release
addon and unchanged optimization/checking settings, gave:

| Measurement | Before | Retained implementation |
| --- | ---: | ---: |
| Whole-build mean | 18.355 s | 15.064 s |
| Closure mean | 10.276 s | 7.394 s |
| Type preflight mean | 2.309 s | 1.044 s |

The before whole-build receipt is 36.71 s combined for two runs; the retained
runs were 15.125 s and 15.003 s individually. Whole-build time decreased 17.9%.
The N-API microbenchmark is not the whole-build gain; most measured savings
were in preflight and Closure. These are workload-specific observations, not a
universal speed guarantee.

The broader consumer matrix also exposed genuine boundary defects: synthetic
heritage `this` arguments had no Closure type spelling; merged function/class/
enum namespace additions needed emission without redeclaring primary members;
and the resident Java driver's `args` JSON key had depended on incidental
extern pins. Those were repaired at their source. The Java request now uses
an explicit computed key, rather than restoring unrelated declarations.

Final verification passed after those repairs: 434 Bun tests across 40 files
(2,153 expectations), 208 Rust tests, both TypeScript configurations, Clippy,
source formatting and lint. A normal cache-off two-stage self-build verified
all 12 declared package paths in each stage and produced byte-identical
stage-1/stage-2 artifacts. The final runtime suite ran against those artifacts.
The shared-fragment consumer matrix retained valid/invalid type outcomes and
the full artifact's Closure diagnostic-code multiset.

## 9. How to falsify this document

- **§1's value inversion:** build any app where plugin overhead measured at
  SIMPLE is below the ADVANCED-minus-SIMPLE gzip delta. Then the model is
  workload-specific rather than structural, and the roadmap should be scoped per
  app shape instead.
- **M2:** tripped. 823 of 4,478 renamed names qualify (18.4%); they are a
  long tail. M2 is dead on this workload and M3 carries the type-path alone.
- **M3:** count TS interfaces in an authored codebase whose every satisfier is a
  class. If most interfaces are satisfied by object literals, M3's ceiling is low
  too — and then the honest conclusion is that this project pays only for
  class-based, authored-dominant TypeScript, and its documentation should say so.
- **E1's estimate:** falsified on coverage, not just on the ratio model. 754 KB
  assumed name reuse recoverable to esbuild's level. M2's long tail cannot
  produce that reuse. Do not treat 754 KB as a target.
- **§7's backdoor:** the source-level brand+cast already passed (`g,h,i` /
  `j,l,m` → both `g,h,i`). What would still kill the _custom-pass_ route is
  `addCustomPass(BEFORE_CHECKS, …)` failing to reproduce that result. That
  would not kill the thesis — the JSDoc channel already carries the transform
  — only the injection mechanism.
- **§8's CPU claim:** trace parse + compile time for both bundles on a throttled
  mid-tier device. If the 79 KB raw difference does not move main-thread time
  measurably, the two-axis argument collapses and gzip is the only metric that
  matters — which would make E2 a real option again rather than a hedge.

## Historical self-build measurements

Moved from the development guide to keep past experiments separate from current
workflow instructions. These are recorded results, not timings remeasured on
the current checkout. See [Workflows](../development/workflows.md) for current commands.

### Stage and cache costs

The recorded two-stage self-build took 139s: 52.0s in stage-1 Closure, 44.9s
in stage-2 Closure, and about 42s in declarations, native emit, resolution,
and publication. The stage-1 persistent-cache lane took 89s cold and 28s warm;
its 20 output files matched the two-stage cache-off build byte-for-byte.

The investigation found three cache defects: absolute paths in option
signatures prevented relocation reuse; mtime comparisons invalidated identical
rewrites; and cached absolute entry output paths replayed into old destinations.
The fixes used project-relative signatures, size plus content digests, and live
caller-supplied output paths. Renaming maps also participate in Closure job
keys, so warm-cache timings depended on the maps reaching a stable state.

A separate resident-JVM incident produced a 98,304-byte renaming report ending
mid-token at `module$contents`, causing `VariableMap.load` to throw
`java.text.ParseException`. The recorded mitigation validated `key:value` maps
before caching and reuse and discarded malformed maps; this was containment,
not proof that report flushing was fixed.

### Runtime-owned extern depth

On the same 289-file self-build program, the three runtime-owned externals
(`@typescript/typescript6`, `google-closure-compiler`, and `vite`) expanded to
a 51 MB, 875,460-line extern file with 164,758 members, compared with 2.01 MB
of program input. Holding the compiler and stopping point fixed, with zero
undefined-variable errors:

| Externs supplied                       | Size     | Elapsed |
| -------------------------------------- | -------- | ------- |
| Unbounded type closure                 | 50.97 MB | 38.7s   |
| Declarations with JSDoc types stripped | 21.64 MB | 33.2s   |
| Bindings and property barriers only    | 0.03 MB  | 4.5s    |

The recorded type-inference A/B output-size difference was 0.03% on this
fixture, not a general limit on typed optimization.

Bounding referenced-symbol depth reduced the runtime-owned extern file from
50.97 MB unbounded to 32.8 MB at depth 1 and 1.9 KB / 90 lines at depth 0.
In the full-build comparison, `closure:compile` fell from 164.8s to 41.3s per
stage and wall time from 6m03s to under 2m. The record reports a byte-identical
self-build fixpoint and all five example distributions unchanged; the newly
built `dist/vite/index.mjs` decreased from 150,465 to 149,580 raw bytes.

The boundary distinction matters: runtime-owned seed exports were retained
while referenced types degraded to `?`; the self-build's published API externs
remained unbounded and guarded against degradation.

### Historical example size snapshot

Moved from the root README. These previously recorded JavaScript deltas compare
plugin output with the examples' plain-Vite baselines. The table did not record
an exact source revision or measurement environment, so it is not a
reproducibility result or a current performance claim.

| Example             |    Raw |   Gzip |
| ------------------- | -----: | -----: |
| jquery (vanilla-ts) | -13.8% | -12.3% |
| lit                 | -12.2% | -10.0% |
| react               | -11.5% |  -4.4% |
| svelte              |  +5.3% |  -1.9% |
| vue-vapor           |  -6.7% |  +0.5% |

Use the [current example workflow](../development/workflows.md#build-and-preview-an-example)
to rebuild both configurations before making a comparison.
