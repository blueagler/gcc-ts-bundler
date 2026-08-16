# Tsickle-style typed input: does carrying TS types into Closure pay?

Research spike. No source changed. All experiments in `/tmp/tl` with
`node_modules/google-closure-compiler-linux-arm64/compiler` (v20260720),
`--compilation_level ADVANCED --language_in UNSTABLE --language_out ECMASCRIPT_2020`.
Sizes are `raw` = bytes of the compiler's output file, `gzip` = `gzip -9`.

---

## TL;DR verdict

| Scenario | Verdict | Expected win |
|---|---|---|
| (i) vite-mode apps (deps dominate) | **NO-GO** as a size project | **0.3 – 2% raw**, gzip may *regress* |
| (ii) standalone TS library / all-TS builds | **GO, but gated** | **unproven; gated on typed externs**, spike first |

The headline measured fact: **on a real linked app today, turning
`--use_types_for_optimization` on vs. off changes output by 28 bytes out of
81,542 (0.03%).** Type-driven passes contribute essentially nothing to our
builds right now.

The second headline fact, and the important one: **our minimal platform
externs make typed input worthless.** In a controlled probe, typed input cut
output by 70% under real browser externs and by **0%** under our
`--env CUSTOM` flat externs. Fixing that is cheap (four days, one file) and is
a hard prerequisite for any tsickle work.

A third headline fact, established later in
`structural-types-defeat-renaming.md`: **we emit `@record` for TypeScript
interfaces, and `@record` is structural, so it can never be ambiguated.** That
is a second hard prerequisite alongside typed externs, and it is why the
`--use_types_for_optimization` A/B stays flat (0.03% here, 0.08% on a
2352-module app) even where type coverage is good. Scenario (ii) below is the
gated-GO case partly for this reason: class-based, mostly-authored TypeScript is
the only shape where the property optimizer can act on our annotations.

---

## 1. What tsickle emits, and what actually matters

Source: `angular/tsickle` (`src/jsdoc_transformer.ts`, `src/type_translator.ts`,
README). **Status: officially unsupported since Nov 2022, no commits to master
since Dec 2023, frozen May 2024.** It is a fork target, not a dependency.

Emission catalog:

| Construct | Closure form | We emit it? |
|---|---|---|
| variable / field type | `@type {T}` | yes (`docs.ts`) |
| function signature | `@param {T} x`, `@return {T}` | yes |
| `this` param | `@this {T}` | yes |
| interface (authored) | `@record` + `if (false)` member decls | yes |
| inferred structural shape | synthesized `@record` | **no, deleted — see §7** |
| type alias | `var X;` + `@typedef {...}` | yes |
| generics | `@template T` | yes |
| `extends` / `implements` | `@extends`, `@implements` | yes |
| enum | `@enum {number|string}` const object | yes (native `render_closure_enum`) |
| class member decls not in ctor | `if (false) { /** @type */ x.p; }` | yes (`emit.rs:168`) |
| nullability | `!T` non-null, `?T` nullable, `T|undefined` | yes (`closure-type-strings.ts`) |
| casts | `/** @type {T} */ (expr)` parenthesized | **no** |
| abstract classes/methods | `@abstract` | **no** |
| `declare` / `.d.ts` | generated externs (name preservation) | partial (`transpile/externs`) |
| exporting decorators | `@ExportDecoratedItems` → `@export` | **no** |
| module system | `goog.module` | yes, but only in `ChunkMode::Off/Split` |
| collapse safety | `@nocollapse`, `@struct`, `@const`, `@final` | **no** |

What tsickle's own authors say matters: the fileoverview of
`jsdoc_transformer.ts` frames the whole thing as "allows Closure Compiler to
make better optimization decisions compared to an untyped code base" — no
quantification. The concrete engineering effort in the file is overwhelmingly
about *not breaking* Closure (tuple types becoming unions "can lead to type
mismatches, which can lead to deoptimizations"; `if (false)` wrappers so
property declarations don't fire superclass getters; array-binding rewrites to
avoid union pollution). The signal to take from that: **most of tsickle is
defensive**, and a partially-wrong type is worse than no type, because Closure
invalidates whole types on mismatch.

