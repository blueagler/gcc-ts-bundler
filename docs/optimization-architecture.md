# The size problem is structural: value model, constraints, and where to change

This is a design document, not a spike report. It takes the measurements in
`research/advanced-renaming-vs-gzip.md`,
`research/structural-types-defeat-renaming.md`, and
`research/prior-art-closure-frameworks.md` as given and asks what the
architecture should be. Every number below is measured on the Ant Design Pro
trial app (2,352 modules, 94.1% dependency bytes) with the pinned compiler
`v20260811`, except where marked `[INFERENCE]`. That app is a **negative
fixture** for an ultimate optimizer — a worst-case fact graph — not the
product fitness function.

---

## 1. The root problem is a value inversion, and it is arithmetic

Closure ADVANCED offers three things. Priced individually on this app:

| what ADVANCED offers | measured contribution |
|---|---|
| whole-program DCE + inlining | part of a **−46.0 KB gzip** win over SIMPLE |
| property renaming | the other part of that −46.0 KB, but it *costs* compression ratio (3.08 → 2.85) |
| property **ambiguation** | **0 KB. 0 of ~8,400 properties ambiguated.** |

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
*same* short name ("This allows better compression"). `RenameProperties` does
the opposite: `generateNames` mints a unique name per property and reserves it.
Our output has 2,333 distinct ≤2-char names at reuse 7.6; esbuild's has 349 at
reuse 16.0. That gap *is* the regression.

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
*receiver*, not TypeScript. A brand plus a cast is sufficient, and it is
sufficient on exactly the shape 94.1% of our bytes are: untyped vendor object
literals. C3 therefore states a defect in our emitter, not a ceiling on the
input, and §7 records what follows from that.

**C4 — The correctness barrier is a global name ban, and it is an independent
blocker.** Removing all 1233 pins recovers 10.7 KB gzip but does **not** enable
ambiguation (reuse 7.6 → 7.9, distinct short names *up*). Pins and structural
types are two separate walls; clearing one leaves the other.

**C5 — The CLI is a strict subset of the compiler.** The pipeline spawns
`java -jar` with argv. Decisive controls exist only behind `CompilerOptions`:
`setPropertyRenaming(OFF)` combined with ADVANCED (the CLI hard-errors:
`renaming cannot be disabled when ADVANCED_OPTIMIZATIONS is used`),
`setTypedAstListInputFilename` / `initWithTypedAstFilesystem` (the multistage
*consume* side has no `@Option` at all), `setAliasStringsMode`,
`setNameGenerator`. Everything this research found "unreachable" was unreachable
*from argv*, not from the compiler.

## 3. Why patches keep failing

Every configuration lever measured this week landed at or below noise, or
negative:

| lever | result |
|---|---|
| `--use_types_for_optimization` on/off | 0.08% |
| `compilationLevel: SIMPLE` | **+9.9%** vs esbuild (worse) |
| `externs.generate.includeDependencies: false` | byte-identical |
| `externs.generate.modules: []` | byte-identical |
| `chunks.mode: "split"` | byte-identical |
| `finalMinify: false` | byte-identical (overridden by design; §6) |
| multistage save/restore | byte-identical |
| `@closureUnaware` (nested SIMPLE) | forces the mode that measured worse |

They fail for one reason: they all operate *inside* the inverted value model of
§1. None of them changes what the compiler is being asked to do.

Those four byte-identical rows are not one defect. They split:

- **`chunks.mode`** was genuinely overwritten. `createCompilerOptions` still
  hardcodes `mode: "bundler-runtime"` (`src/vite/config.ts:137`). Commit
  `1d5f29d` made that field a type error on the Vite surface, so a caller who
  writes it now fails at compile time instead of being silently ignored.
