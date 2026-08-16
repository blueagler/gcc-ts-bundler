# Plan: build the optimizer; the trial app is a fixture

Derived from `optimization-architecture.md` and the four research spikes.
Every size number is measured on the Ant Design Pro trial app (2,352 modules,
94.1% dependency bytes, compiler `v20260811`). That app is a **negative
fixture** — a worst-case fact graph — not the product. Line counts are from
this repository. `[INFERENCE]` marks anything not measured.

---

## The thesis in one sentence

**An ultimate JS optimizer is a per-name policy engine over sound
disjointness proofs, not Closure ADVANCED as one button.**

Three facts, not three modes:

1. **DCE / inlining everywhere.** ADVANCED's −46 KB vs SIMPLE is real.
2. **Reuse names where a proof exists.** Brand+cast is enough
   (`g,h,i` / `j,l,m` → both `g,h,i`). Types are one proof source; the
   module graph and escape analysis are another.
3. **Quote, do not rename, at wire protocols.** React host props, `obj[k]`,
   JSON. A global `Object.prototype` pin is the wrong shape of that fact.

Today's pipeline does (1), does (2) for 0 of 4,478 names, and does (3) as
1,233 program-wide bans. That is the worst cell of the matrix, and it is
why the fixture loses 31 KB gzip to Vite. The fixture did **not** kill the
brand transform, the driver, or the thesis. It killed "stamp this React
admin and collect 754 KB."

The two subsystems that tried to fake (2) and (3) through lossy channels
remain **~12,000 lines whose measured contribution on the fixture is
negative**:

| subsystem | lines | measured size contribution |
|---|---|---|
| `native/src/transpile/type_metadata{,_oxc}.rs` | 1,253 | part of the **0.08%** type-pass A/B |
| `src/vite/type-metadata/**` | 2,259 | same 0.08% |
| `src/build/closure/platform-externs/**` | 1,509 | `typed-input.md`: makes typed input worthless as built |
| `src/externs/**` | 6,880 | **−10.7 KB gzip** (buys React correctness) |

Neither can be deleted outright on the fixture — the externs buy a working
app, and the type metadata gates `checkTypes`. They can be *replaced* by
cheaper mechanisms that implement facts (2) and (3) directly.

---

## Part A — Delete now, no prerequisites — **landed in `1d5f29d`**

These shipped. The items below are the record of what landed, with A1's
diagnosis corrected against source.

**A1. Close the inert option surface.** Landed `1d5f29d`: `chunks.mode` is now
a type error on the Vite plugin options. The original write-up bundled four
names as "silently discarded"; that was wrong on three of them.

- **`chunks.mode`** *was* overwritten (`createCompilerOptions` hardcodes
  `mode: "bundler-runtime"` at `src/vite/config.ts:137`). Making it a type
  error is the fix that landed.
- **`compiler.externs` is live**, not discarded. `src/vite/externs.ts:66` reads
  it, resolves paths, and unions them into `renameBarriers`, which
  `createCompilerOptions` then writes. `test/vite-plugin.test.mjs` and
  `docs/vite.md` treat this as the explicit-externs path.
- **`externs.generate.includeDependencies` and `externs.generate.modules`**
  are honored (`src/vite/externs.ts:98-100`) but ineffective: pins come from
  proven hazard sites, not from the module list. Byte-identical output is that
  design, not a dropped option.
- **`finalMinify`** is overridden by design, not inert.
  `src/vite/plugin.ts:568-573` hardcodes `finalMinify: false` on the Closure
  stage so hashing and URL rewrite can finish first; `emitViteGraph` (~710-712)
  then always runs `finalizeJavaScriptOutputs`. One post-pass. See Part C.

**A2. The advice that names them.** Landed `1d5f29d`: the `barriers.ts` warning
was rewritten to state the measured cost (10.7 KB gzip, ambiguation blocked)
and the real lever (fewer hazard sites, not fewer modules). It no longer
points at `includeDependencies: false` or `mode: runtime-aware`.

**A3. `compilationLevel` on the Vite surface.** Landed `1d5f29d`: a
non-ADVANCED `compilationLevel` now warns once, naming the measured **+9.9%**
gzip versus the ADVANCED default. Kept on the core/CLI API.

**A4. Raw-size-only reporting.** Landed `1d5f29d` as `scripts/size-gate.mjs`
plus two-axis reporting (raw for CPU, `gzip -9` for transfer) against a
no-plugin baseline. This is also Phase 1 below.

