# Externs v3: the boundary model, and what Closure-annotated JS should be

Status: design. Companion to `externs-generator-v2.md` (which this supersedes
conceptually) and `typed-input.md` (whose Addendum this builds on).

---

## Part I — What a good extern is

### 1. Closure's actual model

Closure Compiler's world has exactly two regions:

- **The program** — everything it compiles. It may rename, inline, delete,
  and reorder anything here, because it can see every definition and use.
- **The environment** — everything else: the browser, other scripts, the
  network, storage, message peers.

An extern is a **typed declaration of the environment**. That is all it is.
It exists so the compiler knows, at the boundary, which spellings are ABI
and what shapes cross it.

`Object.prototype.foo;` is the degenerate form: a rename barrier that does
not say *whose* `foo` is meant. It removes the name from both the renaming
and the disambiguation universe for every object in the program.

> **FALSIFIED (W2-1, /tmp/gcc-w2-owner-typed.md): the shape does not
> matter.** Closure's extern property set is one flat global untyped name
> set. `Object.prototype.foo;`, `Owner.prototype.foo;` with
> `@constructor`, `@record` members, and typedef record keys all pin
> identically — proven via `--property_renaming_report` on four shapes,
> SHA-256-identical outputs on jquery-demo (63 barriers) and svelte-spa
> (24 barriers), with `--use_types_for_optimization` on and off. The
> "+128% flat vs owner-typed" figure previously cited here was the cost
> of *externing a name at all* versus not externing it, mislabelled.

Therefore the only cost lever for an extern pin is **count**, not shape.
A good extern is one that provably must exist; the second-best extern is
one deleted. Owner-typed *syntax* remains legitimate where a real foreign
type is being declared (boundary B), but it buys type-checking, not bytes.

### 2. The closed-world principle

**The bundle offers no surface except its declared entries.** Nothing inside
is kept callable for the benefit of hypothetical external consumers. Every
extern therefore points *inbound* — it declares what we consume from the
environment — never *outbound*. The only outbound mechanism is the explicit
export channel (gcc-exports), driven by declared entry points, and it is not
an extern.

Consequences:

- Internal reflective patterns are never a reason to pin a name "in case
  someone outside relies on it." Nobody outside exists.
- For string-keyed access in **our own emitted code**, the correct tool is
  `goog.reflect.objectProperty("name", obj)` — Closure rewrites the string
  to the renamed name. Zero pinning, zero bytes, and the property remains
  fully renameable. This is strictly better than any extern and is available
  precisely because we own the call site.
- For string-keyed access in **third-party compiled code** (jQuery's
  `deferred[tuple[0]+"With"]`), we cannot rewrite the site, so we repair
  visibility with the narrowest available pin (owner-typed when provable,
  flat otherwise).

### 3. Five boundaries, five artifacts

"Externs" today conflates five different boundary kinds. Naming them
separates what is genuinely foreign from what is merely invisible:

| # | Boundary | What crosses | Correct artifact | Today |
|---|----------|--------------|------------------|-------|
| A | Platform (DOM, Node) | typed foreign API | sliced platform externs | have |
| B | Foreign code (`<script>`, CDN, other bundles) | typed foreign objects | typed externs generated from `.d.ts` (`typed-render.ts`) | have, `runtime:"external"` only |
| C | Foreign data (JSON, postMessage, storage, config) | structural *values* | flat pins for the names that provably cross, derived from TS types + evidence at the boundary — ~~`@record` scoping~~ **falsified (W2-1)**: record externs pin globally, exactly like flat | have — evidence collectors |
| D | Reflection inside the program (constructed keys, for-in protocols) | nothing — it never leaves | **not an extern.** Renamer-visibility repair: `goog.reflect` for our code; owner-typed pin (fallback flat) for third-party compiled code | mislabeled "runtime-aware externs" |
| E | Our exports | our declared entries | gcc-exports, entry-driven | have |

The label "runtime-aware externs" is a misnomer worth retiring in docs: it is
a repair channel for the renamer, not a declaration of the environment. It
must keep working — jQuery dies without it — but its semantics (rename
unification on one owner) are different from an extern's (existence + ABI +
type), and conflating them is why the flat form looked normal.

### 4. Criteria for a good extern