**We already have ~80% of the catalog** in `src/build/transpile/closure-ir/`
(2,892 lines of TS-checker-driven JSDoc rendering). The emitter is not the gap.

## 2. Which Closure passes consume types

From the compiler wiki (`Type-Based-Property-Renaming`) and pass behaviour:

- **DisambiguateProperties** — renames `prop` on `Foo` to `Foo$prop` so
  type-blind passes stop conflating unrelated properties. Enables better
  inlining and per-type dead-property removal.
- **AmbiguateProperties** — the inverse; reuses short names across unrelated
  classes so everything trends toward `a, b, c`.
- **RemoveUnusedCode** (property mode) — with disambiguated properties, a field
  can be dropped per-type instead of only when *no* type reads that name.
- **DevirtualizeMethods / InlineProperties / OptimizeParameters** — need a
  unique known receiver type.

Both flags flip together with `--use_types_for_optimization`.

The degradation rule is the one that decides our fate:

> if a property reference `x.prop` is found anywhere in the code where the type
> of `x` is unknown, these passes will leave the name `prop` unchanged
> throughout the code.

**One untyped access poisons a property name globally.** In vite mode our
untyped dependency bundles are 91% of the input, so they poison nearly
everything the app touches.

## 3. Where type information dies in our pipeline

`closure-ir` produces, per file: `topLevelDocs` (JSDoc strings + placement),
`typeDeclarations` (`@record`/`@typedef` snippets), `enumDeclarations`. Those
cross into Rust via `native/src/closure_metadata.rs`. Then:

| Emit path | Chunk mode | `typeDeclarations` | `enumDeclarations` | `topLevelDocs` |
|---|---|---|---|---|
| `emit_goog.rs` | `Off`, `Split` | emitted | emitted | **emitted** (`attach_top_level_docs`) |
| `emit_runtime.rs` | `BundlerRuntime` (non-hoisted) | emitted | emitted | **dropped** |
| `emit_hoist.rs` | `BundlerRuntime` (hoisted) | **dropped** | **dropped** | **dropped** |

`emit_hoist.rs` never receives `file_metadata` at all — `emit.rs:15` calls it
without the parameter.

And `hoist.rs:180`:

```rust
let has_typed_metadata = !metadata.enum_declarations.is_empty()
    || !metadata.type_declarations.is_empty();
let can_hoist = module_chunks.contains_key(&module_id) && !scan.scan_failed && !has_typed_metadata;
```

So today the two are mutually exclusive: **a file either gets flat hoisting or
it gets its types, never both.** Note the predicate ignores `top_level_docs`
entirely, so a file with `@param`/`@return`/`@type` but no typedef/enum hoists
*and silently loses every annotation.*

Verified on the newest cached vite build: **zero `@type`/`@param`/`@return` in
any of the 26 files handed to Closure.**

There is a second, independent type-information sink:
`native/src/transpile/compat/properties.rs` + `externs/analysis.rs`. Because we
have no types in the native layer, `preserved_property_names` is computed by a
syntactic hazard heuristic (`defined_hazard_names ∩ accessed_hazard_names`,
reflective names, platform callbacks) and every hit is **rewritten to a quoted
access**, permanently blocking renaming. Measured on the svelte dep bundle:
390 quoted accesses inserted by us, e.g.

```js
// workspace input (esbuild output)
effect.teardown = effect.ctx = effect.deps = effect.nodes = null;
// what we hand Closure
effect2["teardown"] = effect2["ctx"] = effect2["deps"] = effect2["nodes"] = null;
```

## 4. Measurements

### 4a. Synthetic: where typed input wins, and how much

Generators in `/tmp/tl/gen.js` (method-heavy) and `/tmp/tl/gen2.js`
(dead-property). Per-class bodies are randomized so gzip numbers are not an
artifact of 40× textual repetition. `plain` = ES6 classes with no JSDoc (what we
emit today); `typed` = `@type` on every field, `@param`/`@return` on methods,
`@param {!KlassN}` on the consumers.