**A5. Closed research directions.** Landed `1d5f29d` as
`docs/research/closed-directions.md` (entries 1–8). Entry 9 (graph-derived
branding on vendor-dominated React) was added when Phase 4's coverage count
killed M2. Each is measured or source-proven dead.

## Part B — Replace, then delete

Ordered by what an ultimate optimizer actually needs. Phase 3 is the
foundation (per-name policy is unreachable from argv). Phase 4 is dead as
an antd-pro size fix and alive as the injection currency. Each phase has a
kill criterion against *its* fixture, not against the worst-case one.

### Phase 1 — Two-axis measurement and gate — **landed in `1d5f29d`**

Report summed `gzip -9` and summed raw against a no-plugin baseline, per build
(`scripts/size-gate.mjs`). Small, and everything downstream is unjudgeable
without it.

*Kill criterion:* none. This happened regardless.

### Phase 2 — The 30-line probe — **passed, at source level**

The probe that was going to decide the rest has been run against the pinned
jar (`google-closure-compiler-java@20260811.0.0`) with the production flag
set `--compilation_level ADVANCED --warning_level QUIET
--jscomp_warning=checkTypes --hide_warnings_for=/`.

Two unrelated **untyped** three-property object literals, each consumed
through a plain function, rename to `g,h,i` and `j,l,m` — six distinct short
names, **no ambiguation**. The same literals with a synthesized nominal brand
— a `/** @constructor @struct */ function Brand$A(){}` per shape,
`@type {number}` prototype members, readers annotated `@param {!Brand$A}`,
and each literal wrapped in a `/** @type {!Brand$A} */ (…)` cast — both
shapes rename to `g,h,i`. **Identical names. Ambiguation fires.**

*Kill criterion did not trip.* Untyped vendor-shaped literals can be
ambiguated. Only a nominal brand plus a cast is required; no TypeScript types
at all. Therefore the thesis is executable on untyped vendor code.

What remains unproven is only the `addCustomPass` **delivery mechanism**, not
the underlying transform. The plugin already emits JSDoc from
`native/src/transpile/type_metadata{,_oxc}.rs`; emitting brands is the same
channel. The resident driver (Phase 3) is still wanted for
`setPropertyRenaming(OFF)`, multistage incrementality, and JVM warmth, but it
is no longer a prerequisite. **Phase 4 does not depend on Phase 3.**

All of the injection points still ship in the pinned jar (verified in
`optimization-architecture.md` §7). They are now a delivery upgrade, not a
feasibility gate.

### Phase 3 — Resident compiler driver replaces argv

A long-lived process constructing `CompilerOptions` directly. Unlocks, all
verified present and all unreachable from argv: `addCustomPass`,
`Compiler.setPassConfig`, `setPropertyRenaming(OFF)` combined with ADVANCED,
`initWithTypedAstFilesystem`, `setNameGenerator`, `setAliasStringsMode`.

It is simultaneously the build-time fix: **153 ms** of JVM start and jar load per
spawn today, a cold JIT handed a ~17 s compile, `--num_parallel_threads` accepted
and unused, and multistage `save`/`restore` producing byte-identical output —
useless for size, exactly right for caching the `CHECKS` segment.

*Deletes:* most of the camelCase→argv mapping in `src/build/closure/compiler.ts`,
the `GCC_CLOSURE_EXTRA_FLAGS` override guard, and the managed-flag collision
checks that only exist because argv is a flat namespace.

*Kill criterion:* if the driver cannot be made version-robust against the pinned
jar behind a `makePassForTesting` capability probe, keep argv. Then E2 and
per-name policy stay unreachable, and the optimizer remains one global button.

### Phase 4 — Graph-derived disjointness — **dead as an antd-pro size fix;
alive as the injection currency**

The transform is proven (Phase 2). Coverage on the *negative fixture* is a
long tail (823 of 4,478 renamed names, hottest useful candidate `getParser`
at 25 local refs; hot protocol names all excluded). Do not stamp that
fixture expecting a 31 KB close.

Do write the pass against a fixture that has proofs: authored-dominant
class-based TypeScript, or a synthetic graph whose disjoint shapes are
known. The brand+cast is how an ultimate optimizer *states* a proof to
Closure. Killing it because antd-pro has no proofs is optimizing the
harness.

`type_metadata{,_oxc}.rs` stays to gate `checkTypes` until a custom pass
replaces the channel. A second fixture is a prerequisite for judging
Phase 4; the antd-pro count is not that judgment.

