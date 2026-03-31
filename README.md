# GCC-TS-Bundler

GCC-TS-Bundler is a TypeScript bundler built around Google Closure Compiler. It keeps Closure's aggressive optimization model while moving graph resolution, entry shim emission, TypeScript stripping, and export rewriting into a native Rust front-end for faster builds.

Unlike standard TS bundlers, GCC-TS-Bundler is optimized for Closure's aggressive compilation pipeline. The package now uses a native Rust module for the non-Closure stages and keeps Closure Compiler as the final optimizer. This results in smaller, faster, and more efficient output for performance-critical code.

## Features

- Bundles TypeScript code using Google Closure Compiler with a native Rust front-end.
- Utilizes Closure Compiler's advanced optimizations and dead code elimination.
- Uses native graph resolution, shim emission, and TypeScript stripping.
- Resolves browser-safe ESM dependencies from `node_modules`.
- Generates Closure-ready JS and extern placeholders.
- Renames property names in objects for better performance.
- Radically restructures code for optimal performance.

## Install From NPM using bun

```sh
bun install gcc-ts-bundler
```

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

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

await cleanCache({ projectRoot: process.cwd() });
```

Programmatic options:

- `projectRoot`
- `srcDir`
- `entries`
- `outDir`
- `packages`
- `languageOut`
- `compilationLevel`
- `cache`
- `diagnostics`
- `externs`
- `js`

Defaults:

- `cache.mode = "persistent"`
- `packages.mode = "esm-only"`
- persistent cache lives outside the user project
- `diagnostics.preflight = "errors-only"`

The runtime path uses a native Rust addon for graph resolution, shim emission, and GCC export rewriting. Closure Compiler remains the final aggressive optimizer.

`packages.mode = "esm-only"` supports browser-safe ESM dependencies from `node_modules`. This mode rejects CommonJS packages, Node builtins, JSON modules, and native addons.

## CLI

Use subcommands:

```sh
gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
gcc-ts-bundler clean-cache --project-root=.
```

### Build Flags

- `--project-root`: Project root used to resolve tsconfig.json and relative paths
- `--src-dir`: The source directory
- `--entry`: Entry file relative to `--src-dir`. May be repeated
- `--out-dir`: Output directory for generated JS
- `--language-out`: ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
- `--compilation-level`: WHITESPACE_ONLY | SIMPLE | ADVANCED
- `--packages`: `off | esm-only`
- `--cache-mode`: `off | temp | persistent`
- `--cache-dir`: Explicit cache directory
- `--preflight`: `off | errors-only | full`
- `--fatal-warnings`: Whether typed transpile warnings should be fatal
- `--verbose`: Print diagnostics to the console.
- `-h, --help`: Show this help message.

## Examples

- `examples/lit-playground` is a copied Lit motion playground with its own package and build wrapper.
- `examples/react-spa` is a real React SPA fixture with its own `package.json` and `node_modules`.
- It currently demonstrates a v1 limitation: stock `react` resolves to CommonJS entrypoints, so the build is expected to fail until CommonJS package support is added.

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.