**A1 — disambiguation + devirtualization** (40 classes × 12 shared property
names × 8 methods, called in loops):

| variant | raw | gzip |
|---|---|---|
| plain | 66,592 | 16,482 |
| typed | 63,000 | **25,410** |
| typed, `--use_types_for_optimization false` | 66,592 | 16,490 |

Raw −5.4%, **gzip +54%**. Types let Closure devirtualize and inline the 320
methods; the inlined call sites replace a highly repetitive `this.x` body with
per-site `V.x` text. Property renaming report: 20 distinct names before, 12
after — the disambiguation win is real but worth ~0 bytes because names were
already 1 char.

**Takeaway: type-driven inlining is a raw-size win and can be a gzip loss.
Anything we ship here must be judged on gzip.**

**A2 — per-type dead property removal** (40 classes × 12 same-named fields, one
field per class actually read):

| variant | raw | gzip |
|---|---|---|
| plain | 11,926 | 3,708 |
| typed | **2,505** | **673** |
| typed, types-off | 11,936 | 3,673 |

−79% raw, −82% gzip. This is the mechanism that actually pays: without types,
`sharedProperty3` being read *anywhere* keeps `this.sharedProperty3 = ...` in
all 40 classes. This is a deliberate upper bound (11 of 12 fields dead).

**Ranking of annotation classes by measured payoff:**

1. **`@type` on class fields / `this.x` assignments** — unlocks per-type dead
   property removal (A2). By far the biggest lever.
2. **`@param {!T}` on functions that consume class instances** — this is what
   makes the receiver type known at the access site; without it the `@type` on
   the field is inert (the poisoning rule).
3. **`@constructor`/`@record`/`@extends`/`@implements`** — needed to build the
   type graph at all; zero direct size effect, total prerequisite.
4. **`@return`** — feeds 2 transitively; weak on its own.
5. **`@template`, `@typedef`, nullability `!`/`?`** — correctness/soundness, no
   measurable direct size effect.
6. **`@enum`** — we already emit it; it is a *collapsibility* win, not a type win.

### 4b. Realistic probe: newest linked chunk set (svelte-vite-spa)

`~/.cache/gcc-ts-bundler/3a5cbb6d.../final/fa87a8dc.../`.

Closure input composition (`native-emit/*/out`, 26 files, 305,642 bytes):

| | bytes | share |
|---|---|---|
| app code (`src/src/**`, `main__ts`, `index__html`) | 26,558 | **8.7%** |
| dependency bundles (`__dep-bundles/**`) | 279,084 | 91.3% |
| — of which `chunks/chunk-F4IGVW7F.js` (svelte + material) | 244,158 | 79.9% |
| JSDoc annotations anywhere in the input | **0** | — |

A/B on those exact inputs (single-module compile, runtime globals stubbed as
externs, `--jscomp_off duplicate`):

| externs | `use_types_for_optimization` | raw | gzip |
|---|---|---|---|
| CUSTOM (our generated flat externs) | true | 81,542 | 30,393 |
| CUSTOM | false | 81,570 | 30,397 |
| BROWSER (full 2.2 MB externs) | true | 81,561 | 30,378 |
| BROWSER | false | 81,592 | 30,380 |

**Delta from type-based passes: 28 bytes, 0.03%.** Closure reports 58.4% of
expressions as typed from inference alone under CUSTOM, 60.8% under BROWSER —
inference already gets most of what is gettable here, and it buys nothing.

Ceiling from the property-renaming side, over the 7 shipped chunks
(72,481 bytes raw, 27,740 gzip):

| | distinct names | cost if never renamed |
|---|---|---|
| unrenamed, name declared in our externs | 172 | 5,338 B (7.4% of raw) |
| unrenamed, **not** extern-declared | 30 | **1,148 B (1.58% of raw)** |

The 5,338 B is unreachable by typing — extern names are never renamed by
design. The 1,148 B is the true ceiling for the app, and it is dominated by
**svelte-internal** names (`nodes` 140 B, `parent` 120 B, `next` 75 B,
`teardown` 70 B, `deps` 63 B, `effects`, `is_pending`, `transform_error`,
`prev`, `is_fork`). Those live in untyped dependency JS. Typing *app* code
cannot recover them.