*Coverage on the negative fixture, for the record.* oxc-parser 0.144.0,
2,484 files, 0 parse failures. Graph names 9,465; map union 4,478; strict
candidates 1,284 / 823 renamed (18.4%). Exclusions among renamed: escaping
1,589, no-literal-shape 1,116, dynamic-keyed 879. `[INFERENCE]` ~1.5 KB
gzip strict / ~10 KB partial vs a 31.3 KB fixture gap.

*Phase 4b:* optimizing type lowering — `@interface` + `@implements` where
every satisfier is a class, `@record` otherwise. Judge it on a class-heavy
fixture, not on antd-pro.


### Phase 5 — Collapse the extern barrier to a data boundary

Replace 1233 program-wide `Object.prototype.X` pins with site-local quoted access
at the hazard sites the `classMapCalls` machinery already identifies. React host
props are a wire protocol; treat them as one. This is the 2017 `angular/angular#8550`
answer, and the reason it is right is in the same thread: *"the externs approach
marks that property name as un-renamable everywhere."*

*Recovers:* 10.7 KB gzip and 75.8 KB raw, measured by building with the preset
removed.
*Deletes:* a large fraction of `src/externs/**` (6,880 lines) — the runtime-aware
barrier analysis exists to decide *which names to ban globally*, a question that
disappears once the boundary is site-local.

*Hard constraint:* do not remove pins before the replacement works. Removing them
today produces a silently broken app — clean build, empty console, dead handlers.

### Phase 6 — Decide the fate of platform-externs slicing

1,509 lines whose slicing reported "unavailable, using full browser externs" on
the trial build, and which `typed-input.md` names as the reason typed input pays
nothing. Phase 4 will not make them load-bearing. After Phase 5 the question is
whether they are 1,509 lines of cache machinery for an unused artifact.

## Part C — Collapse the overlapping optimizers

rollup tree-shakes, Closure DCEs and renames, OXC re-minifies
(`native/src/minify.rs`, `oxc_minifier`, `CompressOptions::smallest()`). Each
was chosen independently. The overlap worth investigating is rollup's
tree-shaking versus Closure's DCE, not the minifier: `finalMinify` is
overridden by design (`src/vite/plugin.ts:568-573` hardcodes `false` on the
Closure stage; `emitViteGraph` ~710-712 always runs
`finalizeJavaScriptOutputs`). There is exactly one post-pass, deliberately
placed after hashing and URL rewrite — not a redundant pair, and not esbuild.
More aggressively: an ultimate optimizer **is** the consumer of the module
graph. Rollup-then-Closure destroys the disjointness evidence before the
optimizer sees it. Google's pipeline is source-to-one-binary. Open this
once Phase 3 can drive the compiler; do not keep it closed because the
negative fixture had nothing to prove.


## Part D — What not to do

- Do not tier compilation levels. Measured worse (+9.9%).
- Do not look for a flag. No type-free property-name reuse exists in the
  compiler; source-proven.
- Do not pursue TypedAST or multistage for size. Byte-identical output.
- Do not switch `@record` → `@interface` wholesale. `@interface` rejects object
  literals that TS interfaces legally accept, and `--hide_warnings_for=/`
  swallows the mismatch, so the failure would be silent.
- Do not treat the antd-pro coverage count as a kill of the brand *technique*.
  It killed one fixture. Write the pass against a fixture that has proofs.
- Do not delete the extern pins before Phase 5 lands.
- Do not report raw-only or gzip-only. The axes disagree on this workload.

## Part E — Fixture vs product

The fixture arithmetic, kept so nobody re-derives it:

```
plugin overhead vs esbuild        +77.3 KB gzip   (measured at SIMPLE, no renaming)
optimization value extracted      -46.0 KB gzip
                                  -----------
net                               +31.3 KB        (+4.0%)
```

and **−79.4 KB raw (−3.3%)**. 0 of 4,478 renamed names ambiguated. That is
what one global ADVANCED button does to a 94%-vendor React graph. It is a
passed negative test, not a product requirement.

The product is an optimizer that:

- owns the compiler (Phase 3) so policy can be per-name, not per-flag;
- states disjointness proofs as brands (Phase 4) on graphs that have them;
- quotes wire protocols at the boundary (Phase 5) instead of pinning
  `Object.prototype`;
- degrades to E2 (rename off, DCE on) where proofs do not exist, instead of
  minting 2,333 unique shorts and collecting nothing;
- is judged on at least two fixtures: this negative one, and an
  authored-dominant class-based graph. One fixture is how we accidentally
  killed the thesis.

