# GCC-TS-Bundler

GCC-TS-Bundler is a TypeScript bundler built around Google Closure Compiler. It keeps Closure's aggressive optimization model while moving graph resolution, entry shim emission, TypeScript stripping, and export rewriting into a native Rust front-end for faster builds.

Unlike standard TS bundlers, GCC-TS-Bundler is optimized for Closure's aggressive compilation pipeline. The package now uses a native Rust module for the non-Closure stages and keeps Closure Compiler as the final optimizer. This results in smaller, faster, and more efficient output for performance-critical code.

The npm package uses a JS loader plus platform-specific optional native packages. That keeps the main package smaller and allows publishing separate Rust binaries per OS/architecture instead of one bundled addon for every install.

## Features

- Bundles TypeScript code using Google Closure Compiler with a native Rust front-end.
- Utilizes Closure Compiler's advanced optimizations and dead code elimination.
- Uses native graph resolution, shim emission, and TypeScript stripping.
- Resolves browser-safe ESM and statically analyzable CommonJS dependencies from `node_modules`.
- Generates Closure-ready JS and extern placeholders.
- Renames property names in objects for better performance.
- Radically restructures code for optimal performance.

## Build scope

The standalone/native CLI and API support **BASIC** builds only: TypeScript to optimized JavaScript, chunks, and externs, with future Node/Bun target basics. Workers, WebAssembly, assets, `import.meta.glob`, and CSS are Vite-owned transforms handled through the Vite plugin; `?worker` and `?worker&inline` remain a planned Vite-plugin milestone and are outside the standalone pipeline.

## Install From NPM using bun

```sh
bun install gcc-ts-bundler
```

Requires Node.js 18 or newer. Vite is an optional peer dependency and is only needed when importing `gcc-ts-bundler/vite`.

## Documentation

- [Architecture](docs/architecture.md)
- [Programmatic API](docs/api.md)
- [Vite integration](docs/vite.md)
- [Development](docs/development.md)

## Native Closure-Core API

The package now exposes a native-accelerated programmatic API while keeping Closure Compiler as the final optimizer.

```ts
import { build, cleanCache } from "gcc-ts-bundler";

const result = await build({
  entries: ["./index.ts"],
  outDir: "./dist",
  projectRoot: process.cwd(),
  srcDir: "./src",
});

if (!result.ok) {
  process.exit(1);
}

await cleanCache({ projectRoot: process.cwd() });
```

You can also generate Closure externs from package TypeScript hints:

```ts
import { generateExterns } from "gcc-ts-bundler";

const result = await generateExterns({
  appEntryFiles: ["./main.ts"],
  mode: "boundary-aware",
  modules: ["lit", "@lit-labs/router", "@lit-labs/motion"],
  outputFile: "./closure-externs/lit.generated.js",
  projectRoot: process.cwd(),
  srcDir: "./src",
});

console.log(result.scannedFiles);
// Pass result.renameBarriers.outputFile through build.externs.
// Pass result.typedDeclarations.outputFile through build.typedExterns only for
// runtimes intentionally kept outside the Closure job.
```

Programmatic options:

- `projectRoot`
- `srcDir`
- `entries`
- `outDir`
- `packages`
- `languageOut`
- `compilationLevel`
- `chunks`
- `cache`
- `compat`
- `platformExterns`
- `diagnostics`
- `externs` (legacy explicit externs: Closure + native rename-barrier scan)
- `typedExterns` (Closure-only typed external declarations)
- `js`

Defaults:

- `cache.mode = "persistent"`
- `chunks.mode = "off"`
- `chunks.manifestFile` is off by default
- `chunks.outputType = "auto"` (standalone builds resolve `auto` to classic script output)
- `chunks.vendorChunk = false`
- `platformExterns = "minimal"`
- `packages = "esm-only"`
- persistent cache lives outside the user project
- `diagnostics.preflight = "errors-only"`

The runtime path uses a native Rust addon for graph resolution, shim emission, and GCC export rewriting. Closure Compiler remains the final aggressive optimizer.

`packages = "esm-only"` supports browser-safe ESM dependencies from `node_modules`, plus statically analyzable CommonJS package entrypoints and internal package modules. Dynamic `require()`, Node builtins, JSON modules, and native addons are still rejected.

`chunks.mode = "split"` compiles one Closure chunk graph for the strongest cross-module optimization. `chunks.mode = "bundler-runtime"` compiles app-oriented chunks as separate cacheable jobs. Both modes treat entries as bootstrap scripts rather than exported library bundles.

Use native `import()` for explicit lazy loading:

```ts
const loadFeature = () => import("./feature");
```

The specifier must be a string literal. `chunks.outputType = "script"` loads lazy chunks by injecting classic scripts; `"esm"` uses native dynamic `import()`. Standalone `"auto"` resolves to `"script"`; the Vite integration selects ESM when its target supports modules. No manifest file is emitted unless `chunks.manifestFile` or `--chunk-manifest` is explicitly set, and safe nested relative paths are preserved inside `outDir`.

