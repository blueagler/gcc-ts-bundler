# Does ADVANCED property renaming pay on the wire?

Research spike. No source changed by this document. Measured on a real
production app, not a generator: an Ant Design Pro admin (antd 6 +
`@ant-design/pro-components` + `@tanstack/react-start`), 2,352 modules,
7.2 MB of JS reaching the plugin. Compiler is the pinned
`google-closure-compiler-java@20260811.0.0` (`--version` → `v20260811`).
`raw` = bytes of the emitted client chunks, `gzip` = `gzip -9`, both summed
over all 52 chunks of `dist/client/assets`.

This extends `typed-input.md`, which measured the same effect at 0.03% on a
svelte SPA and predicted "gzip may *regress*". It does, and this is the
mechanism and the number.

---

## TL;DR verdict

| Question | Answer |
|---|---|
| Does ADVANCED shrink raw bytes on a dependency-dominated app? | Yes, **−3.3%** |
| Does it shrink what ships over the wire? | **No, gzip +4.0%** |
| Do type-based passes contribute? | **0.08%.** Confirms `typed-input.md` at 30× scale |
| Is a missing CLI flag responsible? | No. All the relevant passes are already on |
| What would fix it? | Stop ADVANCED-renaming untyped vendor code — Google's own documented answer for this class of library |

The headline: **property renaming trades token repetition for token length,
and gzip charges more for the repetition than it refunds for the length.**

| variant | raw | gzip | ratio | distinct ≤2ch names | avg reuse |
|---|---|---|---|---|---|
| pure Vite | 2393.4 KB | **780.4 KB** | 3.07 | 349 | 16.0 |
| ADVANCED, types on | 2314.0 KB | 811.7 KB | 2.85 | **2333** | **7.6** |
| ADVANCED, types off | 2316.2 KB | 812.3 KB | 2.85 | 2333 | 7.5 |

Renaming minted ~2,000 additional one- and two-character property names at
*half* the reuse rate. Compression ratio fell 3.07 → 2.85. The 79 KB of raw
savings became a 31 KB gzip loss.

---

## 1. The flags that look missing are implicit

`--help` on the pinned jar lists none of `--disambiguate_properties`,
`--ambiguate_properties`, `--cross_chunk_code_motion`,
`--cross_chunk_method_motion`. Passing any of them is rejected outright:
`"--ambiguate_properties" is not a valid option`. They are not absent
features; they have no CLI surface.

- `CompilationLevel.applyFullCompilationOptions` sets
  `setCrossChunkCodeMotion(true)` and `setCrossChunkMethodMotion(true)`
  for ADVANCED.
- `CompilationLevel.setTypeBasedOptimizationOptions` sets
  `setDisambiguateProperties(true)`, `setAmbiguateProperties(true)`,
  `setInlineProperties(true)`, `setUseTypesForLocalOptimization(true)`.
- `CommandLineRunner` reaches the latter through
  `--use_types_for_optimization` — **singular**, `default: true`. The plural
  `--use_types_for_optimizations` never existed.

We never pass it, so we inherit the default `true`. **There is no flag fix
available here, and no flag was being missed.** This is an implicit contract
with the pinned compiler and is worth stating in the job builder.

## 2. AmbiguateProperties is the gzip pass

`RenameProperties` and `AmbiguateProperties` pull in opposite directions:

- `RenameProperties.generateNames` walks properties by frequency and assigns
  each its **own** next name via `nameGenerator.generateNextName()`, then
  reserves it so nothing else may take it. Minimal raw bytes, maximal
  alphabet.
- `AmbiguateProperties` deliberately does the reverse. Its class comment:
  *"Renames unrelated properties to the same name … This allows better
  compression as more properties can be given short names."* It colors a
  property graph and gives every property of one color the same name.

Controlled probe on the pinned jar — identical source, one difference:

| receivers | A's names | B's names | shared |
|---|---|---|---|
| `@constructor @struct` on both | `g,h,i` | `g,h,i` | **yes** |
| no annotations | `g,h,i` | `j,l,m` | no |

Closure's own source acknowledges the tension: `AliasStrings.java` notes that
turning that pass on "usually hurts code size after gzip", for exactly this
reason.

**Consequence: ambiguation is the only mechanism in the compiler that trades
raw bytes for compressibility. If it does not fire, renaming is a wire
regression on any codebase whose names were already repetitive.**

## 3. Why it does not fire here: the poison rule is structural

`typed-input.md` records the rule — one unknown `x.prop` pins `prop`
program-wide. The precise sites:

- `AmbiguateProperties.Property.addRelatedColor`: if
  `color.isInvalidating() || color.getPropertiesKeepOriginalName()`, it sets
  `skipAmbiguating = true` for that **property name, globally**.
- `DisambiguateProperties.invalidateBasedOnType`: an invalidating receiver
  invalidates *every* property associated with it.
- `InvalidatingTypes.isInvalidating` is true for `null`, unknown, empty, any
  union containing an invalidating member, the OBJECT/FUNCTION natives — and
  `isAmbiguousOrStructuralType`, whose fall-through is `return true`.

