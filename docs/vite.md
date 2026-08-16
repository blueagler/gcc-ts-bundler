# Vite integration

The `gcc-ts-bundler/vite` entry exports a build-only Vite plugin that replaces Rollup's JavaScript output with Closure-optimized application chunks while preserving Vite's transformed module graph, assets, CSS, and output naming.

## Basic setup

```ts
import { defineConfig } from "vite";
import { gccTsBundler } from "gcc-ts-bundler/vite";

export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [gccTsBundler()],
});
```

Vite is an optional peer dependency of the core package; install it in projects that use this subpath.

Place framework and source-transform plugins before `gccTsBundler()`. The plugin has `enforce: "post"` and only applies to `vite build`; Vite's development server remains unchanged.

## Framework presets

The core compiler is framework-agnostic. Framework runtimes that dispatch on
property keys reflectively need a preset, which bundles the required compat
and externs configuration:

```ts
// Svelte
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { gccTsBundler } from "gcc-ts-bundler/vite";
import { sveltePreset } from "gcc-ts-bundler/presets/svelte";

export default defineConfig({
  build: { target: "esnext" },
  plugins: [svelte(), gccTsBundler(sveltePreset())],
});
```

```ts
// React
import react from "@vitejs/plugin-react";
import { gccTsBundler } from "gcc-ts-bundler/vite";
import { reactPreset } from "gcc-ts-bundler/presets/react";

export default defineConfig({
  build: { target: "esnext" },
  plugins: [react(), gccTsBundler(reactPreset())],
});
```

```ts
// Vue
import vue from "@vitejs/plugin-vue";
import { gccTsBundler } from "gcc-ts-bundler/vite";
import { vuePreset } from "gcc-ts-bundler/presets/vue";

export default defineConfig({
  build: { target: "esnext" },
  plugins: [vue(), gccTsBundler(vuePreset())],
});
```

Presets accept every plugin option plus `externModules` for UI kits whose
public API crosses the compiled boundary:

```ts
gccTsBundler(sveltePreset({ externModules: ["m3-svelte"] }));
```

Presets are plain option builders on top of two generic core mechanisms:

- `compiler.compat.classMapCalls` — calls whose object-literal argument keys
  must survive property renaming. A rule may be limited by `keyPattern` /
  `keyExcludePattern`, and gated via `stringLiteralArgIndex` on a literal or
  an immutable value produced by another matching literal-gated call (so host
  provenance can flow through transforms such as React `cloneElement`);
- `externs.generate.protocolHelpers` — helper callees that read or exclude
  property keys by string at runtime.

Apps without a preset (Lit, vanilla TS) use `gccTsBundler()` directly.

## How it integrates

The plugin captures transformed modules during Vite's transform phase. At `generateBundle`, it reads Rollup's final chunk graph and keeps only its retained module subgraph. It materializes that graph and classifies each dependency from its materialized text.

Clean ESM dependency modules stay in the native pipeline. Unsafe dependency cores, such as CJS or mixed modules, become per-import-target esbuild atoms. Atom requests derive named exports for callable CJS facades when the captured graph proves them. Identical lazy atom outputs use one canonical instance. The plugin does not prebundle every dependency region.

The plugin serializes Rollup's retained chunk graph. The native planner mirrors that graph as a Closure chunk DAG and adds synthetic edges when Closure needs one dependency-free root. It then invokes the core compiler with:

- `chunks.mode = "bundler-runtime"`;
- `packages = "off"` because the graph is already materialized;
- entries derived from Vite entry facades;
- `languageOut` derived from `build.target`.

It then removes Rollup JavaScript chunks, emits the compiled files through Rollup, carries CSS ownership into lazy chunk loading, follows Rollup entry/chunk naming patterns, and rewrites HTML entry scripts by default.

## Namespace access

Bundler-runtime namespace imports use a small lattice:

- A known member such as `namespace.ready` lowers to its export slot.
- A computed member with a finite proven key set lowers to conditional selections. The proof follows literals, conditionals, and stable single-assignment locals.
- An unprovable computed access reifies the namespace object. Reification uses live getters for its exports and emits one deduplicated warning per target module.
- A write, delete, update, `Object.assign`, or `Reflect` mutation through a namespace remains an error because module namespaces are read-only.

Passing a namespace value to another operation also reifies it when the compiler cannot prove member-only use. The warning reports the module and access that caused reification.

