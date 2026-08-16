# Prior art: framework + Closure ADVANCED integrations

Survey of 11 repos by `thelgevold` (Torgeir Helgevold), plus the measurements
they prompted on our own trial app. Read at the request of the maintainer.
No source changed by this document.

Verdict up front: **the repos are POCs and hello-worlds, and none of them
attempts the thing we are stuck on.** Their value is corroboration, not
technique: three independent 2017–2020 data points confirm mechanisms we
derived from source this week, and one comment from the Angular thread named
our exact problem nine years early. The measurements in §4 are new and are
ours.

| repo | what it is | last commit | compiler | signal |
|---|---|---|---|---|
| `closure-compiler-angular-bundling-old` | Angular ViewEngine AOT + ADVANCED, real components | 2017-02-04 | `20170124` | **medium** |
| `svelte-closure-sample` | Svelte 3 + rxjs POC, published sizes | 2020-12-09 | `20200719` | **medium** |
| `svelte-comments` | Svelte 1 comments widget, quoted JSON keys | 2017-01-07 | `20161024` (JS port) | low-medium |
| `rules_svelte` | Bazel rules, Svelte→ADVANCED, classic `--chunk` lazy load | 2020-12-11 | `20201102` | low |
| `angular-closure-compatibility` | moment.js + one-line extern | 2017-05-02 | `20170409` | low |
| `closure-bazel-samples` | 3-file `closure_js_library`/`_binary` | 2020-03-03 | `v20190909` | none |
| `svelte-snowpack-closure` | one counter component, dead Snowpack hook | 2020-10-25 | `20201006` | none |
| `closure-lazy-loading`, `tree-shaking`, `closure-demo`, `closure-samples` | assorted samples | 2017–2020 | various | low |

Everything here predates Svelte 5, Ivy, `--chunk_output_type ES_MODULES`, and
esbuild. Dead flags they used: `--language_in=ES6_STRICT`,
`--dependency_mode=STRICT`, `--module`. We already use the replacements.

---

## 1. The strongest corroboration: externs pin names everywhere

From `angular/angular#8550`, 2017-02-06, alexeagle:

> "the externs approach marks that property name as un-renamable everywhere."

That is our 1233 `Object.prototype.X` pins, stated as a known hazard nine years
ago. The Angular repo shows the consequence concretely: `vendor/zone_externs.js`
declares `Zone.current` and `Zone.prototype.name`, and in the checked-in
ADVANCED bundle `ListItem.val` renames to `ff` while `current`, `name` and
`checked` survive **on the application's own classes** because they collide with
Zone/DOM externs.

Our own measured top pinned names are `current` (1641 references), `value`
(658), `children` (301). Same failure, same names, different decade.

Their fix was **not** more externs. It was quoted access at the dynamic site:
`{'firstName': …, 'lastName': …, 'age': …}` plus string column keys, scoped to
the one object that needed it (`grid-demo.ts:29-37`). Owner-scoped externs where
unavoidable (`var commentCtx; commentCtx.url;` in `svelte-comments`), never
`Object.prototype`.

**Actionable for us:** prefer quoted access or a per-owner extern over adding a
program-wide pin. Every pin is a rename *and* ambiguation kill switch for that
name on every owner type.

## 2. TypeScript interfaces did not produce useful Closure types — in 2017 either

`closure-compiler-angular-bundling-old/src/components/grid/person.ts` declares
`export declare interface Person { firstName: string; … }`, and thelgevold
reported in #8550 (2017-02-05):

> "the interface with `declare` didn't seem leave cues for the Closure compiler
> that would prevent mangling. As a workaround I have been square bracket
> protecting the property names."

He was chasing the opposite goal from ours — he wanted names *pinned*, we want
them *reused* — but the underlying fact is the same one we proved from source
this week: a TypeScript interface does not give Closure a type its property
optimizer can act on. Independent, nine-year-old corroboration of
`structural-types-defeat-renaming.md`.

Worth noting how thoroughly the Angular pipeline was *not* a typed-input story:
`annotateForClosureCompiler` ran tsickle's CLOSURIZE pass, but Angular 4's
`tsc-wrapped` hardcoded `untyped: true`
(`tools/@angular/tsc-wrapped/src/main.ts:92-97`), and tsickle's `typeToClosure`
returns `'?'` immediately when that is set. Neither repo ever passed
`--use_types_for_optimization`. So Angular+Closure folklore is **not** evidence
that types pay on class-heavy code. Nobody in this corpus ran that experiment.

## 3. The published sizes show our exact raw→gzip erosion

`svelte-closure-sample`, measured against rollup+terser (blog, 2020-08-30):

| | rollup+terser | Closure ADVANCED | delta |
|---|---|---|---|
| raw | 44.6 KB | 33.4 KB | **−25%** |
| gzip | 13.6 KB | 12.0 KB | **−11.7%** |

The gzip win is less than half the raw win. That is the same erosion we measured
(raw −3.3%, gzip +4.0%); their app is small and framework-dominated so it stays
positive, ours is 2.4 MB with 4,000+ property names so it crosses zero. A 11.7%
gzip win on a 12 KB app is fully compatible with a 4.0% gzip loss on an 800 KB
app.

