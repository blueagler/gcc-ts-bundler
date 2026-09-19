# Vite integration

The `gcc-ts-bundler/vite` entry exports a build-only plugin that compiles Vite's
retained JavaScript graph with Closure, integrates assets and CSS, and follows
Vite's output naming patterns. This is the plugin configuration reference;
core option defaults are documented in the [API reference](api.md).

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

The plugin captures transformed modules, retains the bundler's surviving graph,
and compiles its chunk plan in one Closure job. It owns core entries, paths,
package resolution, and chunk mode; use Vite configuration for those concerns.
Dependency adaptation and graph planning are described in
[architecture](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/development/architecture.md).

The emitted application uses the compiler's chunk runtime. Vite still owns
framework/resource transforms and CSS assets; the adapter associates lazy CSS
with the emitted chunks.

The adapter reads `transform.define` from the host's ordered options hook and
applies it through Vite's public `transformWithOxc` API. It does not reconstruct
environment values or replace identifier text: optional chains and lexical
shadowing follow Oxc semantics. Closure-specific static-alias annotations are
added after that transform so its printer cannot discard them. Re-entered
render and file-URL hooks use the host's sorted-hook APIs, including hook-level
`order`; declaration-array order alone is not the contract.

Each output invocation gets its own authored-file membership and type-metadata
values for the retained, materialized graph; the core does not read an
authored-membership JSON path or a process-global membership memo. Reusable
transform captures survive watch rebuilds when Vite reuses transforms, but
rendered-output evidence, resolution state, and report metrics are reset for
each output so one build's pruning does not leak into another.

The delivered type-metadata path is not a replacement for project typechecking:
it currently bypasses the core semantic preflight collector. Setting
`compiler.diagnostics.preflight` does **not** make this integration reject all
original-source TypeScript errors. Run a separate project typecheck when that
is required.

## Namespace access

Known namespace members and computed accesses with a provable finite key set
can lower to export slots. Otherwise the compiler materializes a live-getter
namespace object and warns once per target module. Passing the namespace to
unknown code can trigger the same warning. Mutation through a namespace
(including assignment, deletion, or reflective mutation) remains an error:
module namespaces are read-only.

## Build speed