Compatibility stays generic and syntax-driven. The bundler preserves runtime contracts that are discoverable from emitted JavaScript patterns, and the core has no framework-specific special cases. Framework runtime knowledge lives in opt-in React, Svelte, and Vue presets (`gcc-ts-bundler/presets/react`, `gcc-ts-bundler/presets/svelte`, and `gcc-ts-bundler/presets/vue`) that configure two generic mechanisms: `compat.classMapCalls` (object-literal keys that must survive renaming at specific calls) and externs `protocolHelpers` (helpers that read or exclude property keys by string). See `docs/vite.md`.
There is no separate lazy-loading helper package surface; chunked lazy loading is `import()`-driven.

## CLI

Use subcommands:

```sh
gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
gcc-ts-bundler clean-cache --project-root=.
gcc-ts-bundler externs --project-root=. --src-dir=./src --entry=./main.ts --module=lit --module=@lit-labs/router --output-file=./closure-externs/lit.generated.js
```

### Build Flags

- `--project-root`: Project root used to resolve tsconfig.json and relative paths
- `--src-dir`: The source directory
- `--entry`: Entry file relative to `--src-dir`. May be repeated
- `--out-dir`: Output directory for generated JS
- `--language-out`: ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
- `--compilation-level`: WHITESPACE_ONLY | SIMPLE | ADVANCED
- `--packages`: `off | esm-only`
- `--platform-externs`: `minimal | full`. Default `minimal` applies a typed, dependency-closed browser extern slice only to ADVANCED jobs with delivered type metadata, with safe full-browser fallback
- `--extern`: Explicit extern file consumed by Closure and scanned by native for rename barriers. May be repeated
- `--typed-extern`: Closure-only typed external declaration file. May be repeated
- `--js`: Additional Closure JavaScript input. May be repeated
- `--chunks`: `off | split | bundler-runtime`
- `--chunk-public-path`: public URL prefix used to load chunk files
- `--chunk-base-name`: base chunk output name
- `--chunk-manifest`: safe relative path for the generated chunk manifest
- `--cache-mode`: `off | temp | persistent`
- `--cache-dir`: Explicit cache directory
- `--preflight`: `off | errors-only | full`
- `--verbose`: Print diagnostics to the console.
- `-h, --help`: Show this help message.

Only the documented dashed CLI flags are supported. Unknown flags and deprecated underscore or camelCase aliases fail fast.

### Extern Generation Flags

- `--project-root`: Project root used to resolve `node_modules` and `tsconfig.json`
- `--src-dir`: Source directory used to resolve application and runtime entries
- `--entry`: Application entry for boundary-aware usage analysis. May be repeated
- `--runtime-entry`: Runtime JS entry for runtime-aware analysis. May be repeated
- `--module`: Package or package subpath to scan. May be repeated
- `--mode`: `boundary-aware | candidates | runtime-aware`
- `--output-file`: Write generated externs to a file instead of stdout
- `--include-dependencies`: Follow imported declaration files across dependent packages
- `--tsconfig`: Explicit tsconfig path relative to `--project-root`

## Examples

Every example is the **official framework starter, unmodified**, with only
`gccTsBundler()` added to `vite.config.ts`. That is the point: they prove the
plugin works on stock templates rather than on app code shaped to suit it. Each
one also ships `vite.pure.config.ts`, the identical build without the plugin, so
any size or behaviour claim can be reproduced against a plain Vite baseline.

Scaffolded with `npm create vite@latest -- --template <t>` (and `create-vue` for
Vue), then `bun install && bunx vite build`.

Each example's committed `dist/` is the plugin-built output, so the compiled
quality is inspectable in the repo. To run one locally, build then preview so
the server never serves a stale bundle:

```sh
cd examples/react-vite-official
bun run build    # tsc + vite build with gccTsBundler() -> dist/
bun run preview  # serve dist/
```

Or from the repo root, `bun run preview:examples react` (any unique prefix of
an example dir name works) — it builds the package and the example first if
their `dist/` is missing, then starts `vite preview`. The `build:pure` baseline
writes to `dist-pure/` and never touches the plugin-built `dist/`.

- `examples/react-vite-official` — `react-ts` template plus `reactPreset()`.
- `examples/svelte-vite-official` — `svelte-ts` template plus `sveltePreset()`.
- `examples/lit-vite-official` — `lit-ts` template, no preset. Covers decorator
  metadata: `@property count` reaches the runtime as a string literal, so the
  matching field must survive renaming.
- `examples/jquery-vite-official` — `vanilla-ts` template with jQuery installed
  the way the jQuery docs recommend. Carries the extern-generation story:
  jQuery builds part of its own API from strings (`deferred[tuple[0] + "With"]`)
  and reads its handler store back by string key (`dataPriv.get(this,
"events")`), so `runtime-aware` generation plus key-reading protocol helpers
  are what keep the page alive. Every pinned name is exercised by a real click.
- `examples/vue-vapor-vite-official` — `create-vue` template on Vue 3.6 with
  Vapor SFCs plus `vuePreset()`. Covers the template-only SFC ABI, where
  plugin-vue attaches `render` through a string key.

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.