No one in this corpus compared against esbuild, and no one had a
dependency-dominated app — `rules_svelte` lists its "deps" (rxjs, svelte
internals) by hand, file by file.

## 4. Measurements this prompted (new, on our trial app)

The survey pointed at our generated externs, so we priced them. Ant Design Pro
admin, same graph, ADVANCED throughout:

| variant | pins | raw | gzip | ratio | ≤2ch | reuse |
|---|---|---|---|---|---|---|
| pure Vite | — | 2393.4 KB | 780.4 KB | 3.07 | 349 | 16.0 |
| plugin, default | 1233 | 2314.0 KB | 811.7 KB | 2.85 | 2333 | 7.6 |
| plugin, `includeDependencies: false` | 1233 | 2314.0 KB | 811.7 KB | 2.85 | 2333 | 7.6 |
| plugin, `externs.generate.modules: []` | 1233 | 2314.0 KB | 811.7 KB | 2.85 | 2333 | 7.6 |
| plugin, no React preset (**broken app**) | 0 | 2238.2 KB | 800.9 KB | 2.79 | 2419 | 7.9 |

Four results, three of them negative:

1. **The pins cost 10.7 KB gzip / 75.8 KB raw.** The raw figure independently
   matches a static estimate of 73.8 KB across 17,703 references computed from
   the externs file, so both methods agree.
2. **`includeDependencies: false` is a no-op, and so is `modules: []`.** All
   three configurations emit byte-identical output and exactly 1233 pins, each
   in its own work directory, so the option signature did change and separate
   jobs ran. The pins do not come from the module list or from declaration-
   dependency expansion. They come from the React host-element hazard analysis
   (`compat.classMapCalls` in `reactPreset`), because React compares host prop
   keys as runtime strings. The warning text at
   `src/externs/barriers.ts:194` recommends `includeDependencies: false` and
   narrowing `modules`; **on this app neither does anything**, which makes that
   advice misleading and worth fixing.
3. **Removing every pin does not enable ambiguation.** Reuse moves 7.6 → 7.9 and
   distinct short names go *up* (2333 → 2419). So pins and structural types are
   two independent blockers, and clearing one does not unblock the other.
4. **Even with zero pins the plugin still loses to esbuild** by 20.5 KB gzip
   (+2.63%). So the pins are 10.7 KB of the 31.3 KB regression, and ~20 KB is
   the rest of the pipeline.

Also measured directly on the real build, from the persisted renaming maps in
`~/.cache/gcc-ts-bundler/<project>/renaming-maps/*/property.map`:

```
3963 property entries -> 3963 distinct short names, 0 shared
4452 property entries -> 4452 distinct short names, 0 shared
```

**Zero of ~8,400 properties are ambiguated on the real app.** Every property
gets its own unique short name. That is the production confirmation of the toy
probes, and it means the full property space is headroom.

[INFERENCE] If ambiguation recovered esbuild-like name diversity while keeping
ADVANCED's raw win, the same 2314 KB raw at ratio 3.07 would be ~754 KB gzip —
about 57 KB below today and 3.3% *under* pure Vite. Ratio is not purely a
function of name diversity, so treat that as an order-of-magnitude prize, not a
forecast. The measured facts are the 0-of-8400 count and the 2.85-vs-3.07 gap.

## 5. One technique worth keeping in mind

`svelte-closure-sample` compiles the **Svelte runtime into the Closure graph**
(`closure.conf` feeds `node_modules/svelte/{index,internal,store}.mjs` as `--js`)
and its `externs.js` is a single `/** @externs */` line. Nothing is pinned, so
ADVANCED renames `greetingMsg` consistently across the service and the compiled
view because both sides are in one compilation.

Our `sveltePreset()` does the opposite: runtime-aware externs over the whole
`svelte` package plus `protocolHelpers` for `prop` / `rest_props` /
`legacy_rest_props`. Those helpers are **not** optional — the 2017
`svelte-comments` blog warned about exactly this hazard (`component.get('firstName')`
breaking under renaming), and Svelte 5's `prop(props, "name")` is the same
string-key lookup. But the *breadth* of the extern set is worth an experiment on
a Svelte example: pin only the protocol helpers, compile the rest of the runtime
in.

## 6. What this corpus does not answer

- Whether `AmbiguateProperties` pays on a nominal, class-heavy app. Nobody
  measured types on-vs-off, and Angular's tsickle emit was deliberately untyped.
- Whether emitting `@interface` instead of `@record` is safe. Nobody emitted
  either from user TypeScript.
- Anything about `--chunk_output_type ES_MODULES`. `rules_svelte` uses classic
  `name:fileCount[:dep]` chunks with `window['route1']` quoted globals and an
  HTML `import()` loader; `closure-lazy-loading` is the same shape.
- Any comparison against a modern minifier, or any dependency-dominated app.
- Where the remaining ~20 KB of our pipeline overhead lives.