- **`compiler.externs` is not discarded.** `src/vite/externs.ts:66` reads it,
  resolves the paths, and unions them into `renameBarriers`, which
  `createCompilerOptions` then writes through as `externs`. `test/vite-plugin.test.mjs`
  and `docs/vite.md` treat this as the live explicit-externs path. The old
  reading that line 104 of `config.ts` replaced the caller's list wholesale was
  wrong: that line is the composed-input parameter, not a drop.
- **`externs.generate.includeDependencies` and `externs.generate.modules`**
  *are* honored (`src/vite/externs.ts:98-100`) but ineffective: pins come from
  proven hazard sites, not from the module list. Byte-identical output is the
  measured consequence of that design, not of a discarded option.
- **`finalMinify`** is overridden by design, not inert. `src/vite/plugin.ts:568-573`
  hardcodes `finalMinify: false` on the Closure stage so hashing and URL
  rewrite can finish first; `emitViteGraph` (~710-712) then always runs
  `finalizeJavaScriptOutputs`. There is exactly one post-pass. See §6.

`compilationLevel` — which the Vite path does not manage — still passes through
and visibly changed the build; `1d5f29d` now warns once on a non-ADVANCED
value. The `barriers.ts` advice that named two of the ineffective generate
options was rewritten in the same commit to state the measured cost and the
real lever (fewer hazard sites, not fewer modules).

## 4. Four structural moves

Ordered by leverage, not by ease.

### M1 — Replace argv with a compiler driver

Today: TS options object → snake_case argv → `java -jar`. This caps us at 67
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
  diagnosis — the ability to *ask* the compiler which properties were skipped
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
actually require *types*. It requires a **sound disjointness proof**. Types are
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
props are provably *not* disjoint, so the achievable set on *this fixture* is
bounded by C4-style reachability. **Measured on the fixture, not killed as a
technique.** oxc-parser 0.144.0, 2,484 files: 9,465 names; map union 4,478;
823 already-renamed strict candidates (18.4%); hot protocol names excluded;
hottest useful candidate `getParser` at 25 local refs. `[INFERENCE]` ~1.5 KB
gzip strict / ~10 KB partial against a 31.3 KB fixture gap. M2 will not close
antd-pro. M2 is still how an ultimate optimizer *states* a proof. Judge it
on a graph that has proofs.

### M3 — Make type lowering *optimizing* rather than *faithful*

Today the metadata emitter translates each TS declaration to its most faithful
Closure equivalent, per file. Faithful is why we emit `@record`, and `@record` is
why nothing ambiguates.

The emitter should instead *choose*, per declaration, the Closure form that
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
*host-element* prop keys as runtime strings; that is a **wire protocol**, and the
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

**E2, ambiguation-incapable:** via M1, turn property renaming *off* on names
and regions with no proof, while keeping ADVANCED DCE and inlining. The
correct policy on the fixture's hot names. A global E2 is a hedge
(`[INFERENCE]` ~782–830 KB gzip, raw between 2,314 and 2,645). A *per-name*
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
  minifier: `src/vite/plugin.ts:568-573` hardcodes `finalMinify: false` for the
  Closure stage, and `emitViteGraph` (~710-712) then always runs
  `finalizeJavaScriptOutputs`. There is exactly one post-pass, deliberately
  placed after hashing and URL rewrite — not a redundant pair.
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

| extension point | status in the pinned jar | what it unlocks |
|---|---|---|
| `CompilerOptions.addCustomPass` | **present** | inject our own AST pass into the pipeline |
| `CustomPassExecutionTime` | **present**: `BEFORE_CHECKS`, `BEFORE_OPTIMIZATIONS`, `BEFORE_OPTIMIZATION_LOOP`, `AFTER_OPTIMIZATION_LOOP` | a slot *before typechecking*, i.e. before colors exist |
| `Compiler.setPassConfig` + `PassConfig` (`getChecks`/`getOptimizations`/`getFinalizations`/`getPassGraph`) | **present** | replace or reorder the entire pass pipeline |
| `CompilerPass` interface (`process(externs, root)`) | **present** | trivial to implement |
| `Compiler.initWithTypedAstFilesystem` | **present** | real per-library compilation; no `@Option` exists |
| `setPropertyRenaming` / `setRenamingPolicy` | **present** | `OFF` *with* ADVANCED — the CLI hard-refuses this |
| `setAmbiguateProperties` / `setDisambiguateProperties` | **present** | direct control, no CLI flag exists |
| `setNameGenerator` | **present** | control the name alphabet and reuse |
| `setAliasStringsMode` | **present** | no CLI flag exists |
| `AmbiguateProperties.makePassForTesting` | **present** | run and inspect ambiguation out of band |

