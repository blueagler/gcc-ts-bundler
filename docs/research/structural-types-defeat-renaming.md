# Why TypeScript types don't pay: `@record` cannot be ambiguated

Research spike. No source changed by this document. All probes run against the
pinned `google-closure-compiler-java@20260811.0.0` jar (`--version` →
`v20260811`) on throwaway inputs in `/tmp`, with the **exact option set the
plugin uses in production** for a job that delivered type metadata:

```
--compilation_level ADVANCED --warning_level QUIET
--jscomp_warning=checkTypes --hide_warnings_for=/
```

This answers a question the wire-size spike
(`advanced-renaming-vs-gzip.md`) raised but could not settle: that spike
measured `--use_types_for_optimization` on-vs-off at **0.08%** and concluded
type-based passes contribute nothing. It did not explain *why*, and "the app is
94% untyped vendor" is only half the reason. The other half is that the type
information this project delivers is the wrong **kind**.

---

## TL;DR verdict

`AmbiguateProperties` is the only pass that makes types pay in bytes: it gives
unrelated types the *same* short property name, which is what keeps output
compressible. Whether it fires depends on the JSDoc form of the receiver:

| receiver form | TypeScript source it comes from | ambiguates? |
|---|---|---|
| `@record` | `interface Config { … }` | **NO** |
| `@interface` + `@constructor @implements` | `class Foo implements Bar` | **YES** |
| `@constructor @struct` / ES `class` | `class Foo { … }` | **YES** |

**The plugin emits `@record` for TypeScript interfaces**
(`native/src/closure_metadata.rs:266`: `"/** @record */\nfunction Config() {}\n"`).
`@record` is Closure's *structural* type, and structural types are invalidating,
so every property named on a TS interface is excluded from ambiguation
program-wide.

Two consequences that matter more than the headline:

1. **This is not a configuration bug.** The production flag set is correct and
   ambiguation does fire under it. Verified below.
2. **The obvious fix is unsafe as a blanket change.** `@interface` is nominal:
   it *rejects* the object literals that a TypeScript interface legally accepts.
   Under our `--hide_warnings_for=/` that rejection is silent.

---

## 1. The production flag set is correct — verified, not assumed

Same input, two unrelated nominal classes with three properties each. Shared
short names across the two receivers means the pass fired.

| flags | receiver A | receiver B | ambiguated |
|---|---|---|---|
| `--warning_level QUIET` (bare) | `h,i,j` | `l,m,o` | **no** |
| `QUIET + checkTypes + hide_warnings_for=/` ← **production** | `g,h,i` | `g,h,i` | **yes** |
| `--warning_level DEFAULT` | `g,h,i` | `g,h,i` | yes |
| `--warning_level VERBOSE` | `g,h,i` | `g,h,i` | yes |
| production `+ --use_types_for_optimization=false` | `h,i,j` | `l,m,o` | **no** |

Bare `QUIET` does disable the pass — `AmbiguateProperties` is scheduled only
when `options.isTypecheckingEnabled()` — but the pipeline already restores it.
`shouldEnableTypeInference` (`src/build/closure/compiler.ts:103-111`) requires
ADVANCED plus delivered type metadata, and then
`TYPE_INFERENCE_OPTIONS = { hideWarningsFor: ["/"], jscompWarning: ["checkTypes"] }`
(`compiler.ts:114-117`) is merged in at `run-closure.ts:833-835`.

The last row is the control: turning the type-based passes off reproduces the
un-ambiguated names exactly. So the harness is measuring the right thing.

## 2. `@record` forfeits it; nominal forms keep it

Two unrelated types, three properties each, consumed through typed parameters,
loop-instantiated so nothing inlines away.

```
@record  (TS interface)   A -> g,h,i    B -> j,l,m    6 distinct names
ES class (TS class)       A -> g,h,i    B -> g,h,i    3 names, reused
```

