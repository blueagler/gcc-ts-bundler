# Plan: repoint the optimizer, delete the lossy channels

Derived from `optimization-architecture.md` and the four research spikes.
Every size number is measured on the Ant Design Pro trial app (2,352 modules,
94.1% dependency bytes, compiler `v20260811`). Line counts are from this
repository. `[INFERENCE]` marks anything not measured.

---

## The thesis in one sentence

**The brand+cast transform works and has nothing hot to apply to on this
class of app.** Own the compiler as a library for E2 and incrementality;
collapse the extern barrier to a site-local data boundary; do not extend
the type-metadata channel for brands.

Phase 2 proved a synthesized `@constructor @struct` brand plus a `@type` cast
is enough (`g,h,i` / `j,l,m` → both `g,h,i`). Phase 4 then measured the
candidate set on the trial app: 18% of renamed names, a long tail by refs,
every hot name excluded. The two subsystems that were going to *carry* that
transform remain
**~12,000 lines whose combined measured contribution to size is negative**:

| subsystem | lines | measured size contribution |
|---|---|---|
| `native/src/transpile/type_metadata{,_oxc}.rs` | 1,253 | part of the **0.08%** type-pass A/B |
| `src/vite/type-metadata/**` | 2,259 | same 0.08% |
| `src/build/closure/platform-externs/**` | 1,509 | `typed-input.md`: makes typed input worthless as built |
| `src/externs/**` | 6,880 | **−10.7 KB gzip** (buys React correctness) |

Neither can be deleted outright — the externs buy a working app, and the type
metadata gates `checkTypes`. They can be *replaced* by cheaper mechanisms, and
then deleted. That ordering is the whole plan.

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

Ordered loosely by dependency. Phase 4 no longer waits on Phase 3 — and is
now dead on its own coverage count. Each remaining phase has a kill
criterion; if it trips, stop.

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
jar behind a `makePassForTesting` capability probe, keep argv. E2 stays
unreachable. E1 via brands is independently dead (Phase 4); the driver is no
longer a prerequisite for anything that remains except E2 and incrementality.

### Phase 4 — Graph-derived disjointness — **killed on this workload**

The transform is proven (Phase 2). The coverage count is not. Do not write
the branding pass. `type_metadata{,_oxc}.rs` and `src/vite/type-metadata/**`
stay only to gate `checkTypes`; they are not load-bearing for brands.

*Coverage, measured, then killed.* oxc-parser 0.144.0 over the 2,484-file
`edb17e1ecb63` materialized graph (0 parse failures). Distinct property names
in the graph: **9,465**. The "~8,400 renamed properties" figure was the *sum*
of two overlapping maps (4,452 + 3,963 = 8,415, overlap 3,937); the union is
**4,478** distinct originals, **0 shared short names**. Strict branding
candidates (every object-literal shape single-subgraph, non-escaping, never
dynamically keyed, not pinned, not a React host prop): **1,284** names, of
which **823 are already renamed (18.4% of the union)**. Permissive range:
858 renamed (19.2%). First-reason exclusions among renamed names: escaping
1,589, no object-literal shape 1,116, dynamic-keyed 879, cross-subgraph 35,
extern-pin 9, framework-protocol 0. The hot names that dominate gzip
(`length` 2,063 refs, `key` 1,760, `current` 1,755, `value` 1,754,
`children` 1,648, `className` 1,646, `style` 1,227) are all excluded. The
hottest *renamed* candidates that branding could actually shorten are a long
tail (`getParser` 25 local refs, `getParentRoute` 19, `inKeyframes` /
`outKeyframes` 18). `[INFERENCE]` shortening the unrenamed ident-like
candidates saves ~4.3 KB raw / ~1.5 KB gzip; even partial-branding every
safe shape on mixed names is ~29 KB raw / ~10 KB gzip — against a **31.3 KB
gzip gap**. Neither moves reuse 7.6 → 16.0 nor ratio 2.85 → 3.07.

*Kill criterion tripped.* Phase 4 is dead on this workload. Do not write the
branding pass. The 1,253 + 2,259 type-metadata lines should be fixed (Phase
4b) rather than extended, and only if an authored-dominant class-based app
is in scope. Part C's "give Closure the module graph" follow-on does not
open.

*Phase 4b, the fallback:* make type lowering *optimizing* instead of faithful —
`@interface` + `@implements` where every satisfier in the program is a class,
`@record` otherwise. Cheaper, but requires the emitter to become program-wide
instead of per-file, and its ceiling is bounded by how many interfaces are
class-only.

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

More aggressively, and `[INFERENCE]`: giving Closure the **post-rollup bundle**
destroys module boundaries. That follow-on was gated on Phase 4's coverage
count being high. It was not. Do not open "Closure consumes the module graph,
rollup is only a resolver."

## Part D — What not to do

- Do not tier compilation levels. Measured worse (+9.9%).
- Do not look for a flag. No type-free property-name reuse exists in the
  compiler; source-proven.
- Do not pursue TypedAST or multistage for size. Byte-identical output.
- Do not switch `@record` → `@interface` wholesale. `@interface` rejects object
  literals that TS interfaces legally accept, and `--hide_warnings_for=/`
  swallows the mismatch, so the failure would be silent.
- Do not write the branding pass on this class of app. Coverage is a long tail;
  see Phase 4.
- Do not delete the extern pins before Phase 5 lands.
- Do not report raw-only or gzip-only. The axes disagree on this workload.

## Part E — Honest scope statement

The arithmetic that motivates all of the above:

```
plugin overhead vs esbuild        +77.3 KB gzip   (measured at SIMPLE, no renaming)
optimization value extracted      -46.0 KB gzip
                                  -----------
net                               +31.3 KB        (+4.0%)
```
and on the other axis, **−79.4 KB raw (−3.3%)**, which is what V8 parses.

0 of **4,478** distinct renamed properties are ambiguated on the real app
(the older "~8,400" figure double-counted two overlapping maps). Phase 2
proved the transform (`g,h,i` / `j,l,m` → both `g,h,i`); Phase 4's coverage
count then showed the transform has nothing hot to apply to. The candidate
set is 18% by name and a long tail by refs. That is the measured end of the
brand path on vendor-dominated React.

The correct outcome is not more engineering on brands. This project pays for
authored-dominant, class-based TypeScript and not for vendor-dominated React
applications. The two-axis gate from Phase 1 should tell users which side of
that line they are on. What remains open is Phase 3 (driver: E2, incrementality,
JVM warmth), Phase 4b (optimizing type lowering, ceiling bounded by
class-only interfaces), Phase 5 (site-local quoted access, recovers the
measured 10.7 KB pin cost without claiming ambiguation), and Phase 6
(platform-externs: keep or delete).