1. **Fewest names.** Shape is irrelevant (W2-1 falsification); the only
   lever is count. Every candidate pin must prove it crosses a boundary or
   repairs a proven hazard; the best extern is one deleted.
2. **Evidence-backed.** Generated from proven flows (app usage against
   `.d.ts`, runtime hazard analysis, boundary type extraction) — never from
   vocabulary lists.
3. **Direction-correct.** Inbound only. Exports are not externs.
4. **Measured.** Every pin's cost is observable (see Part II §5); an extern
   that cannot justify its bytes is deleted. The ledger attributes every
   kept-original name to its channel; unattributed names are suspects.
5. **Typed only at real foreign-code boundaries (B),** where declarations
   buy checkTypes — never as a byte optimization.

---

## Part II — Closure-annotated JS vs TypeScript

### 1. Two type systems with different jobs

- **TypeScript types** exist to prove things to humans at build time. They
  are erased, structural, and expression-rich (conditional, mapped, literal
  types). Their consumer is the developer.
- **Closure annotations** exist to license optimizations. They survive into
  the optimizer, are nominal-leaning (the modern "colors" pool), and have a
  deliberately small vocabulary. Their consumer is the renamer, the
  disambiguator, the inliner, and dead-code elimination.

Translation between them is lossy *by design*, and the objective function is
not "preserve meaning" — TS already proved the program correct. It is
**"preserve optimization-relevant distinctions"**: ownership, hierarchy,
constness, arity, enum-ness, nullability. Literal narrowing and conditional
types have no optimizer value and should not survive translation.

### 2. Emit the checker's verdict, not the type expression

The answer to "can we infer it all from TypeScript?" is **yes — because the
TS checker is the oracle, not the syntax.** A mapped type, a conditional
type, an inferred generic instantiation: the checker *evaluates* all of
these to concrete shapes. Emission must ask the checker for the resolved
verdict (`getApparentType`, resolved signatures, instantiated type
arguments) and lower *that* into Closure's vocabulary. We never translate a
type expression structurally; we translate its evaluation. Anything the
checker cannot resolve to a Closure-expressible shape degrades at the
smallest node to `?` — the existing rule, kept.

### 3. Where we are today (evidence)

- The whole emission path (`closure-ir/metadata/docs.ts` +
  `native/src/transpile/type_metadata.rs`) uses: `@record` ×2, `@template`
  ×1, `@typedef` ×1, `@type` ×4 — and **zero** `@interface`, `@extends`,
  `@implements`, `@enum`, `@const`, `@this`, `@final`, `@override`,
  `@nosideeffects`. No class hierarchy, no constness, no enum typing, no
  ownership reaches Closure.
- Structural record metadata was deleted this wave after proving **zero
  delivered bytes** (SHA-identical output with it disabled). The records
  failed not because declarations are worthless but because they were never
  *attached* — no access site, parameter, or cast ever bound a value to a
  record color, so the disambiguator had shapes with no instances.
- `typed-input.md` E1 established that poisoning is **per-property**: one
  access through an unknown type invalidates that property name
  program-wide, and only that name.

### 4. Why "too simple" is expensive — the loop

Put those together:

    sparse annotation
      ⇒ most property accesses sit on unknown colors
      ⇒ per-property invalidation covers most names
      ⇒ disambiguation and typed DCE fire on almost nothing
      ⇒ "types measured nothing" (the old §4b verdict)
      ⇒ no incentive to enrich annotation
      ⇒ sparse annotation

The first exposure of this loop was mechanical (`--warning_level QUIET` had
checkTypes off entirely, so `--use_types_for_optimization` had no types to
consume). The second exposure is semantic: inference is on now, but we feed
it a nearly empty vocabulary, so the measured value of types stays close to
zero *and will stay there no matter what Closure could do*. The E2 re-runs
show the ceiling when the loop is broken: typed dead-field removal −26% on
the probe; the fully-typed variant collapses to 25 bytes.

### 5. Break the loop with a metric, not with faith

Before enriching anything: make annotation quality **observable**. A build
already writes a property renaming report. The harness:

1. Per build, extract: total property names; renamed; pinned-by-extern
   (ours, by channel A–E); invalidated-by-unknown-access (with the first
   offending access site each).