`addCustomPass(BEFORE_CHECKS, …)` is still the cleanest injection slot, but the
underlying transform no longer waits on it. The C3 experiment — two untyped
three-property literals renaming to `g,h,i` and `j,l,m` (no ambiguation), then
both to `g,h,i` once each shape carries a `/** @constructor @struct */`
`Brand$A` plus a `@type` cast — was run as ordinary JSDoc against the pinned
jar. What remains unproven is only the `addCustomPass` *delivery mechanism*,
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

| axis | scales with | our result vs esbuild |
|---|---|---|
| network / transfer | **gzip** bytes | **+31.3 KB (+4.0%)** — we lose |
| CPU: parse, compile, execute | **raw** bytes, plus work removed | **−79.4 KB (−3.3%)** — we win, before counting inlining and DCE |

V8 parses and compiles the bytes it receives *after* decompression, so raw size
drives main-thread cost while gzip drives the network. Today's verdict is
therefore not "the plugin loses". It is: **we trade 31 KB of transfer for 79 KB
of parse, plus whatever the inlining and dead-code removal save at runtime.** On
a fast network and a slow phone that is a win; on a slow network it is a loss.

Two consequences that change the roadmap:

- **E2 (property renaming off) is worse than §5 implied.** It recovers
  compression ratio but gives back the raw win, so it concedes the CPU axis to
  buy near-parity on the network axis. It is a hedge, not a fix.
- **E1 (ambiguation fires) is the only end state that would win both axes** —
  fewer raw bytes *and* higher compressibility — and M2 cannot reach it on
  this app. Do not lead with the 57 KB / 754 KB estimates; they assumed
  coverage we measured we do not have.

Landed in `1d5f29d`: `scripts/size-gate.mjs` reports both axes and fails on
gzip regression against a no-plugin baseline. `[INFERENCE]` Neither axis has
been measured against a real device here; a parse/compile trace and a
throttled-network TTI comparison are the missing experiments, and until they
run the CPU-side claim is arithmetic, not evidence.

### Build performance, and why it converges on the same move

Measured on the pinned jar and the trial app:

- **153 ms** JVM start + jar load, best of three, paid on **every spawn** because
  the pipeline shells out to `java -jar` per job — and then hands a cold JIT a
  ~17 s compile.
- `--num_parallel_threads` is accepted and we do not pass it.
- Multistage `save`/`restore` produces **byte-identical output**. We dismissed it
  on the size axis, which was the wrong axis: byte-identical output is exactly
  what makes it *correct* for incrementality. Cache the `CHECKS` segment and
  rerun only `OPTIMIZATIONS`.

All three want the same thing: a resident compiler process we control. Google
ships a persistent worker for precisely this reason. The driver move in §7 is
the build-time fix and the E2 unlock. It is not a path back to E1: the
brand+cast transform works and has nothing hot to apply to.

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
  `j,l,m` → both `g,h,i`). What would still kill the *custom-pass* route is
  `addCustomPass(BEFORE_CHECKS, …)` failing to reproduce that result. That
  would not kill the thesis — the JSDoc channel already carries the transform
  — only the injection mechanism.
- **§8's CPU claim:** trace parse + compile time for both bundles on a throttled
  mid-tier device. If the 79 KB raw difference does not move main-thread time
  measurably, the two-axis argument collapses and gzip is the only metric that
  matters — which would make E2 a real option again rather than a hedge.
