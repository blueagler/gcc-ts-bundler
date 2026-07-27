# ES_MODULES chunk output — research + spike

Status: **research spike, GO with gating.** No repo source was changed for this
document; all experiments live in `/tmp/spike`.

Scope: replacing Closure's `--chunk_output_type GLOBAL_NAMESPACE` (+
`--rename_prefix_namespace $gcc` + our script-injecting chunk loader) with
`--chunk_output_type ES_MODULES` (native `import`/`export` chunk boundaries,
native `import()` chunk loading) for `chunks.mode = "bundler-runtime"`.

---

## 1. Result summary

| | GLOBAL_NAMESPACE (shipped) | ES_MODULES (spike) | Δ |
|---|---|---|---|
| entry chunk raw / gzip | 58,127 / 21,172 | 54,356 / 20,368 | −6.5% / −3.8% |
| all JS raw / gzip | 73,946 / 28,165 | 68,311 / 27,246 | **−7.6% / −3.3%** |
| requests, cold page load | 4 (html, css, entry, +2 lazy) | 4 (identical) | 0 |
| requests, lazy panel | 2 (js + css, parallel) | 2 (js + css, parallel) | 0 |
| waterfall rounds, lazy panel @200ms RTT | 1 (204 ms) | 1 (204 ms) | 0 |
| browser verification | reference | 5/5 panels, dialog confirm, checkbox toggles, 0 console errors | pass |

Measured on `examples/svelte-vite-spa`, identical linked inputs
(`/tmp/esm-in`), identical externs, `ADVANCED`, `language_out ECMASCRIPT_NEXT`,
identical post-compile `rewriteDecoratorMetadata` pass. Reproduce with
`/tmp/spike/compile.sh <in> <out> ES_MODULES` and `compile-gn.sh`.

Compiler-only comparison (before our postprocess, same inputs, same flags):

```
GLOBAL_NAMESPACE  main 56,962 / 21,016   total 72,133 / 27,673
ES_MODULES        main 54,224 / 20,573   total 68,179 / 27,455
```

Two things to notice:

* The raw win is real and mostly comes from deleting the `$gcc.` prefix on
  every cross-chunk reference and from dropping the per-chunk IIFE wrapper
  (`src/build/closure/postprocess/runtime.ts:57`).
* **The gzip win is much smaller than the raw win** (−3.3% vs −7.6%), and for
  individual small lazy chunks ES_MODULES is sometimes *worse* gzipped
  (`btn.js` 569 vs 539, `menu.js` 964 vs 924): a long `import{a,b,c,...}from`
  list of unique minified identifiers compresses worse than repeated `$gcc.x`.
  Do not sell this migration as a bandwidth win — it is ~1 KB gzip on this app.
  The real wins are architectural (see §6).

---

## 2. Why Google itself ships script-mode bootstraps

`GLOBAL_NAMESPACE` is the Closure default (`CommandLineRunner.java`,
`chunkOutputType = ChunkOutputType.GLOBAL_NAMESPACE`) and it is what Google's
own serving stack uses. The reasons that survive scrutiny:

1. **Mutable cross-chunk state.** ESM import bindings are immutable in the
   importing module. Closure enforces this and it is a *hard compile error*,
   not a warning. Verified first-hand (`/tmp/spike/assign`):

   ```
   base.js: let counter = 0; export function bump(v){ counter = v; }
   other.js: import {bump} from './base.js'; bump(42);

   ES_MODULES       ERROR - [JSC_IMPORT_ASSIGN] Imported symbol "a" in chunk
                    "other.js" cannot be assigned (defined in "base.js")
   GLOBAL_NAMESPACE $g.a=0; ... $g.a=42;      (compiles, works)
   ```

   Worse, `ADVANCED`'s `CrossChunkCodeMotion` can *create* this situation from
   input that had no cross-chunk assignment at all — open upstream bug
   [google/closure-compiler#4264](https://github.com/google/closure-compiler/issues/4264)
   (filed 2025-09, still open, assigned to Chad Killingsworth). A shared
   mutable singleton in the eager chunk written by a lazy route is an ordinary
   app pattern; under ES_MODULES it becomes a build failure whose message
   points at the *definition* site, not at the offending lazy chunk.

2. **Loader control.** A script-mode bootstrap owns its own manifest, so it
   fetches a chunk *and all its transitive dependencies in parallel* from one
   round trip, and can co-schedule CSS with JS. Native ESM discovers a chunk's
   static imports only after fetching and parsing it — one extra RTT per graph
   level unless every edge is covered by `modulepreload`. Google serves deep
   chunk graphs where that is a decisive difference.
3. **No `document.currentScript`.** Module scripts have `currentScript === null`;
   the public-path/base-URL derivation must switch to `import.meta.url`.
   That interacts badly with Closure (§4.6).
4. **Execution timing / strictness.** Module scripts are always deferred and
   always strict; `document.write` is unavailable; `this` at top level is
   `undefined` not `window`. A large legacy corpus does not survive that.
5. **Double instantiation.** A module fetched under two different URLs
   (different query string, different case, `/assets/x.js` vs
   `./assets/x.js` from a different base, http vs https, crossorigin vs not)
   instantiates twice, and each copy gets its own module-level state. The
   script loader has an explicit dedupe map; ESM's dedupe key is the resolved
   URL, so any URL-shape inconsistency silently duplicates state.
6. **CSP / crossorigin.** `<script type="module">` is always fetched in CORS
   mode; a CDN that does not send `Access-Control-Allow-Origin` breaks. Nonce
   propagation to dynamically `import()`ed chunks is automatic (unlike injected
   `<script>` tags, which our loader must nonce itself), so this one is a wash.
7. **Memory / module records.** Each chunk becomes a permanent module record in
   the realm; module namespaces are never collectable. Marginal at our chunk
   counts.
8. **Top-level await.** Legal in ESM output and it silently changes chunk
   execution ordering. Our runtime resolves a chunk as "loaded" when the chunk
   body calls `__runtime.l(id)`, which under TLA would run *before* the rest of
   the module finishes. We must keep TLA out of chunk bodies or move the
   readiness signal to the `import()` promise.

### Closure-side constraints, verified against the compiler

From `CommandLineRunner.java` (ES_MODULES branch) and confirmed by running the
compiler:

* `--rename_prefix_namespace` is **rejected**: `"Expected
  --rename_prefix_namespace not to be specified when --chunk_output_type is set
  to ES_MODULES."` Our entire `$gcc` mechanism goes away — that is not optional.
* `--emit_use_strict` is **rejected** (modules are strict already).
* `--isolation_mode IIFE` is silently ignored for chunk output (verified:
  chunks are emitted unwrapped, as they must be — `import` is top-level-only).
  Our `wrapBundlerRuntimeOutputFile()` wrapper must not run in ESM mode.
* ES_MODULES implicitly enables `setWrappedOutputOptimizations` +
  `setAssumeGlobalScopeIsIsolated(true)`, i.e. `--assume_function_wrapper` is
  already implied; passing it too is harmless.
* Under `ADVANCED`, ES_MODULES forces
  `ExtractPrototypeMemberDeclarationsMode.USE_CHUNK_TEMP`.
* `TranspilationPasses.java` preserves `MODULES`, `IMPORT_META` and
  `DYNAMIC_IMPORT` features **only** when chunk output is ES_MODULES; otherwise
  they are marked removed. Consequence: with `--language_out ECMASCRIPT5` the
  compiler happily emits ES5-shaped bodies *and still emits `import`/`export`*
  (verified). Closure will not save us from an ES5 target — **gating is ours**.
* Entry-chunk `export` preservation for library-style output is a known gap
  ([#4084](https://github.com/google/closure-compiler/issues/4084)); irrelevant
  for app builds, relevant if we ever emit a library.

---

## 3. Why our inputs needed per-chunk-unique runtime aliases

`native/src/closure_jobs/runtime.rs:render_runtime_alias_line()` emits the
*same* line at the top of every chunk:

```js
var __runtime=globalThis["__g"],__register=__runtime.r,__require=__runtime.q, ...
```

All linked chunk inputs are *scripts* (no import/export), so they share one
global scope; under GLOBAL_NAMESPACE the duplicate declarations collapse
harmlessly. Under ES_MODULES the compiler must assign each surviving global to
exactly one output module and import it into the others — and the duplicate
`var` in a non-base chunk becomes an assignment to an imported binding.
Reproduced exactly (`/tmp/spike/in-dup`, aliases in `btn` renamed to match
`main`):

```
btn...linked.js:1:4: ERROR - [JSC_IMPORT_ASSIGN] Imported symbol "aa" in chunk
"btn.js" cannot be assigned (defined in "main.js")
```

So the emitter must suffix the alias names per chunk (`__runtime_3`,
`__register_3`, …), which is exactly what the probe input in `/tmp/esm-in`
does. Same diagnostic class as §2.1 — worth internalising: **under ES_MODULES,
any top-level write in chunk B to a name owned by chunk A is a build error.**

---

## 4. Concrete integration problems in this repo

### 4.1 Hashed chunk names vs import specifiers (the hash cycle)

Today: chunk file names appear in exactly one place — the manifest array inside
the base chunk. `src/vite/naming.ts` therefore hashes every non-base chunk,
then calls `patchRuntimeChunkUrls()` to rewrite the base chunk's manifest, then
hashes the base chunk last (`finalizeBaseJsOutputName`). One-directional, no
cycle.

Under ES_MODULES the name of `main.js` is embedded in *every* lazy chunk
(`import{...}from"./main.js"`) while the names of the lazy chunks are embedded
in `main.js` (the manifest, or the `import()` specifiers). That is a genuine
cycle: hashing either side invalidates the other.

Rollup's solution (`renderChunks` + `FILE_PLACEHOLDER`): emit fixed-width
placeholder tokens (`!~{001}~`) in place of every chunk's own hash, compute
each chunk's hash over the *placeholder-containing* content plus the hashes of
its dependencies in topological order, then substitute. Because the hashed
content contains placeholders rather than resolved names, cycles are fine — the
hash is stable and content-sensitive, it just is not `sha(final bytes)`.

We need the same. `ensureUniqueJsFileName()`/`renderPatternFileName()` in
`src/vite/naming.ts` currently hash the final bytes (`hashText(sourceText)`);
that must become placeholder-based, and `applyFileRenames()` must be preceded
by an import-specifier rewrite across *all* chunks, not just the base.

Cheaper interim option for stage 1: keep the manifest and keep specifiers out
of sibling chunks by importing only from the base chunk (already true for our
topology: every lazy chunk imports `main.js` and `shared.js` only), and accept
one non-content hash on the base chunk (hash it before manifest patching).

### 4.2 CSS coupled to chunks

`src/vite/css.ts` injects a snippet that pushes CSS file lists into the runtime
manifest (`css.ts:304`, `(function(r){...})(globalThis.__g)`), and the loader
(`native/src/closure_jobs/runtime.rs`, functions `y`/`z`) inserts
`<link rel=stylesheet>` and waits for `onload` **in parallel with** the chunk
fetch, so a panel never paints unstyled. Native `import()` has no CSS concept.

The spike keeps this exactly as-is and it works: see the measured lazy-panel
waterfall (CSS and JS start in the same millisecond, one 200 ms round). CSS
import attributes (`import x from './x.css' with {type:'css'}`) are not an
option — Chromium-only, and they produce constructable stylesheets, not
`<link>`s.

**Conclusion: the manifest and the CSS half of the loader must survive ESM
output.** Only the *script injection* half is replaced.

### 4.3 What actually gets deleted from the loader

Replaced: `p(a)` (script element injection) and `u(a)` (URL resolution) become
`import(specifier)`. That is the whole diff — 2 functions, ~4 lines. Spike
patch: `/tmp/spike/patch-in.mjs`.

Retained (all still needed): the chunk-state table (`r.s`/`r.d`), the
dependency-parallel fetch (`(b[0]||[]).map(e)` — this is what preserves our
1-RTT waterfall), CSS loading (`y`/`z`), the module registry `r.f`/`r.c`/`r.q`
and the getter installer `r.g`.

A later stage could delete the registry too and let `import()` return the real
module namespace, but that requires Closure to *export* the lazy entry symbols
under stable names, which it will not do for arbitrary lazy roots — see §4.5.

### 4.4 Base URL derivation

`r.a()` currently derives the public path from
`document.currentScript.src || location.href`. In a module script
`document.currentScript` is `null`, so it silently falls back to the *document*
URL — wrong for any `publicPath` that is relative (`"./"`), and only correct by
accident for absolute public paths.

The obvious fix, `new URL(a[3], import.meta.url)`, **cannot be written in the
compiler input**: adding `import.meta` to `main.linked.js` makes Closure
classify that input as a module, which module-scopes all of its top-level
declarations and immediately produces 41 `JSC_UNDEFINED_VARIABLE` errors from
the sibling chunks (reproduced). Options:

* inject `import.meta.url` into the base chunk in postprocess (textual, like
  `injectBundlerRuntimeEs5HelperBag` already does), **or**
* rely on relative dynamic-import specifiers: `import("./btn.js")` inside
  `main.js` resolves against `main.js`, not the document — which removes the
  need for a base URL for *JS* entirely. This is what the spike does, and it is
  strictly more correct than the current `currentScript` trick. CSS still needs
  a base, so an absolute `publicPath` or the postprocess injection is required.

### 4.5 Dynamic-import namespace interop

Our transpiler rewrites `import('./Panel.svelte')` to
`__dynamicImport(moduleId)` → `r.j` → `r.q(moduleId)`, which returns a registry
object whose live getters are installed by `r.g`, plus our synthesised
`default`/`__esModule` shape (see the `(0,$gcc.he)(13, function(a,b,c,d,e){...})`
tail of each lazy chunk). Native `import()` would return a real module
namespace object instead — frozen, `Symbol.toStringTag === "Module"`,
`null`-prototype, and with names chosen by Closure's *variable* renamer.

Nothing in Closure guarantees a stable exported name for a lazy entry point, so
"just use the native namespace" is not available without a shim that re-exports
under a fixed name. Keeping the registry (as the spike does) is the correct
staging: native `import()` is used purely as a *loader*, and the namespace the
app sees keeps its current shape. Behavioural deltas to accept if we ever drop
the registry: frozen namespace, no monkey-patching of the returned object,
`default` interop rules change.

### 4.6 HTML rewriting

`src/vite/output.ts:80-115` (`rewriteHtmlAssets`) strips Vite's
`<link rel=modulepreload>` and `<script type=module>` tags and emits
`<script defer src=...>`. Under ESM that must become
`<script type="module" crossorigin src=...>` — and since module scripts are
CORS-fetched, a cross-origin `publicPath` now needs correct CORS headers, which
`defer`-script output never needed.

`modulepreload` for the eager graph: our entry has no static imports, so there
is nothing to preload at stage 1. If we ever delete the manifest-driven
dependency prefetch, `modulepreload` links become mandatory to keep the
waterfall flat.

### 4.7 Gating: ES5 / script targets must stay on GLOBAL_NAMESPACE

`resolveViteLanguageOut()` in `src/vite/config.ts` maps Vite `build.target` to
`ECMASCRIPT3/5/6/NEXT`. Closure will *not* reject ES_MODULES with an ES5 target
(verified — it emits ES5 bodies with `import` statements), so we gate:

```
languageOut ∈ { ECMASCRIPT3, ECMASCRIPT5 }  → GLOBAL_NAMESPACE (forced)
languageOut ∈ { ECMASCRIPT6, ECMASCRIPT_NEXT } → ES_MODULES eligible
```

Additional forced-GLOBAL_NAMESPACE cases: any consumer that loads the bundle
with a plain `<script>` (worker bundles, `chunks.mode: "split"`, the
`gcc-ts-bundler` CLI's non-vite path, anything embedding the output in a page
it does not control), and `isolation_mode`/`output_wrapper` users.

Recommended knob: `chunks.outputType?: "script" | "esm" | "auto"`, default
`"auto"` = `esm` when `languageOut ≥ ECMASCRIPT6` **and** `chunks.mode ===
"bundler-runtime"` **and** the entry is HTML-injected by the Vite plugin.

### 4.8 Dev-vs-prod parity

Vite dev already serves native ESM, so ESM output *narrows* the dev/prod gap
for module semantics (strict mode, deferred execution, `import.meta`). It
*widens* it in one place: in dev, `import()` yields real namespaces; in prod it
yields our registry object. That gap exists today too, so it is not a
regression — but it is an argument for eventually doing §4.5 properly.

### 4.9 Miscellaneous breakage to watch

* `canonicalizeBundlerRuntimeRootAccess()` and `wrapBundlerRuntimeOutputFile()`
  (`src/build/closure/postprocess/runtime.ts`) are GLOBAL_NAMESPACE-specific
  and must be skipped in ESM mode.
* The ES5 helper bag injection keys off the literal `").call(this,globalThis);"`
  preamble marker (`runtime.ts:11`) — that marker still exists in ESM mode
  because the preamble is our own text, but it is a fragile coupling.
* `extractRuntimeInitManifest()` (`src/vite/runtime-manifest.ts`) finds the
  manifest by scanning for `"__g"` then `.a(`. Unchanged under ESM; still ugly.
* `rewriteDecoratorMetadata` post-pass is **mandatory** in both modes. Skipping
  it renders the app unstyled (`class` → renamed key leaks into the DOM as
  `h="m3-container …"`). This bit me mid-spike and cost an hour; it is
  orthogonal to ESM but worth writing down.

---

## 5. Spike: what was built and verified

Artifacts (all under `/tmp/spike`):

| file | what |
|---|---|
| `compile.sh` / `compile-gn.sh` | Closure invocations, ES_MODULES / GLOBAL_NAMESPACE |
| `patch-in.mjs` | rewrites the linked base chunk's loader: `<script>` → `import()` |
| `pp.mjs` | runs the native `rewriteDecoratorMetadata` post-pass |
| `dist/` | complete, working ES_MODULES build of `examples/svelte-vite-spa` |
| `dist-gn/` | control build from identical inputs, GLOBAL_NAMESPACE |
| `slowserve.py` | 200 ms-per-response server used for the waterfall test |
| `shot-*.png` | browser evidence |

`dist/index.html` is hand-written: `<script type="module" src="/assets/main.js">`.

**Browser verification** (Chrome via agent-browser, `http://localhost:4321`):

* app boots, renders identically to the shipped `dist` (pixel-compared against
  `shot-baseline.png` / `shot-gn-control.png`);
* all 5 lazy panels load and render styled — Button, Menu, Checkbox, Dialog,
  Navigation Rail;
* Dialog panel: open → "Ship build" → "Latest dialog action: deployment
  confirmed." asserted;
* Checkbox panel: two toggles asserted via the derived `Flags: diag:off,
  manifest:on, esm:on` text;
* console: **0 messages**; page errors: 0 attributable to this origin (the 3
  rows the tool still reports all carry `http://localhost:4323/...` stack
  frames — the deliberately mis-pathed GN control page from earlier in the
  session);
* network: every request 200 except `/favicon.ico`.

**Waterfall**, `performance.getEntriesByType('resource')`, 200 ms artificial
latency per response:

```
ES_MODULES  (:4324)                 GLOBAL_NAMESPACE dist (:4325)
index.css   207 → 409               index.css     207 → 411
main.js     208 → 410               index-*.js    207 → 410
shared.js   423 → 626               shared-*.js   426 → 629
btn.js      423 → 627               ButtonPanel   426 → 629
--- click "Navigation Rail" ---
nav.css     +0   → +203             NavRail.css   +0  → +203
nav.js      +0   → +204             NavRail.js    +0  → +204
```

Identical: 4 requests cold, 2 per panel, one round trip each, JS and CSS in
parallel. **The ESM build has no extra waterfall depth** — precisely because
the spike keeps the manifest-driven dependency prefetch. Delete that and
`shared.js` moves one RTT later, behind `btn.js`'s parse.

---

## 6. Is it worth it?

Honest accounting.

**Gains**

* −7.6% raw / −3.3% gzip on this app (≈0.9 KB gzip). Real but small.
* Deletes `--rename_prefix_namespace $gcc`, the per-chunk IIFE wrapper, and the
  `canonicalizeBundlerRuntimeRootAccess` string-rewriting postprocess — that is
  ~120 lines of fragile textual surgery over minified output.
* Deletes the `document.currentScript` base-URL hack (relative `import()`
  specifiers are self-locating).
* Chunk isolation becomes a language guarantee instead of something we
  hand-maintain with a wrapper + a shared global object.
* Closer to dev-mode semantics; native devtools module graph.

**Costs / risks**

* `JSC_IMPORT_ASSIGN` on mutable cross-chunk state is a **hard build failure**
  with an unhelpful message, and `CrossChunkCodeMotion` can trigger it on code
  that looks innocent (#4264, open). This is the one that will generate bug
  reports. Mitigation: keep GLOBAL_NAMESPACE as an escape hatch and detect the
  diagnostic to emit a targeted error ("chunk B writes to `x` owned by chunk A;
  set `chunks.outputType: 'script'` or move the state").
* Hash cycle needs Rollup-style placeholder hashing in `src/vite/naming.ts`.
* Two output modes to test forever (ES5 apps, workers, split mode, CLI).
* No gzip win on small chunks; a chunk-heavy app could regress slightly.

**Verdict: GO, gated and staged.** The size win alone would not justify it; the
deletion of the `$gcc` prefix machinery + output wrapper + `currentScript`
hack does, and the spike shows the loader keeps all the properties that matter
(parallel dep fetch, CSS coupling, chunk-load error propagation).

---

## 7. Staged migration plan

**Stage 0 — gate plumbing (no behaviour change).**
Add `chunks.outputType: "script" | "esm" | "auto"` to build options
(`src/api/types.ts`, `src/vite/config.ts`); resolve to `script` everywhere;
thread it into `prepareClosureJobs` input (`native/src/closure_jobs.rs`).
Force `script` when `languageOut ∈ {ECMASCRIPT3, ECMASCRIPT5}`, when
`chunks.mode !== "bundler-runtime"`, or for worker outputs.

**Stage 1 — emit.**
In `native/src/closure_jobs/jobs/bundler_runtime.rs`: per-chunk-unique runtime
alias names (`render_runtime_alias_line` takes the chunk index); set
`chunkOutputType`, drop `renamePrefixNamespace`, keep `assumeFunctionWrapper`.
In `src/build/closure/postprocess/index.ts`: skip
`wrapBundlerRuntimeOutputFile` and `canonicalizeBundlerRuntimeRootAccess` in
esm mode; keep `rewriteDecoratorMetadata` and the ES5 helper bag (the latter is
unreachable anyway, ES5 is gated to script mode).

**Stage 2 — loader.**
In `native/src/closure_jobs/runtime.rs`, emit an esm variant of the preamble
where `p(u(a))` becomes `import(specifier)` and the manifest stores relative
specifiers. Keep: chunk state table, dependency prefetch, CSS loading,
registry. Delete: script element creation, `document.currentScript` base
derivation for JS. `/tmp/spike/patch-in.mjs` is the reference implementation.

**Stage 3 — naming.**
`src/vite/naming.ts`: placeholder-based hashing (Rollup's scheme) plus an
import-specifier rewrite across all chunks, so `main.js`'s hashed name is
patched into every lazy chunk. Until stage 3 lands, keep the base chunk's name
hash computed pre-patch (already the shape of the existing code).

**Stage 4 — HTML.**
`src/vite/output.ts:103`: `<script type="module" crossorigin>` in esm mode.
Add `modulepreload` emission only if/when the manifest prefetch is removed.

**Stage 5 — flip the default.**
`auto` resolves to `esm` for `bundler-runtime` + `languageOut ≥ ECMASCRIPT6`.
Keep `script` reachable and documented. Add a diagnostic that translates
`JSC_IMPORT_ASSIGN` into an actionable message.

**Not planned:** replacing the module registry with native module namespaces
(§4.5). Revisit only if Closure gains stable exported names for lazy entry
points.

---

## 8. Reproduction

```bash
# sizes
/tmp/spike/compile.sh    /tmp/esm-in /tmp/spike/out-esm ES_MODULES
/tmp/spike/compile-gn.sh /tmp/esm-in /tmp/spike/out-gn  GLOBAL_NAMESPACE

# working esm dist
node /tmp/spike/patch-in.mjs
/tmp/spike/compile.sh /tmp/spike/in-esm /tmp/spike/out-esm2 ES_MODULES
node /tmp/spike/pp.mjs /tmp/spike/out-esm2/prop.txt /tmp/spike/out-esm2/*.js
cp /tmp/spike/out-esm2/*.js /tmp/spike/dist/assets/
cd /tmp/spike/dist && python3 -m http.server 4321

# the two failure modes
cd /tmp/spike/assign && ...   # JSC_IMPORT_ASSIGN on mutable cross-chunk state
/tmp/spike/compile.sh /tmp/spike/in-dup /tmp/spike/out-dup ES_MODULES  # alias collision
```