## Part F — Best plan on a fully authored / typed graph

Ignore the antd-pro negative fixture. The product question is: given a
program whose types and module graph are mostly *ours*, what sequence
actually produces E1 (ambiguation fires) without the known silent breaks.

The official examples are the right *shape*, not one shape:

| fixture | what it is | what it tests |
|---|---|---|
| `examples/lit-vite-official` | authored class + decorators (`MyElement extends LitElement`) | M3 / type-driven DCE and ambiguation |
| `examples/jquery-vite-official` | authored TS + string-key protocol | M4 (`protocolHelpers.keyReadCallees`) |
| `examples/react-vite-official` | authored TS whose types are JSX props | that "typed" ≠ nominal; keep `@record` |
| a 200–500 KB class-heavy TS library (still missing) | the `typed-input.md` gate | whether types pay 3–10% raw / 1–5% gzip |

React/Svelte/Vue starters still ship a framework runtime. They are not
"no vendor." They are "vendor is small and the authored surface is typed."
Lit is the canary. A class-heavy library is the prize.

### Sequence

**F1 — Optimizing type lowering (M3). First. No driver.**
Per declaration, whole-program:
- every satisfier is a class we also annotate → `@interface` + `@implements`
- any object literal satisfies it → keep `@record`
Lit's `MyElement` is already a class; `HTMLElementTagNameMap` and React
`Props` stay `@record`. This is why `--use_types_for_optimization` measured
0.08% on antd-pro: we emitted structural types. On a class graph it is the
pass that enables per-type dead-field DCE (`typed-input.md` A2: −79% raw /
−82% gzip on a constructed upper bound) and lets `AmbiguateProperties`
see nominal receivers.

*Kill:* if the authored types are mostly props-interfaces satisfied by
object literals (the React example), M3's ceiling is still low. That kills
M3 on *that* fixture, not on Lit. Do not blanket-rewrite `@record` →
`@interface` (closed-directions #7, silent `JSC_TYPE_MISMATCH`).

*Gate metric:* property.map shows shared short names on the Lit build;
two-axis delta vs `vite.pure.config.ts`. Also watch A1: type-driven
inlining can *raise* gzip while cutting raw. Fail the change if gzip
regresses.

**F2 — Brand leftover authored literals (M2). Same JSDoc channel.**
After F1, remaining unambiguatable names are untyped / structural
literals that do not escape and are not protocols. Stamp those with the
proven `@constructor @struct` + `@type` cast. Coverage on an authored
graph should not look like antd-pro's 18% long tail; if it does, stop.

*Kill:* coverage count on the *positive* fixture. Do not reuse the
antd-pro count.

**F3 — Quote protocols, do not pin `Object.prototype` (M4).**
The jquery example already has the pattern. React host props in the
React example are a wire protocol: quote at the JSX boundary. On Lit /
a TS library this set should be near-empty. Do not generate a 1,233-name
pin file for a 400-line app.

*Hard constraint:* replacement before removal. Dead handlers, empty
console.

**F4 — Resident driver (M1). After E1 is visible, not before.**
argv + JSDoc is enough to *prove* F1/F2 on Lit. The driver is how you
then (a) skip-rename the leftover `@record` names instead of minting
unique shorts, (b) inject brands as a `CompilerPass` if JSDoc gets
lossy, (c) cache `CHECKS` and stop paying 153 ms JVM/spawn. It is the
foundation of the *optimizer product*. It is not the first experiment
on a typed fixture.

**F5 — Consume the module graph, not the post-rollup bundle.**
Only once authored module count is large enough that rollup has already
destroyed the disjointness F2 needs. The five-file examples do not
need this. A real TS library might.

### What not to do on this path either

SIMPLE, `@closureUnaware`, `AliasStrings`, multistage-for-size, a
type-free reuse flag, gating on antd-pro, reporting one size axis.
`typed-input.md` already closed "fix types on a vite-mode dep-dominated
app" as a size project (0.3–2% raw). This path is (ii) in that
document: all-TS, gated on the missing library spike.

### Predicted outcome, stated so it can die

On Lit + a class-heavy library: ambiguation count leaves 0; raw
**3–10%**, gzip **1–5%** vs types-off, concentrated in shared field
names across small classes. On the React example: near zero from F1,
small win from F3 (fewer pins), F2 only on internal non-JSX objects.
If the library spike lands at the A1 end (raw down, gzip up), gzip is
still the ship metric and F1 must be narrowed to dead-field DCE
without the inlining that blew entropy.
