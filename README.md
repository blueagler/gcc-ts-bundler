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

## Install From NPM using bun

```sh
bun install gcc-ts-bundler
```

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
- `diagnostics`
- `externs`
- `js`

Defaults:

- `cache.mode = "persistent"`
- `chunks.mode = "off"`
- `chunks.manifestFile` is off by default
- `packages.mode = "esm-only"`
- persistent cache lives outside the user project
- `diagnostics.preflight = "errors-only"`

The runtime path uses a native Rust addon for graph resolution, shim emission, and GCC export rewriting. Closure Compiler remains the final aggressive optimizer.

`packages.mode = "esm-only"` supports browser-safe ESM dependencies from `node_modules`, plus statically analyzable CommonJS package entrypoints and internal package modules. Dynamic `require()`, Node builtins, JSON modules, and native addons are still rejected.

`chunks.mode = "bundler-runtime"` switches output to app-oriented script chunks owned by `gcc-ts-bundler`. In that mode entries are treated as bootstrap scripts, not exported library bundles.

Use native `import()` for explicit lazy loading:

```ts
const loadFeature = () => import("./feature");
```

The specifier must be a string literal. In chunk mode the bundler rewrites lazy imports to its internal chunk-loader runtime. No manifest file is emitted unless `chunks.manifestFile` or `--chunk-manifest` is explicitly set.

Compatibility stays generic and syntax-driven. The bundler preserves runtime contracts that are discoverable from emitted JavaScript patterns, but it does not expose framework-specific helper APIs or package-name-based special cases.
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
- `--extern`: Closure extern file. May be repeated
- `--js`: Additional Closure JavaScript input. May be repeated
- `--chunks`: `off | bundler-runtime`
- `--chunk-loader`: `script`
- `--chunk-public-path`: public URL prefix used to load chunk files
- `--chunk-base-name`: base chunk output name
- `--chunk-manifest`: output filename for the generated chunk manifest
- `--cache-mode`: `off | temp | persistent`
- `--cache-dir`: Explicit cache directory
- `--preflight`: `off | errors-only | full`
- `--fatal-warnings`: Whether typed transpile warnings should be fatal
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

- `examples/lit-playground` is a copied Lit motion playground with its own package and build wrapper.
- `examples/react-spa` is a real React 19 SPA fixture with its own `package.json` and `node_modules`.
- `examples/lazy-chunks-demo` is a minimal browser fixture that uses native `import()` to lazy load a feature chunk.
- `examples/jquery-externs-demo` is a small browser fixture that uses `jquery` and `@types/jquery` to exercise boundary-aware extern generation.
- `examples/svelte-spa` uses the latest Svelte compiler, then prebundles the Svelte runtime with `esbuild` before running the result through gcc-ts-bundler.
- `examples/vue-vapor-spa` precompiles `.vue` single-file components through `vue/compiler-sfc` with Vapor mode enabled, then runs the generated ESM through gcc-ts-bundler with lazy async panels.

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.