The plugin uses the core [persistent cache](api.md#cache-options) and
[platform extern policy](api.md#platform-externs). Cache hits can skip Closure;
changed inputs can still require a full compile. Saved renaming maps can
improve chunk stability but do not guarantee unchanged bytes after edits.

Type metadata can be reused from memory or disk when its graph identity and
dependency state match, and is delivered to each core invocation as a value.
It supports optimization and metadata diagnostics, not complete semantic
preflight coverage of original source. Do not assume a fixed build-time or
output-size benefit. For cache reset commands, see the
[CLI reference](cli.md#clean-cache).

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
  debug: {
    dumpCapturedGraphDir: ".gcc-debug",
  },
});
```

### `compiler`

Accepts [core `BuildOptions`](api.md#build-options) except options owned by
Vite: `entries`, `languageOut`, `outDir`, `packages`, `projectRoot`, `srcDir`,
`chunks.mode`, `chunks.publicPath`, and `chunks.vendorChunk`.

Do not set `compiler.chunks.mode`, `compiler.chunks.publicPath`, or `compiler.chunks.vendorChunk`. The plugin always compiles with `"bundler-runtime"`, takes the public path from `runtime.publicPath ?? config.base`, and mirrors Rollup's chunk graph instead of the standalone vendor split. Caller-supplied values are type errors (`createCompilerOptions` overwrites them). Other `chunks` fields (`baseChunkName`, `outputType`, `manifestFile`) still apply.

`compilationLevel` stays settable. Anything other than `"ADVANCED"` emits a
one-time warning because this integration is tuned for ADVANCED. The warning's
size comparison comes from a [specific application study](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/research/advanced-renaming-vs-gzip.md),
not a guarantee for other applications.

Do not set `compiler.languageOut`; use Vite `build.target`. The plugin maps:

| Vite target                            | Closure output    |
| -------------------------------------- | ----------------- |
| omitted or `baseline-widely-available` | `ECMASCRIPT_2021` |
| `false` or `esnext`                    | `ECMASCRIPT_NEXT` |
| `es3`                                  | `ECMASCRIPT3`     |
| `es5`                                  | `ECMASCRIPT5`     |
| `es6` or `es2015`                      | `ECMASCRIPT_2015` |
| `es2016`                               | `ECMASCRIPT_2016` |
| `es2017`                               | `ECMASCRIPT_2017` |
| `es2018`                               | `ECMASCRIPT_2018` |
| `es2019`                               | `ECMASCRIPT_2019` |
| `es2020`                               | `ECMASCRIPT_2020` |
| `es2021`                               | `ECMASCRIPT_2021` |
| `es2022` and newer year targets        | `STABLE`          |

Versioned Chrome, Edge, Firefox, Safari, iOS, Node, and IE targets also use the native capability table. For example, `chrome120` maps to `ECMASCRIPT_2021`; an unknown form such as `last 2 versions` fails. For a target array, the oldest mapped output level wins. The plugin does not silently raise a declared target. If input syntax needs a newer level, the diagnostic names the minimum level.

### `compiler.chunks.outputType`

Selects the shape Closure gives the emitted chunks.

| Value      | Emitted chunks                                             | Entry tag                                      |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `"script"` | Classic scripts sharing one renamed global namespace       | `<script defer src="...">`                     |
| `"esm"`    | Native modules; cross-chunk edges are `import`/`export`    | `<script type="module" crossorigin src="...">` |
| `"auto"`   | Default, and resolves to `esm` unless a gate forces script | follows the resolved value                     |

Omitting `outputType` and setting it explicitly to `"auto"` are equivalent in the Vite integration.

ES module output uses native cross-chunk imports instead of the script output's
shared global namespace. The plugin disables Vite module preload and delegates
lazy dependency loading to its runtime. Request timing depends on the emitted
graph and browser; switching output types is not a promise of an unchanged
network waterfall. See the [ES module output study](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/research/es-modules-output.md)
for the original design tradeoffs.

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
ADVANCED cross-chunk code motion can also _move_ a function into a lazy chunk
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

### `runtime`

- `publicPath` defaults to Vite's resolved `base` and is normalized with a trailing slash.
- `manifestFile` publishes the runtime manifest under a safe relative filename
  inside the output directory. It takes precedence over
  `compiler.chunks.manifestFile`. If neither requests a file, the plugin removes
  its temporary internal manifest from final output.

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

Both modes wait for dependency prebundling to finish and analyze the settled
materialized graph that Closure will compile, not an earlier graph while its
files are being rewritten.

Generated Vite externs are rename barriers only because Vite materializes ordinary dependencies into the Closure job. External-runtime typed declarations require a real host loader and compiled bridge, so the plugin rejects attempts to invent that placement. Generate such declarations separately, provide the bridge/`__gccExternalRuntimeLoad` contract yourself, and pass only the declaration artifact through `compiler.typedExterns`.

`appendLines` adds explicit extern statements after generated content. Use it only for contracts that cannot be discovered from declarations, runtime code, or application usage.

`includeDependencies`, `protocolHelpers`, and `propertyPolicy` follow the
[extern-generation contract](api.md#extern-options-and-result). Use
`outputFile` to select the generated artifact path and `appendLines` to add
Vite-specific explicit statements. Required explicit/generated externs and
typed declaration files must be readable; missing inputs fail closed rather
than silently omitting their contracts. Barrier review workflows are in the
[development guide](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/development/workflows.md).

The scan preserves property contracts whose string-keyed and dot-accessed
sides cannot rename together. It does not intentionally pin every ordinary
dot-defined/dot-accessed member: all Vite chunks are compiled in the same
Closure job. Contracts crossing separately compiled bundles must be declared
explicitly; see [module boundaries](api.md#module-boundaries).

### Debug options

`debug.dumpCapturedGraphDir` selects a project-relative parent directory. The
plugin owns and clears only its `gcc-ts-bundler` child before preparing an
output invocation; unrelated siblings in the requested directory are retained.
For example, `".gcc-debug"` writes to `.gcc-debug/gcc-ts-bundler/`.
Do not keep your own files inside that owned child.

Without debug output, persistent `compiler.cache` keeps the workspace under
`<cache.dir or platform cache>/<project-hash>/vite-capture/<build-id>`.
`cache.mode = "temp"` and `"off"` use an isolated temporary directory and
remove it after the build. Stable debug and persistent capture roots are locked
through compilation and emission; stale locks require the same
[manual recovery](api.md#cache-options) as the core cache. The plugin does not
create a default `.gcc-ts-bundler-vite/` directory in the project.

The runtime module-source-map output sidecar remains part of the internal
core-to-Vite handoff for CSS/source attribution; it is not a public source-map
feature. Vite sourcemaps remain unsupported.

### Build report

Set `report: {}` to write `gcc-report.json`, or
`report: { file: "./reports/gcc.json" }` to choose a project-relative path.
Reporting is opt-in and prints a summary after emit.

- `javascript` compares raw and gzip bytes of the Vite JavaScript chunks
  captured before replacement with the emitted compiler JavaScript. Gzip is
  measured per file at level 9 and summed. This is an in-build comparison, not
  an independently run stock-Vite baseline.
- `modules.deadModules` lists captured modules with nonzero rendered length
  that are absent from the materialized source-ID set, excluding tracked empty
  modules. This is a graph difference to investigate, **not proof that deleting
  the corresponding source is safe**.
- `properties.pinned` lists names accounted from rename-barrier artifacts.
  `typedExternFiles` lists typed artifacts separately; their properties are not
  included in this list. Removing a barrier can break a runtime contract.

Use the report to identify questions for inspection, then compare a separate
plain-Vite build and exercise the application's behavior before drawing
optimization or deletion conclusions.

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
- Vite sourcemaps;
- worker entry graphs;
- multiple distinct HTML entry facades.

Vite's `build.manifest` is not part of the supported integration contract,
although the configuration guard does not explicitly reject it. Use
`runtime.manifestFile` for the plugin's own runtime manifest instead.

Framework compilation must finish before this plugin. Resource imports that survive as non-JavaScript modules must be lowered by Vite or another plugin before capture.

## Examples

The starter-based applications under `examples/` include framework presets
and runtime-contract demonstrations. Each provides `vite.config.ts` and a
`vite.pure.config.ts` baseline without the plugin:

| Example                            | Template                     | Plugin configuration                         |
| ---------------------------------- | ---------------------------- | -------------------------------------------- |
| `examples/react-vite-official`     | Vite `react-ts`              | `gccTsBundler(reactPreset())`                |
| `examples/svelte-vite-official`    | Vite `svelte-ts`             | `gccTsBundler(sveltePreset())`               |
| `examples/lit-vite-official`       | Vite `lit-ts`                | `gccTsBundler()`                             |
| `examples/jquery-vite-official`    | Vite `vanilla-ts` + jQuery   | `gccTsBundler({ externs: { generate: … } })` |
| `examples/vue-vapor-vite-official` | `create-vue` (Vue 3.6 Vapor) | `gccTsBundler(vuePreset())`                  |

`examples/jquery-vite-official` is the one that needs more than a preset: it
shows runtime-aware extern generation with `protocolHelpers.keyReadCallees`,
which is how a library that reads its own members through string keys keeps
working under ADVANCED.

Build, preview, and byte-proof verification workflows live in the
[development guide](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/development/workflows.md). See the [README](../../README.md#results-and-limits)
for measurement scope and limitations.
