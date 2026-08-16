# Plan: repoint the optimizer, delete the lossy channels

Derived from `optimization-architecture.md` and the four research spikes.
Every size number is measured on the Ant Design Pro trial app (2,352 modules,
94.1% dependency bytes, compiler `v20260811`). Line counts are from this
repository. `[INFERENCE]` marks anything not measured.

---

## The thesis in one sentence

**Own the compiler as a library, inject the analysis Closure is missing, and
delete the two subsystems that have been trying to achieve that through lossy
channels.**

The channels are (1) JSDoc type emission, which cannot express disjointness
because TypeScript is structural, and (2) generated `Object.prototype` externs,
which express a site-local hazard as a program-wide ban. Together they are
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

## Part A — Delete now, no prerequisites

These are safe today and cost nothing to give up.

**A1. The four inert options.** `externs.generate.includeDependencies`,
`externs.generate.modules`, `chunks.mode`, `finalMinify` all produced
byte-identical output through the Vite plugin. Cause is confirmed at
`src/vite/config.ts:98-129`: the user's `compiler` object is spread and then the
Vite-managed fields are overwritten (`mode: "bundler-runtime"` hardcoded at 118,
`externs` replaced at 104).
→ `Omit` the managed fields from `GccTsBundlerVitePluginOptions["compiler"]` so
the type rejects them at compile time. A caller who writes one today gets
silence; they should get a type error.

**A2. The advice that names them.** `src/externs/barriers.ts:194` tells users to
"set `includeDependencies: false`, or move to `mode: runtime-aware`" — the first
is inert through the Vite path and the second is already the mode in use. Rewrite
the warning to state the real cost (10.7 KB gzip, ambiguation blocked) and the
real lever (fewer hazard sites, not fewer modules).

**A3. `compilationLevel` on the Vite surface.** SIMPLE measured **+9.9%** gzip
versus esbuild, worse than the ADVANCED default. WHITESPACE_ONLY is worse again.
Exposing them on a Vite plugin invites a user to make their bundle worse while
believing they are being conservative.
→ Keep them in the core/CLI API, remove or hard-warn on the Vite path.

**A4. Raw-size-only reporting.** The build reports raw bytes and gates on
nothing; a 4.0% wire regression passed every check.
→ Report **both** axes (raw for CPU, `gzip -9` for transfer) and fail against a
no-plugin baseline. This is a prerequisite for judging every later phase, so it
is also Phase 1 below.

**A5. Closed research directions**, recorded so nobody re-runs them: compilation-
level tiering, `@closureUnaware`, `AliasStrings`, multistage-for-size,
`--renaming=false` under ADVANCED, narrowing externs by module list, and blanket
`@record` → `@interface`. Each is measured or source-proven dead in the spikes.

## Part B — Replace, then delete

Ordered by dependency. Each phase has a kill criterion; if it trips, stop and the
later phases do not happen.

### Phase 1 — Two-axis measurement and gate

Report summed `gzip -9` and summed raw against a no-plugin baseline, per build.
Small, and everything downstream is unjudgeable without it.

*Kill criterion:* none. This happens regardless.

### Phase 2 — The 30-line probe that decides the rest

Implement the smallest possible `CompilerPass` (`process(externs, root)`), brand
two provably-disjoint object-literal shapes as nominal, inject at
`addCustomPass(BEFORE_CHECKS, …)`, and check whether their properties receive the
same short name. All of these ship in the pinned jar (verified in
`optimization-architecture.md` §7).

*Kill criterion:* if ambiguation still refuses on hand-branded input, the custom
pass route is dead. Phases 4 and 5 collapse, and the honest conclusion is that
this project pays only for authored-dominant class-based TypeScript — which then
becomes a documentation and scoping change, not an engineering one.

**This is the cheapest decisive experiment in the plan. Do it before writing any
driver code.**

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
jar behind a `makePassForTesting` capability probe, keep argv and accept the E2
ceiling.

### Phase 4 — Graph-derived disjointness pass

Compute, from the module graph the bundler already owns, which object-literal
shapes are single-subgraph, non-escaping, and never dynamically keyed. Brand
those as nominal in the custom pass. This is the project's thesis stated
correctly: not "TypeScript types help Closure" but "**the bundler knows the graph;
Closure knows how to exploit disjointness; a custom pass is the wire.**"

*Deletes:* the `@record` emission path — `type_metadata.rs` + `type_metadata_oxc.rs`
(1,253 lines) and `src/vite/type-metadata/**` (2,259 lines) — because the pass
supersedes the channel. Keep whatever minimum still gates `checkTypes`.

*Do first, before writing the pass:* count how many of the ~8,400 properties
qualify. If the qualifying fraction is small, Phase 4 is dead on paper and the
1,253 + 2,259 lines should be fixed (Phase 4b) rather than replaced.

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
nothing. After Phases 4–5 the question is answerable rather than speculative:
either it becomes load-bearing for the disjointness pass, or it is 1,509 lines of
cache machinery for an unused artifact.

## Part C — Collapse the three overlapping optimizers

rollup tree-shakes, Closure DCEs and renames, esbuild re-minifies. Each was
chosen independently and the composition is worse than the best single one:
`finalMinify: false` measured byte-identical, so the esbuild post-pass is either
inert or overridden — and either answer means deleting something.

More aggressively, and `[INFERENCE]`: giving Closure the **post-rollup bundle**
destroys the module boundaries that Phase 4 needs. Rollup merges 2,352 modules
into 52 chunks, and the disjointness evidence is gone before the optimizer sees
it. Google's own pipeline is source-to-one-binary with no bundler in front. If
Phase 2 succeeds, the follow-on question is whether Closure should consume the
module graph rather than the bundle, with rollup reduced to resolution and plugin
hosting. That is a larger change than Phases 3–5 combined and should only be
opened if Phase 4's coverage count is high.

## Part D — What not to do

- Do not tier compilation levels. Measured worse (+9.9%).
- Do not look for a flag. No type-free property-name reuse exists in the
  compiler; source-proven.
- Do not pursue TypedAST or multistage for size. Byte-identical output.
- Do not switch `@record` → `@interface` wholesale. `@interface` rejects object
  literals that TS interfaces legally accept, and `--hide_warnings_for=/`
  swallows the mismatch, so the failure would be silent.
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

0 of ~8,400 properties are ambiguated on the real app, so the pass that would
make renaming decisively profitable contributes exactly nothing today. Phases 2
and 4 exist to change that number; everything else exists to stop paying for
channels that cannot.

If Phase 2 fails, the correct outcome is not more engineering. It is to document
that this project pays for authored-dominant, class-based TypeScript and not for
vendor-dominated React applications, and to make the two-axis gate from Phase 1
tell users which side of that line they are on.