Worse, most of them are unrenamed **because we quoted them ourselves** (§3), not
because Closure lacked types. That is a separate, larger, and more tractable
lever than tsickle.

Property renaming report shows only 57 renamed names total, 35 already at 1
char and 22 at 2 chars — renaming is already near-saturated.

### 4c. Interaction with our minimal platform externs — the blocker

The decisive experiment. Same dead-property program as A2, but each class
`extends HTMLElement` (i.e. it touches a platform type, like every web
component and every DOM-adjacent class in a real app):

| externs | input | raw | gzip |
|---|---|---|---|
| `--env BROWSER` (real typed externs) | plain | 13,046 | 3,790 |
| `--env BROWSER` | **typed** | **3,861** | **748** |
| `--env CUSTOM`, `var HTMLElement;` (our shape) | plain | 13,046 | 3,787 |
| `--env CUSTOM`, `var HTMLElement;` | **typed** | **13,046** | **3,787** |
| `--env CUSTOM`, `/** @constructor */ function HTMLElement(){}` | typed | **3,861** | **743** |

Under our current externs shape the typed program compiles to **byte-identical
output to the untyped one**. An untyped `var HTMLElement;` makes the superclass
type unknown, which invalidates the subclass type, which disables every
type-based pass for it.

**And the fix is nearly free:** declaring platform classes as
`/** @constructor */ function X() {}` instead of `var X;` recovers the *entire*
BROWSER-externs win (3,861 / 743, identical) while keeping the externs file
small. `src/build/closure/platform-externs.ts` already knows which names are
globals and which are properties; it needs to additionally know which globals
are constructors and which prototype each property belongs to.

---

## 5. Recommended architecture

**Extend `closure-ir`. Do not port tsickle emission to Rust, and do not depend
on tsickle.**

Rationale:

- tsickle is dead upstream and its authors say they cannot support use outside
  Google's toolchain.
- Emitting Closure JSDoc requires a TS type checker. Porting that to Rust means
  reimplementing `ts.TypeChecker`. Non-starter.
- We already have the emitter — `closure-ir` covers ~80% of the tsickle
  catalog. **The gap is delivery, not emission.**

Work items, in dependency order:

| # | Work | Effort | Why |
|---|---|---|---|
| 0 | **Typed platform externs.** `platform-externs.ts` emits `/** @constructor */ function X(){}` for platform constructors and hangs referenced properties on the right `X.prototype` instead of `Object.prototype`. | **2–4 d** | Hard prerequisite. Without it, everything below measures 0 (§4c). Self-contained, testable, one file. |
| 1 | **Type-informed hazard narrowing.** Feed `closure-ir` type facts into `externs/analysis.rs` so the `defined ∩ accessed` hazard heuristic stops quoting properties it can prove are monomorphic. | **5–8 d** | Directly targets the measured 1,148 B (1.58% raw) and is the only lever that reaches *dependency* code (via app-side type facts about dep objects — limited). Highest correctness risk: a wrong un-quote is a runtime break. Needs a real regression corpus. |
| 2 | **Route `topLevelDocs` into `emit_runtime.rs` and `emit_hoist.rs`;** drop the `has_typed_metadata` hoist veto in `hoist.rs:180` by emitting typedef/enum snippets in the hoisted form too. | **3–5 d** | Fiddly: hoisting renames declarations, so the current name-matching `attach_top_level_docs` (string `insert_before_text`) will not find them. Wants a real AST-level attach rather than text insertion. |
| 3 | **Catalog gaps:** `@abstract`, casts `/** @type {T} */ (e)`, `@nocollapse`, `@struct`, `@const`. | **3–5 d** | Small incremental value; do last, driven by measurement. |

Item 0 is worth doing **regardless of the tsickle verdict** — it is the only
reason our existing `Off`/`Split`-mode JSDoc is not paying off either.

## 6. GO / NO-GO

### (i) vite-mode apps — **NO-GO** as a size initiative

Evidence:

- Type-based passes contribute **0.03%** today.
- App code is **8.7%** of Closure input; deps are 91.3% and are untyped JS that
  we cannot annotate.
- The global-poisoning rule means typed app code loses its type wherever it
  touches an untyped dep value — which for a Svelte/Material app is nearly
  every hot object.
- Total measured recoverable property-name budget across all chunks is
  **1,148 B = 1.58% raw**, and it is mostly *inside* the untyped dep bundle.
- A1 shows type-driven inlining can make **gzip worse**, which is the metric
  that ships.

Expected win if we did items 0+2+3: **0.3 – 2% raw, −1% to +3% gzip.** Not
worth 8–14 days.

The *actual* vite-mode lever the data points at is item 1 (stop quoting 390
properties in the dep bundle) plus item 0 — a different project that happens to
share a prerequisite.

### (ii) standalone TS library / all-TS builds — **GO, gated**

Here the argument flips: 100% of input is TS with a checker available, so the
poisoning rule works *for* us instead of against us, and A2's mechanism
(per-type dead property removal) is live across the whole program. `Off`/`Split`
chunk modes already carry the JSDoc, so item 2 is not even on the critical path.

But we have **no measured number** for a realistic all-TS program — A2's −79% is
a constructed upper bound and A1's gzip regression is a constructed lower bound.
The honest range spans them.

**Gate: do item 0 (2–4 d), then a 1-day spike** — take one real TS library
(200–500 KB of source, class-heavy), build it in `Off` mode with and without
`GCC_USE_TYPES_FOR_OPTIMIZATION`, and report raw + gzip. That measurement, not
this document, decides items 1–3.

Predicted spike outcome, stated so it can be falsified: **3–10% raw, 1–5%
gzip**, concentrated in codebases with many small classes sharing field names,
and near zero for functional/module-style code.

---

## Reproduction

```
/tmp/tl/gen.js    # A1 generator  -> plain.js / typed.js
/tmp/tl/gen2.js   # A2 generator  -> dead-plain.js / dead-typed.js
/tmp/tl/gen3.js   # 4c generator  -> base-plain.js / base-typed.js / externs-min.js
/tmp/tl/run.sh <file.js> <label> [flags...]   # compile + report raw/gzip
```

---

## Addendum: coordinator re-measurement (invalidates §4b/§6 partially)

**Every prior pipeline measurement ran without type inference.** Our jobs pass
`--warning_level QUIET`, which disables the checkTypes pass entirely — so
`--use_types_for_optimization` (default true) has never had types to consume,
and the "28 bytes of 81,542" toggle result measured nothing. Inference runs
silently with `--jscomp_warning=checkTypes --hide_warnings_for=/`.

Re-measured with inference enabled:

| experiment | result |
|---|---|
| E2 typed dead-field removal (was: no effect) | 159 B → **118 B (−26%)**: per-type dead property removed, values constant-folded through `@param` types |
| E1 poisoning granularity | **per-property, not per-class**: typed classes flowing through an untyped (template-shaped) access keep every win except on the specific properties the untyped code touches — typed 148 B vs untyped 208 B (−29%) with the untyped access present |
| fully-typed variant | collapses to `window.app=function(){}` (25 B) |
| real chunk job, untyped input, inference on | −38 B gz total, +183 ms — nearly free, and the floor for the typed track |
| typed ctor platform externs, untyped input, inference on | still **+134 B gz** — the "typed externs only with typed input" gate stands |

**Revised verdict for the Vite path: GO.** Typed app modules (plain `.ts`)
annotated tsickle-style + silent inference + typed platform externs gated on
typed input. The 8.7%-of-input argument stands for this demo app but not for
app-logic-heavy codebases, and per-property poisoning means framework interop
does not erase the wins.

## Unified sidecar implementation

The initial Vite-only positional JSDoc prototype has been replaced. Standalone
and Vite now use the same TypeScript checker/extractor and serialize structured,
tokenized facts through `closure-ir.json`: binding/member targets, declarations,
safe enums, canonical symbol identities, provenance, and degradation diagnostics.
Native resolves those facts after its final import/hoist/registry plan and reports
the exact delivered counts for every emitted JavaScript file.

