# Externs generator: what a rename barrier actually costs

Status: implemented (wave 1, Lane C). Follow-on work is listed at the end.

## The thing that was wrong

Every barrier mechanism in this repo was justified by what it *protects* and
never measured by what it *costs*. Three separate mechanisms accumulated, each
with a different implied contract, and only one of the three was counted:

| Mechanism | Where | Counted? |
| --- | --- | --- |
| `Object.prototype.X;` flat lines | `src/externs/render.ts` | yes |
| `T.prototype.X` / `{"X": …}` in typed declarations | `src/externs/typed-render.ts` | **no** |
| Native property quoting | `native/src/transpile/compat/properties.rs` | n/a (wave 2) |

They are the same thing to Closure. A property name that appears in *any*
externs source — flat line, owner-qualified declaration, or record-literal key
inside a JSDoc type — is removed from `RenameProperties`' candidate set **and**
from `DisambiguateProperties`' partition, for every owner type in the program.

Measured on an isolated typed probe (`ADVANCED` + `--jscomp_warning=checkTypes`,
which is what `shouldEnableTypeInference` turns on for typed jobs):

```
owner-typed extern (JQ.prototype.hasClass)   46 B   — Closure disambiguated,
                                                     inlined, deleted the class
flat extern (Object.prototype.hasClass)     105 B   — the local object survives
```

**+128%** for the same program, from one line of externs. Under
`--jscomp_off=*` the two are byte-identical, which is why the cost never showed
up: the barrier design predates the type inference that makes it expensive.

## What changed

### 1. Barriers are counted, all three shapes (`src/externs/barriers.ts`)

One module now owns the definition of "a property name this artifact pins",
covering flat lines, owner-qualified prototype members, and record keys.
`GenerateExternsResult.renameBarriers.propertyNames` is the union across both
generated artifacts; `typedDeclarations.propertyNames` is the typed artifact's
share. Explicit extern files handed to `build({ externs })` get the same audit —
they never passed through `generateExterns`, so a checked-in 761-line
`Object.prototype.*` file was previously invisible to every accounting path.

Above 200 barriers the generator emits a non-fatal warning naming the top
contributing declaration packages, because "2,964 barriers" is noise and
"2,964 barriers, mostly from `@tanstack/router-core`" is a decision.

Note for anyone touching the collector: **block comments must not be stripped.**
In an externs file the JSDoc block *is* the type annotation, so
`/** @type {{"x": …}} */` is where record-key barriers live.

### 2. The typed renderer no longer crashes (`src/externs/typed-render.ts`)

`renderFunctionType` called `renderType` with a fresh `seen` set, so every
function-typed hop reset `MAX_DEPTH` to zero. React's `ReactNode` /
`Dispatch<SetStateAction<S>>` chains cycle through signatures, so the guard
never fired:

```
generateExterns({ modules: [{ specifier: "react", runtime: "external" }] })
  → RangeError: Maximum call stack size exceeded
```

`seen` is now threaded through function types like any other recursion edge.
React + `@tanstack/react-router` renders in ~660 ms and degrades cycles to `?`,
which is the sound outcome. `test/externs-typed.test.mjs` runs it against the
real example, because no synthetic fixture reproduced this.

### 3. Concatenated keys are evidence (`src/externs/runtime-analysis.ts`)

The runtime analyzer knew about template-literal keys (`` node[`$evt${type}`] ``,
added for Vue Vapor) but not about `+`-concatenated ones. jQuery defines its
entire Deferred API through the latter:

```js
deferred[ tuple[ 0 ] + "With" ] = list.fireWith;   // jquery.js:3705 — invisible key
readyList.resolveWith( document, [ jQuery ] );     // jquery.js:3844 — dot read, renames
```

Only the dot side renames, so the page died with `TypeError: Fb.ga is not a
function` on first paint. `constructedKeyFragments` now records the literal
prefix/suffix of a key assembled with `+` **in element-access position** —
position is required here, unlike the template rule, because a bare `"a" + b`
anywhere in a file is a message, not a key. Fragments shorter than three
characters are dropped; a one-character anchor matches a large share of any
program's member names.

Result on jQuery: **31 proven barriers** replace **761 speculative** ones.

### 4. The jQuery example demonstrates the right posture

`examples/jquery-demo` was the only consumer of `candidates` mode, on
the stated grounds that "jQuery constructs its API reflectively, so every typed
member must survive renaming". That was true of the hazard and false of the
remedy: the reflective construction is exactly what `constructedKeyFragments`
now sees, and the other 730 names were never at risk.

The example is now `boundary-aware` (5 names) + `runtime-aware` (31 names).
Measured: **−4,442 raw / −748 gzip (−2.4%)**, and 102 → 244 properties
returned to the renamer. Browser-verified with agent-browser on a `/tmp` build: initial
render, toggle, re-toggle, reset, zero page errors, zero console errors.