## Build speed

By default, typed ADVANCED jobs use `platformExterns: "minimal"`: a
dependency-closed slice of the exact typed browser declarations shipped with
Closure. Untyped jobs, `GCC_DISABLE_TYPE_INFERENCE=1`, archive/index failures,
and failed custom-environment compiles safely use Closure's full browser
externs. Set `compiler: { platformExterns: "full" }` to always use the full set.

Warm builds reuse the persistent cache in `~/.cache/gcc-ts-bundler` and skip
Closure entirely; persist that directory in CI.

With the persistent cache, renaming maps from the previous build are fed
back into Closure (`--property_map_input_file`/`--variable_map_input_file`),
so unchanged chunks stay byte-identical across builds — an edit to one lazy
chunk no longer invalidates the browser cache for every other chunk.
`clean-cache` resets the maps.

## Plugin options

```ts
gccTsBundler({
  compiler: {
    cache: { mode: "persistent" },
    compilationLevel: "ADVANCED",
    diagnostics: { preflight: "errors-only" },
    // Legacy explicit externs: Closure + native rename-barrier scan.
    externs: ["./closure-externs/custom.js"],
    // Typed declarations for Closure only; native never scans these.
    typedExterns: ["./closure-externs/runtime.typed.externs.js"],
  },
  runtime: {
    publicPath: "/assets/",
    manifestFile: "gcc-manifest.json",
  },
  externs: {
    generate: {
      mode: "runtime-aware",
      modules: ["svelte"],
      appendLines: ["Object.prototype.customProtocol;"],
    },
  },
  html: {
    rewriteEntryScripts: true,
  },
  debug: {
    dumpCapturedGraphDir: ".gcc-debug",
  },
});
```

### `compiler`

Accepts core `BuildOptions` except options owned by Vite: `entries`, `languageOut`, `outDir`, `packages`, `projectRoot`, `srcDir`, and `chunks.mode`.

Do not set `compiler.chunks.mode`; the plugin always compiles with `"bundler-runtime"`. A caller-supplied value is a type error (`createCompilerOptions` overwrites it). Other `chunks` fields (`baseChunkName`, `outputType`, `publicPath`, `vendorChunk`, `manifestFile`) still apply.

`compilationLevel` stays settable. Anything other than `"ADVANCED"` emits a one-time warning: `"SIMPLE"` measured +9.9% gzip against plain esbuild on a 2352-module React app, and the Vite path is tuned only for ADVANCED.

Do not set `compiler.languageOut`; use Vite `build.target`. The plugin maps:

| Vite target | Closure output |
| --- | --- |
| omitted or `baseline-widely-available` | `ECMASCRIPT_2021` |
| `false` or `esnext` | `ECMASCRIPT_NEXT` |
| `es3` | `ECMASCRIPT3` |
| `es5` | `ECMASCRIPT5` |
| `es6` or `es2015` | `ECMASCRIPT_2015` |
| `es2016` | `ECMASCRIPT_2016` |
| `es2017` | `ECMASCRIPT_2017` |
| `es2018` | `ECMASCRIPT_2018` |
| `es2019` | `ECMASCRIPT_2019` |
| `es2020` | `ECMASCRIPT_2020` |
| `es2021` | `ECMASCRIPT_2021` |
| `es2022` and newer year targets | `STABLE` |

Versioned Chrome, Edge, Firefox, Safari, iOS, Node, and IE targets also use the native capability table. For example, `chrome120` maps to `ECMASCRIPT_2021`; an unknown form such as `last 2 versions` fails. For a target array, the oldest mapped output level wins. The plugin does not silently raise a declared target. If input syntax needs a newer level, the diagnostic names the minimum level.

### `compiler.chunks.outputType`

Selects the shape Closure gives the emitted chunks.

| Value      | Emitted chunks                                                       | Entry tag                                 |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `"script"` | Classic scripts sharing one renamed global namespace                   | `<script defer src="...">`                |
| `"esm"`    | Native modules; cross-chunk edges are `import`/`export`                | `<script type="module" crossorigin src="...">` |
| `"auto"`   | Default, and resolves to `esm` unless a gate forces script             | follows the resolved value                |

Omitting `outputType` and setting it explicitly to `"auto"` are equivalent in the Vite integration.