2. Emit it as a table next to the size row. CI keeps both.
3. Every annotation/extern change must move `invalidated ↓` or
   `bytes ↓` — a change that moves neither is deleted (the records lesson,
   generalized into a gate).

This converts "is our annotation too simple?" from an opinion into a
per-name ledger with file:line evidence.

**Implemented: `scripts/property-ledger.ts`** (`bun run ledger`, or
`bun scripts/property-ledger.ts`; `--example <name>`, `--json <path>`,
`--top <n>`). It runs an isolated probe build per example under
`/tmp/gcc-ledger` (override with `GCC_LEDGER_PROBE_ROOT`) — never touching a
`dist` in the worktree, and redirecting the Vite path's persistent cache with
`XDG_CACHE_HOME` so no shared cache state is read or written — then joins the
job's property renaming report against the extern inputs and the emitted
output to produce, per example: distinct output property names, renamed vs
kept-original, kept-original attributed to the channel that pins it
(`explicit` B/C/D, `generated`, `native`, `runtime`, `package`, `platform` A,
`platform-builtin`, `ecma-core`), and the cost ranking `occurrences x name
length`. It is deterministic: sorted throughout, no wall-clock value in the
JSON, and probe-root paths collapse to `<probe>/<basename>` so two runs under
different roots produce identical output. Baseline:
`/tmp/gcc-ledger-baseline.json`.

**One honest deviation from the plan above.** Closure v20260720 exposes no
general invalidation report to a CLI caller, so the `invalidated` column is
an approximation and is named `invalidation-suspect`: kept-original *and*
declared by no extern channel *and* not an ECMA core name. Verified against
the shipped compiler: the `typeInvalidation` diagnostic group
(`JSC_PROPERTY_INVALIDATION`) only fires for names listed in
`CompilerOptions.propertiesThatMustDisambiguate`, an allowlist with no CLI
flag — `--jscomp_error typeInvalidation` on a program with a demonstrably
invalidated property emits nothing; and `--debug_log_directory`, which would
dump `DisambiguateProperties`' JSON through `logForDiagnostics`, exists on
`CompilerOptions` but is rejected by `CommandLineRunner` as "not a valid
option". Both a real report and the exact offending access site therefore
need either a compiler upgrade that exports one, or driving Closure through
the Java API instead of the CLI. Until then the ledger reports the first
*access site in the program Closure compiled* (`native-emit/**/out`), which
is a real read of that name, not the invalidating one.

### 6. Full-fidelity emission (the redesign)

**Verdict IR.** One checker pass extends `closure-ir.json` with:

- a **nominal type table**: every class with `@extends`/`@implements`;
  one canonical `@record` per *used* interface (dedup by structural
  identity); `@enum` for enums; `@typedef` for aliases; `@const` where TS
  proves readonly/never-reassigned; `!`/`?` nullability from
  strictNullChecks; `@template` with constraints where expressible.
- **per-access-site owner verdicts**: for every property access where the
  checker knows the static owner type but Closure's local inference will
  lose it (awaited results, destructured bindings, narrowed unions, array
  element reads, callback parameters), the IR records the owner so native
  can emit a cast `/** @type {!Owner} */ (expr)` at exactly that site.
  Casts are the *retail* channel of fidelity: declarations without
  attachment delivered zero bytes; attachment at access sites is what makes
  the disambiguator act.
- a **boundary table**: which types cross which boundary kind (A–E), so the
  same table drives in-program annotation, `@record` data-boundary externs,
  typed foreign-code externs, repairs, and exports — one oracle, five
  artifacts.

**What not to do:**

- Do not chase checkTypes cleanliness. TS proved the program; Closure
  warnings are suppressed wholesale (`--hide_warnings_for=/`), and we never
  contort emission to satisfy them.
- Do not translate type syntax. Evaluate, then lower (§2).
- Do not guess. `?` at the smallest node remains the only degradation.
- Do not emit what nothing consumes. Every declaration must be reachable
  from an attachment (cast, param, extern) or it is dead weight — enforced
  by the §5 gate.

### 7. Migration order (revised after W2-0/W2-1/W2-B evidence)

Original plan assumed annotation fidelity was the byte lever. Measurement
says otherwise: the tsickle bench puts our whole fidelity gap at 0.7% while
ten extern names cost 9.2%; the ledger says the platform slice dominates
kept-original cost (66% on react-spa) and native/runtime channels pin zero
names. Revised order:

1. **W2-0 (done):** `bun run ledger` — per-name channel attribution; true
   Closure invalidation reporting unavailable from the CLI (recorded), so
   the suspect column approximates it.
2. **W2-1 (done, falsifying):** owner-typed externs abandoned — shape is a
   no-op. Count is the lever.
3. **W2-R (running):** correctness family — sibling-key evidence rule
   (jQuery `swing`), app-side mixed dot/string access miscompile (shared
   with tsickle), same-job quoting policy probe.
4. **Platform-slice reduction:** attack the dominant pin channel (66% of
   react-spa kept-original cost).
5. **CJS interop export channel:** react-spa's 89 suspects are one
   channel (`unstable_*`, `use*`, `__*_INTERNALS_*`), not 89 problems.
6. **W2-2/W2-3 (demoted):** nominal skeleton + access-site casts are now
   correctness/robustness plays, not size plays — justified only by the
   W2-C corpus showdown dimensions, not bytes.
7. ~~W2-4 `@record` data-boundary externs~~ — **cancelled**: record
   scoping falsified; existing flat evidence pins are already optimal in
   shape and near-optimal in count.

Each wave lands with two rows: bytes and ledger deltas. Either improves or
the wave reverts. No compatibility gates; replaced forms are deleted.

---

## Appendix: tsickle head-to-head

Measured 2026-07-29 on a 5-module, zero-dependency TS fixture built to reward
annotations (class hierarchy, cross-module interfaces, both enum kinds,
generics, readonly, strict null, 3 dead typed fields, one string-keyed object).
Same Closure binary (v20260726, ADVANCED, `ECMASCRIPT_NEXT`) on both sides.
tsickle 0.46.3 + TypeScript 4.7.4 (its peer ceiling). Full report:
`/tmp/gcc-w2-tsickle-bench.md`; rerunnable fixture/scripts: `/tmp/gcc-vs-tsickle`.

| Pipeline | raw | gzip | brotli |
|---|---:|---:|---:|
| **ours (defaults)** | **1,748** | **820** | **734** |
| tsickle, best posture (checkTypes on, no blanket suppress) | 1,756 | 825 | 740 |
| tsickle + our sliced platform externs (`--env CUSTOM`) | 1,756 | 823 | 738 |
| floor: same modules, every type erased to `{?}` | 1,776 | 831 | 745 |
| tsickle, its own shipped posture (blanket `@suppress {checkTypes}`) | 1,819 | 840 | 754 |
| *ceiling probe: no externs at all (not shippable)* | *1,581* | *749* | *674* |

All five shippable variants produce identical observable output (node and
browser), including the same `SETTINGS["retries"]` miscompile that `tsc` gets
right — string-keyed access breaks under ADVANCED on **both** sides, so
boundary D's `goog.reflect.objectProperty` is a correctness fix neither tool
has today.

**Findings.** (1) We are already 8 raw / 5 gzip *smaller* than tsickle at its
best, with identical renaming at all five hand-picked sites. (2) The expected
headline gap does not exist: tsickle's typed DCE removed the three dead typed
fields, and so did we — and so did the untyped floor. (3) Our real fidelity
gap is 5 `{?}` atoms vs tsickle's 0, every one a **cross-module type reference**
or an enum flattened to its primitive. (4) That entire fidelity difference is
worth **20 raw / 6 gzip (0.7%)** — the floor→best delta with *perfect*
annotations. (5) The prize is elsewhere: **76 gzip (9.2%)** of this fixture is
pinned by extern names (`label`, `weight`, `tag`, `name`, `width`, `height`,
`total`, `timeout`, `channel`, `value`) that the program never shares with the
environment, and our minimal slice recovers 2 of those 76 bytes (it buys build
time instead: Closure 1,313 ms → 308 ms).

**Targets.** W2-2: `{?}` atoms 5 → 0 (cross-module declared types + `@enum`
positions) — fund as correctness, not size. W2-3: expected size effect ≤ 6 gzip;
its value is being the prerequisite for owner-typed barriers. W2-4 carries the
9.2%: a record-colour barrier must free those ten names on anonymous object
literals, which is precisely where disambiguation gives up today. Do not fund
dead-typed-field DCE — it already works, without annotations.