### 5. `candidates` mode is deleted

The mode pinned every member of every reachable declaration with no usage input
at all. It was not an analysis; it was a decision to stop optimising the named
packages. Measured against an evidence-derived set:

| Example | barriers | raw | gzip |
| --- | --- | --- | --- |
| React SPA | 3 vs 2,964 | +16,599 | **+3,480** |
| Vue Vapor SPA | 13 vs 3,231 | +5,514 | **+1,157** |
| jQuery demo | 31 vs 761 | +4,442 | **+748** |

Its last consumer was the jQuery example, whose need for it was a symptom of
the analyzer gap closed in (3). With that gap closed the example passes browser
checks on 31 proven barriers, so the mode was deleted outright rather than kept
as a configurable escape hatch — an escape hatch is what removes the pressure
to fix the evidence classes.

Worth recording for whoever is tempted to reintroduce it: `includeDependencies`
was where essentially the whole explosion lived. Turning it off took Vue Vapor
from 3,231 barriers to **0** and React from 2,964 to 974 — a "safety" default
that was mostly transitively-reached packages the application never touched.

### 6. Platform-extern slicing pays for itself now

The parsed extern index (~13k declaration units from ~123 archive entries) cost
**~830 ms of TypeScript parsing per process**, memoized only in a module-level
`Map` that dies with the process — so every build paid it in full, including
builds whose Closure job was a cache hit and never ran. The parse is a pure
function of `compiler.jar`, so it is now persisted to the shared user cache
keyed by `jarHash`, written atomically (unique temp + rename), with every
failure degrading to a reparse.

```
cold  (parse + write)   902 ms
warm  (read + regroup)   53 ms      −94%
```

Index equivalence verified against a full reparse across `globalNames`,
`propertyNames`, `languageNames`, `unitsByName` and `browserUnits`.

End-to-end on the React example, 5 paired runs: minimal is now at time parity
with full browser externs (median 7,667 ms vs 7,676 ms) and saves 52 gzip
bytes. Before this change it was ~0.8 s *slower* for 46 gzip bytes — a net
loss that shipped as a default.

### 7. The full-externs retry is narrowed

The `--env CUSTOM` job retried with the full browser externs on **any** non-zero
exit. A genuine type error, a syntax error or an OOM therefore cost two full
Closure runs and printed its diagnostics twice. The retry now fires only on
diagnostics that actually mean "the slice was incomplete"
(`JSC_UNDEFINED_VARIABLE`, `JSC_INEXISTENT_PROPERTY`, `JSC_TYPE_PARSE_ERROR`, …
see `isMissingPlatformExternFailure`). `runClosureCompiler` gained an optional
`onStderr` observer for this; reporting behaviour is unchanged.

### 8. One name predicate (`src/externs/shared.ts`)

`isExternPropertyName` and `isRuntimeExternPropertyName` had silently divergent
bodies and no comment. They are one function with an explicit
`ExternNameSource` now, and the divergence is documented because it is real:
`_`/`$`-leading members are private-by-convention noise in a `.d.ts` and are
load-bearing protocol names in emitted runtime code (dropping them from runtime
evidence is what froze Vue's reactivity). Host-object members go the other way.
Vue's generated barrier set is regression-locked byte-identical.

## What is still wrong

The model is still **name-keyed with no owner**. Verified false-negative classes
that remain: JSON round-trips (`dotDefined ∩ dotAccessed` is declared safe, but
the wire format is a third party), destructuring reads (`ObjectBindingPattern`
is not visited), `Reflect.get`, attribute reflection. Verified false positives:
hot generic names (`value`/`key`/`data`) colliding across unrelated objects,
and the unconditional camelize alias.

The fixes, in order of value:

1. **Owner-typed externs on typed jobs** — `T.prototype.P` instead of
   `Object.prototype.P` whenever the owner is known. Measured −56% on the
   isolated probe; requires reliable owner symbols, so it wants (3) first.
2. **`goog.reflect.objectProperty` rewrites** for constructed and reflective
   keys. `closure-lib/reflect.js` already ships and pins nothing — the property
   still renames and the read resolves to the renamed name at compile time.
   This retires `constructedKeyPrefixes`, `constructedKeyFragments`,
   `protocolHelpers` together (`candidates` is already gone).
3. **Checker-backed `(owner, property)` evidence** — the runtime path reparses
   with a bare `ts.createSourceFile` and has no types at all, while the
   boundary-aware path already has a `Program` in the same process.
4. **Serialization-boundary channel** — a `property.map`-derived projection for
   types that cross `JSON`/`postMessage`/storage, instead of pinning them.