ES module output drops the renamed-namespace prefix, the per-chunk function
wrapper, and the `document.currentScript` base-URL probe. The risk analysis is in
[`research/es-modules-output.md`](https://github.com/blueagler/gcc-ts-bundler/blob/main/docs/research/es-modules-output.md).

Request counts and waterfall depth are unchanged: lazy chunks are still fetched
through the runtime manifest, which issues a chunk and all of its dependencies
in one parallel round. Because of that the plugin deliberately emits **no**
`<link rel="modulepreload">` — the entry chunk has no static imports to preload,
and preloading lazy chunks would defeat the point of loading them lazily.

Module scripts are always fetched in CORS mode. A cross-origin `publicPath`
must send `Access-Control-Allow-Origin` under `"esm"`, which a classic `defer`
script never required.

#### When a build fails with `JSC_IMPORT_ASSIGN`

ES module import bindings are immutable in the importing module, and Closure
enforces this as a hard error:

```
ERROR - [JSC_IMPORT_ASSIGN] Imported symbol "a" in chunk "panel.js"
cannot be assigned (defined in "main.js")
```

It means a lazily loaded chunk writes to module-level state that lives in
another chunk — a store, a cache, a mutable singleton — which the shared global
namespace of `"script"` output allows and native modules do not. Note that
ADVANCED cross-chunk code motion can also *move* a function into a lazy chunk
and create this situation from source that never crossed a chunk boundary
itself, so the reported location is the definition, not the offending write.

Two fixes, in order of preference:

1. Stop writing the shared binding from the lazy chunk. Export a setter that
   stays in the eager chunk, or move the state behind an object property
   (`state.value = x` instead of `value = x`).
2. Set the escape hatch and keep script output for that build:

   ```ts
   gccTsBundler({
     compiler: { chunks: { outputType: "script" } },
   });
   ```

`"script"` remains fully supported; it is the only option for `es3`/`es5`
targets and for output loaded by anything other than a module script.

### `compiler.chunks.vendorChunk`

**No-op under this plugin.** A Vite build plans its chunks by mirroring
Rollup's own chunk graph, so the dependency split is whatever Rollup already
decided and there is nothing left for this flag to partition. It still applies
to standalone (non-Vite) `bundler-runtime` builds, which have no host chunk
graph to mirror; the rest of this section describes those.

Moves eagerly reachable dependency modules (`node_modules`, virtual modules)
out of the entry chunk into a separate
`<baseChunkName>-vendor` chunk.

Under module output the entry chunk's hashed file name is embedded in every
sibling chunk's `import` statement, so editing app code re-hashes the entry and
that new name propagates outward. Splitting the dependency half off gives it its
own chunk with no reference to the entry, so its file name and browser cache
entry can survive app edits.

**This is opt-in, and it is a real trade.** Splitting can cost first-load bytes: the two halves no longer optimise against
each other, so cross-chunk inlining, dead-property removal, and property renaming
have less scope. It can keep dependency output stable across app-only deploys.
Opt in when repeat visits make that cache stability useful. Leave it off when
most visitors arrive only once.

```ts
gccTsBundler({
  compiler: { chunks: { vendorChunk: true } },
});
```

`false` is the default, and `"auto"` also resolves to `false`. An explicit `true` is gated to
where the split can work at all: `bundler-runtime` chunks whose resolved
`outputType` is `"esm"`. Script output addresses chunks through the runtime
manifest rather than by embedded name, so there is nothing to stabilise and the
extra chunk would only cost a request; `off` and `split` have no chunk graph.

Lazy chunks are not stabilised by this: they import symbols directly from the
entry, so their bytes contain its hashed name and they necessarily re-hash with
it — making them stable too would require import-map indirection, which is not
implemented.

### `runtime`

- `publicPath` defaults to Vite's resolved `base` and is normalized with a trailing slash.
- `manifestFile` publishes the internal runtime manifest under the requested filename. Without it, the plugin uses a temporary internal manifest and removes it from final output.

### Generated externs

The Vite adapter can generate externs from the materialized runtime graph:

```ts
externs: {
  generate: {
    mode: "runtime-aware",
    modules: ["m3-svelte", "svelte"],
  },
}
```

`runtime-aware` is the Vite default when generation is enabled. Package runtime facts are cached separately in persistent cache mode. `boundary-aware` delegates to the root `generateExterns()` API.

Generated Vite externs are rename barriers only because Vite materializes ordinary dependencies into the Closure job. External-runtime typed declarations require a real host loader and compiled bridge, so the plugin rejects attempts to invent that placement. Generate such declarations separately, provide the bridge/`__gccExternalRuntimeLoad` contract yourself, and pass only the declaration artifact through `compiler.typedExterns`.

`appendLines` adds explicit extern statements after generated content. Use it only for contracts that cannot be discovered from declarations, runtime code, or application usage.

#### What gets externed, and the multi-entry trade

A member only earns an extern when its definition and its reads cannot rename
together:

```
extern = protocolMembers
       ∪ (stringDefined ∩ dotAccessed)
       ∪ (dotDefined    ∩ stringLiteralRead)
```

`stringDefined` covers `__publicField(this, "x")`, `Object.defineProperty`,
`this["x"] = v` and quoted class fields — the string survives renaming while a
`o.x` read does not. `stringLiteralRead` covers `o["x"]` and `"x" in o`. A
member that is dot-defined *and* dot-accessed renames consistently within a
single Closure invocation, so it is deliberately **not** externed: externing it
would also force the native emitter to quote it, which is what previously
suppressed optimisation on ordinary application fields. Dependency hazards are
read from the post-prebundle graph, because esbuild's class-field lowering is
what creates the string-keyed definitions in the first place.

The rule assumes every side of a member pair is renamed by the **same** Closure
invocation, which is true for `chunks.mode: "bundler-runtime"` (the Vite
default — one compile job covering every chunk). It does not hold for a
multi-entry `off`-mode build that compiles each entry as a separate job and
passes objects between the resulting bundles: two jobs can rename the same
member differently, and the older, broader rule used to hide that by externing
any defined-and-accessed member. If you exchange structured objects across
separately compiled entry bundles, name that contract explicitly with
`externs.generate.appendLines` (or a hand-written `compiler.externs` file) rather
than relying on incidental preservation. Hand-written `compiler.externs` keeps
the historical dual semantics; use `compiler.typedExterns` when declarations
must reach Closure without becoming native rename barriers.

### HTML and debug options

`html.rewriteEntryScripts` defaults to `true`. Set it to `false` only if another plugin or deployment step owns final entry-script injection.

`debug.dumpCapturedGraphDir` writes the materialized workspace to a stable project-relative directory and clears that directory before each build. Without it, workspaces live under `.gcc-ts-bundler-vite/<build-id>` so identical persistent builds can reuse the same capture root.

## CSS and lazy chunks

With `build.cssCodeSplit = true`, the plugin records which Vite CSS assets belong to lazy modules and augments the runtime manifest so CSS loads with the corresponding script chunk.

With `cssCodeSplit = false`, Vite's eager CSS output is retained without runtime CSS ownership tracking.

Use native literal dynamic imports:

```ts
const panel = await import("./Panel.js");
```

Non-literal dynamic imports are not supported by the core chunk planner.

## Supported build shape

The plugin targets browser application builds. It rejects:

- Vite SSR builds;
- Vite library mode;
- Vite manifest output;
- Vite sourcemaps;
- worker entry graphs.

It also disables Vite module preload because the emitted runtime owns script and module dependency loading, under both chunk output types.

Framework compilation must finish before this plugin. Resource imports that survive as non-JavaScript modules must be lowered by Vite or another plugin before capture.

## Example

Every example under `examples/` is an official framework starter with only
`gccTsBundler()` added to `vite.config.ts`, alongside a `vite.pure.config.ts`
that builds the same app without the plugin:

| Example | Template | Plugin configuration |
| --- | --- | --- |
| `examples/react-vite-official` | `npm create vite --template react-ts` | `gccTsBundler(reactPreset())` |
| `examples/svelte-vite-official` | `npm create vite --template svelte-ts` | `gccTsBundler(sveltePreset())` |
| `examples/lit-vite-official` | `npm create vite --template lit-ts` | `gccTsBundler()` |
| `examples/jquery-vite-official` | `npm create vite --template vanilla-ts` + jquery | `gccTsBundler({ externs: { generate: … } })` |
| `examples/vue-vapor-vite-official` | `create-vue` (Vue 3.6 Vapor) | `gccTsBundler(vuePreset())` |

`examples/jquery-vite-official` is the one that needs more than a preset: it
shows runtime-aware extern generation with `protocolHelpers.keyReadCallees`,
which is how a library that reads its own members through string keys keeps
working under ADVANCED.