Closure decisions are derived per compile job from native-delivered counts.
ADVANCED jobs with delivered metadata enable silent `checkTypes` inference and
the typed platform extern slice; untyped jobs retain the full browser externs.
`GCC_DISABLE_TYPE_INFERENCE=1` removes optional annotations/declarations and the
typed platform slice while keeping semantic enum and decorator lowering. Vite
declaration overlays and fused prebundle facades attach metadata only where final
runtime binding provenance is proven.

Validation on a purpose-built 520-line typed domain app: mechanism fully
functional (45 JSDoc blocks, correct suffixed refs, zero runtime errors), size
delta **a wash (−36 raw / +25 gz)**. Root cause is not the types: the
runtime-aware externs generator passes every materialized runtime module as a
runtime entry and externs every member both defined and accessed there, so
app domain properties (`balanceMinor`, …) become extern-preserved — unrenamable
and un-disambiguatable. **The next size lever is narrowing runtime-aware
externs to true boundary crossings**; it would benefit untyped builds too
(externs generation measured ~1.2 KB raw on the fixture).

Also fixed while validating: preserved-property quoting produced valueless
quoted class fields (`"id";`), an INTERNAL COMPILER ERROR in Closure's
ConvertToDottedProperties; quoting now emits `= void 0` (semantically
identical under define semantics).

---

## 7. Structural record synthesis: measured at zero, deleted

The unified sidecar originally synthesized a `@record` declaration for any
object-shaped type it could not name: intersections, `.d.ts` interfaces the
compiled file did not declare, destructured object parameters, and every
structural type reached through inference. That subsystem is gone.

### Why

A one-line kill switch (`buildRecordForObjectType` returning `null`) was
compared against the shipped artifacts. Output was **SHA-256 identical** on
every typed example:

| Example | Output files | SHA-256 vs shipped `dist` | closure-ir bytes before → after | generated records |
|---|---:|---|---:|---:|
| react-spa | 1 | identical | 2,683,905 → 319,744 (**−88.1%**) | 1,769 → 0 |
| lit-playground | 4 | identical | 190,316 → 94,901 (**−50.1%**) | 76 → 0 |
| vue-vapor-spa | 4 | identical | 852,120 → 682,158 (**−19.9%**) | 161 → 0 |

React build time (median of 3, cold persistent cache): **9,029 ms → 7,723 ms
(−1,306 ms, −14.5%)**.

Delivered value was therefore exactly zero bytes, while the cost was ~2.4 MB of
compiler-input IR per React build, ~14% of build wall time, a fixed 160-record
per-file budget keyed by `ts.Type` identity, a name-reservation/interning table,
and the malformed-`!?` class of JSDoc that shipped 45,420 dead bytes to
production before it was contained by an `if (false)` wrapper. Ranking item 3 in
§4 already said the type graph is a prerequisite with "zero direct size effect";
the measurement says a *synthesized* graph over third-party `.d.ts` closures is
prerequisite for nothing.

### What replaced it

Nothing. An object atom with no faithful Closure spelling degrades to `?`
through the pre-existing unsupported-atom path, which records a nonfatal
`unsupported-type-atom` diagnostic and increments
`unresolvedTypeReferenceCount`. Intersections render `!Object`.

### What is unchanged

Everything authored is still lowered exactly as before:

- `interface` / type-literal `type` → `@record` + `if (false)` member
  declarations (`docs.ts`), including `@template` parameters;
- non-literal `type` aliases → `@typedef`;
- class/member annotations, `@param`/`@return`/`@this`, variable `@type`;
- enums (`@enum` const objects) and decorator lowering;
- silent `checkTypes` inference on ADVANCED jobs with delivered metadata;
- `GCC_DISABLE_TYPE_INFERENCE=1` semantics;
- native declared-symbol renaming for those declarations.

The invariant is now structural rather than defensive: **the pipeline never
invents a type declaration the source did not write**, so an unbounded
third-party type graph can no longer be walked into the compiler input, and a
recursive shape can no longer render an unparseable `!?` atom.