That last one is the decisive detail for this workload, and it is stronger
than "we lack annotations": **object literals are structurally typed, so they
are invalidating.** Upstream test
`testSimplePropInObjectLiteralPreventsPropertyRenaming` asserts
`const obj = {m: 0}; class C {m() {}}` compiles unchanged.

antd, `@ant-design/cssinjs` and pro-components are object-literal and
theme-token soup. Every `{className, style, children, type, …}` is an
invalidating structural type, and each key it mentions is then unambiguatable
**on nominal classes too**. The candidate set is empty before type coverage
is even considered.

This is why raising app-side type coverage cannot fix it, and the A/B proves
it: turning every type-based pass off changes gzip by **0.08%**.

## 4. What the numbers do and do not show

Measured with `--use_types_for_optimization=false` injected through
`GCC_CLOSURE_EXTRA_FLAGS`, everything else identical:

```
types OFF vs ON:  raw +0.10%   gzip +0.08%   (+0.6 KB of 812 KB)
```

Two readings retracted during this spike, recorded so they are not repeated:

- **Per-chunk deltas are unsound here.** `provider` appears to grow 107 KB
  raw, but chunk *composition* differs between the two builds — a marker
  token check (`antCls` 18→17, `motionDurationSlow` 10→9, `colorPrimaryBg`
  9→9) shows modules moved rather than duplicated. `CrossChunkCodeMotion`
  moves declarations to the deepest common ancestor of their references, so
  a shared vendor bucket is exactly where code accumulates. Only whole-app
  totals are comparable.
- **No downleveling is occurring.** `esnext` maps to `ECMASCRIPT_NEXT`
  (`closure_capabilities.rs:197`), and `class` / `async` / `await` / spread
  all survive. An early reading blamed private-field lowering; it was wrong.

The 1,233 `Object.prototype.X` rename barriers we generate cost **73.8 KB
raw** across 17,703 references (`current` ×1641, `value` ×658,
`children` ×301). Note the direction carefully: those names are long *and*
heavily repeated, which is gzip-friendly. Narrowing the barrier set is a raw
win whose gzip effect is **not** obviously positive, because every un-pinned
name becomes another unique short token unless ambiguation can color it.

## 5. What Google does with libraries like this

The FAQ entry *"I want to use Advanced Optimizations, but { jQuery, YUI,
Underscore, Prototype, JS Library Foo } does not work"* prescribes splitting
into three pieces: the library code, **an externs file that is the library's
API contract**, and the application code — and not running ADVANCED renaming
over the library. `rules_closure`'s ADVANCED warning is the same rule stated
from the other side: dot access gets renamed, quoted access is the escape
hatch.

Google's own JS is fully typed and nominal, which is what makes ADVANCED pay
for them. `closure_js_binary` emits **one** binary; `--chunk` does not appear
in the public Bazel rules at all. Accepting a bundler's 52-way vendor
partition and asking ADVANCED to pay on untyped vendor code is not a
configuration they run.

## 6. Recommendation

Ranked by evidence strength, not by appeal:

1. **Tier the compilation.** App code (typed TS, nominal classes) through
   ADVANCED; untyped vendor code minified without property renaming, with an
   externs contract at the boundary. This is the only intervention whose
   measured locus matches the regression, and it is the documented answer for
   this library class. It is an architectural change to the plugin's central
   premise and should be measured on this app before being generalized.
2. **Guard the wire number.** Gzip is already computed
   (`src/shared/lifecycle-size.ts`, `scripts/build-self.mjs`) and Vite prints
   it per chunk, and `README.md` tabulates plugin-versus-pure gzip for the
   examples. What is missing is a *gate*: nothing fails, or even warns, when
   the plugin makes the shipped bytes larger than no plugin at all. On this
   app it did, by 4.0%, and every automated check stayed green.
3. **Keep the renaming maps.** `--property_map_input_file` /
   `--variable_map_input_file` are for byte-stable names across deploys, so
   unchanged chunks stay cache-valid. `RenameVars.reusePreviouslyUsedVariableMap`
   pins prior assignments; that is repeat-visit value and is already wired
   correctly. It is not a cold-load lever and should not be sold as one.
4. **Do not pursue** TypedAST multistage or `--persistent_worker` for size;
   neither exists in this jar and neither addresses the wire number. Type
   coverage work (`typed-input.md` item 0, typed platform externs) remains
   correct for *correctness* and for `Off`/`Split` mode, but this spike shows
   it cannot recover the gzip regression on a vendor-dominated graph.

## 7. Measuring this in future

- Type coverage: `--jscomp_warning=reportUnknownTypes` emits
  `JSC_UNKNOWN_EXPR_TYPE`, and the compilation summary prints
  `TypeCheck.getTypedPercent()` as `N% typed`.
- Ambiguation success: a `--property_renaming_report` full of *original*
  long names is evidence those names were skipped. After a successful
  ambiguation the report shows post-color names (`g:g`).
- Wire size: always compare summed `gzip -9` over all emitted chunks, and
  never attribute a delta to a single named chunk without first checking that
  chunk composition matches.