The `@interface` + `@constructor @implements` form — the shape a TS
`class Foo implements Bar` should compile to — also ambiguates, and its
`--property_renaming_report` shows the post-color identity mapping `g:g h:h`
that the earlier spike identified as the signature of a *successful*
ambiguation.

Mechanism, unchanged from the earlier spike but now pinned to a concrete
emission choice:

- `InvalidatingTypes.isAmbiguousOrStructuralType` falls through to
  `return true` for structural types.
- `AmbiguateProperties.Property.addRelatedColor` then sets
  `skipAmbiguating = true` for that **property name globally**.

`@record` is a structural type by definition, so naming a property on one is
enough to remove that name from the candidate set for every owner in the
program — including nominal classes that would otherwise have been ambiguated.

## 3. Why `@record` is nevertheless the correct emission

TypeScript interfaces are structurally typed: any object literal with a
matching shape satisfies them. Closure's `@record` has exactly that semantics;
Closure's `@interface` does not.

```
object literal -> @record  param :  no diagnostic
object literal -> @interface param:  WARNING - [JSC_TYPE_MISMATCH]
                                     actual parameter 1 of readA does not match
                                     formal parameter
```

So `@record` is not a lazy choice, it is the faithful one. And switching
blindly would be worse than a visible break: production passes
`--hide_warnings_for=/`, which **suppresses that mismatch**. A blanket
`@record` → `@interface` rewrite would silently feed the optimizer a type
graph that contradicts the program, which is exactly the class of bug that
`no-widen-then-assert` and friends exist to prevent in our own source.

## 4. What would actually make types pay

Ranked by evidence, with the ceiling stated honestly.

1. **Classify interfaces at emission time.** Emit `@interface` (plus
   `@implements` on the implementing classes) only for interfaces where every
   satisfier in the program is a class the pipeline also annotates; keep
   `@record` for interfaces satisfied by object literals. This is decidable
   from the TypeScript checker — it is the same information `tsc` uses to
   resolve assignability — and it is the only intervention measured here that
   turns the pass on without lying about types.
2. **Emit nominal `@struct` for TS classes wherever possible.** ES classes
   already ambiguate, so the win here is limited to cases where the current
   pipeline downgrades a class to a structural form. Worth auditing
   `closure_metadata.rs` for those.
3. **Do not expect this to recover the 4% wire regression.** Two hard ceilings:
   - Poisoning is **per property name and program-wide**. A React/antd app
     shares its most common property names (`value`, `type`, `children`,
     `className`, `current`) with vendor object literals, so those names stay
     unambiguatable no matter how the app's own types are emitted.
   - 94.1% of this app's input is dependency code. The authored 418 KB is where
     nominal typing is achievable at all.
   The realistic framing is that this unlocks type-driven optimization for
   *authored, class-based* code — which is the project's actual thesis — not
   that it fixes a vendor-dominated React app's gzip number.
4. **Measure it on an app that fits the thesis.** The admin app is the worst
   case: structural, hook-based, vendor-dominated. A class-heavy, mostly-authored
   TypeScript codebase is where this change should be measured first, and
   `typed-input.md`'s scenario (ii) (standalone TS library / all-TS builds) is
   already flagged there as the gated-GO case for the same underlying reason.

## 5. How to check this in future

- Ambiguation fired? Emit `--property_renaming_report`. Original long names in
  the left column means the pass skipped them. Post-color identity rows
  (`g:g`) mean it ran. Two *unrelated* source properties mapping to the same
  short name is the positive proof.
- Always build a **positive control** into an ambiguation probe. Three separate
  probes here returned "not ambiguated" for reasons that had nothing to do with
  the hypothesis: `--warning_level QUIET` disabling the pass, and constructor
  inlining turning `new A(1)` into `new function(){…}` so the receiver lost its
  nominal identity. Without a form known to ambiguate in the same run, those
  are indistinguishable from a real negative.
- Loop-instantiate and escape through `window` to stop the optimizer from
  folding the probe into a constant before the pass under test runs.
