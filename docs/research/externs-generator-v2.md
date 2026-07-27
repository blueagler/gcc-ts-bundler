# Smarter runtime-aware externs: evidence classes instead of def∩access

Coordinator research. Follows the typed-input Addendum 2 finding that the
runtime-aware generator neutralizes typed optimization by externing app
domain properties.

## Why the current rule over-preserves

`analyzeRuntimeUsage` collects `definedMembers` from **plain `this.x = v`
dot assignments** and externs every member that is both defined and accessed
(`src/externs/render.ts`). But in a single Closure invocation, a dot-defined
and dot-accessed member renames *consistently* — no extern is needed. An
extern (plus the native quoting it drives) is only required when the two
sides of a member cannot rename together:

- **string-keyed definition + dot access**: `__publicField(this, "x")` /
  `Object.defineProperty(o, "x", ...)` / `this["x"] = v` written by esbuild
  class-field lowering, read as `o.x`. Closure renames the reads, the string
  stays — breakage.
- **dot definition + string-keyed read**: `this.x = v` read as `o["x"]`.
- **protocol members** (framework helpers, configured by presets) — already
  handled.

## Measured on real graphs

Classifier over the materialized module graphs (script in this commit's
history):

| graph | mixed hazards (true) | dot∩dot pairs (currently externed, safe) |
|---|---|---|
| typed-app fixture, **pre**-prebundle | 0 | 41 |
| typed-app fixture, **post**-prebundle | **9** | 23 |
| svelte-vite-spa, pre-prebundle | 0 | 19 |
| svelte-vite-spa, post-prebundle | **10** | 0 |

Two conclusions:

1. The 23 safe pairs on the typed fixture are exactly the app domain fields
   (`balanceMinor`, `label`, `weight`, …) whose extern-preservation nulled
   the typed-annotation wins. Dropping them is the point of this change.
2. **The true hazards only exist post-prebundle** — esbuild's es2021
   lowering creates the `__publicField(this, "name")` forms. The current
   pipeline scans the pre-prebundle graph and still covers them, but *only
   because the over-broad rule happens to include the same names via their
   dot-definitions*. Narrowing the rule therefore REQUIRES moving the
   dependency-hazard scan to the post-prebundle graph (the code Closure
   actually compiles). The app-usage scan can stay on the pre-prebundle
   side and keep its parallelism.

## v2 rule

```
extern = protocolMembers
       ∪ (stringDefined ∩ dotAccessed)
       ∪ (dotDefined  ∩ stringLiteralRead)
```

with `stringDefined` = `__publicField`/`defineProperty`/`o["x"] =` /
quoted class fields, and `stringLiteralRead` = literal `o["x"]` reads and
literal `"x" in o` checks. Enumeration (`Object.keys`, `for..in`) is
rename-consistent and needs nothing; literal string *comparisons* against
keys are out of scope v1 (noted).

Known trade, accepted and documented: multi-entry `off`-mode builds that
exchange objects across separately-compiled entry bundles lose the
accidental protection the broad rule gave them; single-job (bundler-runtime)
builds — the default — are strictly better off.
