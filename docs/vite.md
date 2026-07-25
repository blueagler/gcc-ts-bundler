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

Place framework and source-transform plugins before `gccTsBundler()`. The plugin has `enforce: "post"` and only applies to `vite build`; Vite's development server remains unchanged.

## How it integrates

The plugin captures transformed modules during Vite's transform phase. At `generateBundle`, it uses Rollup's final chunk graph to keep only retained modules, materializes that graph, prebundles dependency regions, and invokes the core compiler with:

- `chunks.mode = "bundler-runtime"`;
- `packages = "off"` because dependencies are already materialized;
- entries derived from Vite entry facades;
- `languageOut` derived from `build.target`.

It then removes Rollup JavaScript chunks, emits the compiled files through Rollup, carries CSS ownership into lazy chunk loading, follows Rollup entry/chunk naming patterns, and rewrites HTML entry scripts by default.

## Plugin options

```ts
gccTsBundler({
  compiler: {
    cache: { mode: "persistent" },
    compilationLevel: "ADVANCED",
    diagnostics: { preflight: "errors-only" },
    externs: ["./closure-externs/custom.js"],
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

Accepts core `BuildOptions` except options owned by Vite: `entries`, `languageOut`, `outDir`, `packages`, `projectRoot`, and `srcDir`.

Do not set `compiler.languageOut`; use Vite `build.target`. The plugin maps:

| Vite target                     | Closure output    |
| ------------------------------- | ----------------- |
| `false` or `esnext`             | `ECMASCRIPT_NEXT` |
| `es3`                           | `ECMASCRIPT3`     |
| `es5`                           | `ECMASCRIPT5`     |
| `baseline-widely-available`     | `ECMASCRIPT6`     |
| `es2015` and newer year targets | `ECMASCRIPT6`     |

For a target array, the oldest mapped output level wins. Browser-specific targets such as `chrome120` are rejected because they do not map to a Closure language level.

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

`runtime-aware` is the Vite default when generation is enabled. Package runtime facts are cached separately in persistent cache mode. `boundary-aware` and `candidates` delegate to the root `generateExterns()` API.

`appendLines` adds explicit extern statements after generated content. Use it only for contracts that cannot be discovered from declarations, runtime code, or application usage.

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

It also disables Vite module preload because the emitted runtime owns script dependency loading.

Framework compilation must finish before this plugin. Resource imports that survive as non-JavaScript modules must be lowered by Vite or another plugin before capture.

## Example

`examples/svelte-vite-spa` demonstrates a Svelte application with third-party Vite transforms, runtime-aware extern generation, and the plugin at the end of the plugin list.
