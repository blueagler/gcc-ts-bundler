# The size problem is structural: value model, constraints, and where to change

This is a design document, not a spike report. It takes the measurements in
`research/advanced-renaming-vs-gzip.md`,
`research/structural-types-defeat-renaming.md`, and
`research/prior-art-closure-frameworks.md` as given and asks what the
architecture should be. Every number below is measured on the Ant Design Pro
trial app (2,352 modules, 94.1% dependency bytes) with the pinned compiler
`v20260811`, except where marked `[INFERENCE]`.

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
| `finalMinify: false` | byte-identical |
| multistage save/restore | byte-identical |
| `@closureUnaware` (nested SIMPLE) | forces the mode that measured worse |

They fail for one reason: they all operate *inside* the inverted value model of
§1. None of them changes what the compiler is being asked to do.

Four of those results are a separate defect, and the cause is confirmed in
source rather than inferred. `src/vite/config.ts:98-129` spreads the user's
`compiler` object and then **overwrites the fields the Vite path manages**:
line 118 hardcodes `chunks.mode: "bundler-runtime"`, and line 104 replaces
`externs` wholesale with the plugin's own generated set. So
`externs.generate.includeDependencies`, `externs.generate.modules` and
`chunks.mode` cannot take effect through the Vite plugin at all, while
`compilationLevel` — which the Vite path does not manage — passes through and
visibly changed the build. `finalMinify: false` is also byte-identical; it is
not in the override list, so it is either honored and worthless on this input or
overridden downstream, and that needs one probe to separate.

The type says these are settable; the behaviour says they are not.
**An option that silently does nothing is worse than a missing option**, and
`src/externs/barriers.ts:194` tells users to reach for two of the inert ones.
Fix by making the managed set explicit: either `Omit` them from the Vite plugin's
option type so the compiler rejects them, or honor them and delete the override.
Silently discarding a caller's value is the one behaviour to stop.

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
existing hard pin plus a capability probe at startup. This is the enabling move
for everything else; without it we are negotiating with a flag parser.

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
props are provably *not* disjoint, so the achievable set is bounded by C4-style
reachability. Measure candidate coverage on the trial app first; if fewer than
some threshold of the 8,400 properties qualify, M3 is the better investment.

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

**E1, ambiguation-capable:** M2 and/or M3 make nominal receivers exist; renaming
and ambiguation both run. `[INFERENCE]` At today's 2,314 KB raw with esbuild's
3.07 ratio, that is ≈754 KB gzip — about 3.3% *below* esbuild, i.e. the first
configuration in which this project would actually win.

**E2, ambiguation-incapable:** accept C1/C3, and via M1 turn property renaming
*off* while keeping ADVANCED's DCE and inlining. Stop destroying entropy for a
prize we cannot collect.

Now the derived conclusion, which is the most useful output of this document.
`[INFERENCE]` E2 recovers ratio (≈3.07) but gives back renaming's raw savings, so
raw lands somewhere between today's 2,314 KB and SIMPLE's 2,645 KB, and gzip
between roughly 782 and 830 KB. **E2 therefore straddles parity with esbuild and
cannot be relied on to win.** Only E1 has real headroom.

That means: **M1 is necessary but not sufficient.** It buys the ability to stop
losing. Only making ambiguation fire — M2 or M3 — can make the project's premise
pay. Any roadmap that stops after M1 has bought a smaller loss.

Today's configuration is the worst cell of the matrix: renaming on, ambiguation
off. We pay the entropy cost of renaming and collect none of its compensating
prize.

## 6. What to delete

Structural simplification is part of the fix:

- **Three overlapping optimizers.** rollup tree-shakes, Closure DCEs and renames,
  esbuild re-minifies. Each was chosen independently. Decide which owns which
  invariant and remove the overlap. `finalMinify: false` measured byte-identical,
  so the esbuild post-pass is currently either inert or overridden — one probe
  separates those, and either answer means deleting something.
- **Inert options** (§3). Honor or delete, and correct the `barriers.ts` advice.
- **Raw-size reporting as a success signal.** The build reports raw sizes and
  every check stayed green through a 4.0% wire regression. Whatever else changes,
  the gate should be summed `gzip -9` against a no-plugin baseline.

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

`addCustomPass(BEFORE_CHECKS, …)` is the decisive one, and it dissolves the
problem that §4's M2 and M3 were working around. Those moves tried to *persuade*
Closure's type system to describe disjointness, by choosing between `@record` and
`@interface` and by emitting JSDoc text. With a custom pass we do not have to
persuade anything: we compute the disjointness facts ourselves from the module
graph and write them onto the AST directly, before colors are built, in the
representation the optimizer actually consumes.

That reframes the thesis a third time. Not "TypeScript types make Closure
optimize better" (false — TS types are structural). Not even "emit better JSDoc"
(M3, still negotiating through a lossy channel). The real statement is:

> **We can write the analysis Closure is missing and inject it.** The bundler
> knows the module graph; Closure knows how to exploit disjointness. A custom
> pass is the wire between them.

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
- **E1 (ambiguation fires) is the only end state that wins both axes at once** —
  fewer raw bytes *and* higher compressibility. That is a stronger argument for
  it than the 57 KB gzip estimate alone, and it is the argument to lead with.

The project currently reports raw sizes and gates on nothing. It should report
both axes and gate on both, against a no-plugin baseline. `[INFERENCE]` Neither
axis has been measured against a real device here; a parse/compile trace and a
throttled-network TTI comparison are the missing experiments, and until they run
the CPU-side claim is arithmetic, not evidence.

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
ships a persistent worker for precisely this reason. So the driver move in §7 is
not only the key to the optimization backdoors — it is also the build-time fix.
**One architectural change, both axes, and it is the prerequisite for every other
move in this document.**

## 9. How to falsify this document

- **§1's value inversion:** build any app where plugin overhead measured at
  SIMPLE is below the ADVANCED-minus-SIMPLE gzip delta. Then the model is
  workload-specific rather than structural, and the roadmap should be scoped per
  app shape instead.
- **M2:** compute the fraction of the 8,400 properties that are single-subgraph,
  non-escaping, and never dynamically keyed. If that fraction is small, M2 is
  dead and M3 carries the thesis alone.
- **M3:** count TS interfaces in an authored codebase whose every satisfier is a
  class. If most interfaces are satisfied by object literals, M3's ceiling is low
  too — and then the honest conclusion is that this project pays only for
  class-based, authored-dominant TypeScript, and its documentation should say so.
- **E1's estimate:** it assumes compression ratio is recoverable to esbuild's
  level by name reuse alone. Ratio is not a pure function of name diversity.
  Treat 754 KB as an order of magnitude, and re-measure once any ambiguation
  actually fires.
- **§7's backdoor:** implement the smallest possible `CompilerPass` that brands
  two provably-disjoint object-literal shapes as nominal, inject it at
  `BEFORE_CHECKS`, and check whether the two shapes' properties receive the same
  short name. If ambiguation still refuses, the custom-pass route is dead and
  only M3 remains.
- **§8's CPU claim:** trace parse + compile time for both bundles on a throttled
  mid-tier device. If the 79 KB raw difference does not move main-thread time
  measurably, the two-axis argument collapses and gzip is the only metric that
  matters — which would make E2 a real option again rather than a hedge.
