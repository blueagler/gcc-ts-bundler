# GCC-TS-Bundler

GCC-TS-Bundler is a unique tool that bundles TypeScript code using Google Closure Compiler and Tsickle. It stands out by leveraging Closure Compiler's advanced optimizations and dead code elimination, which are further enhanced by relying on TypeScript types. This tool is particularly notable for its ability to rename property names in objects and radically change the structure of your code, leading to significant performance improvements.

Unlike other compilers, GCC-TS-Bundler integrates deeply with Closure Compiler to provide advanced optimizations that are not possible with standard TypeScript compilers. It uses Tsickle to convert TypeScript to Closure-compatible JavaScript, allowing for more aggressive optimizations. This results in smaller, faster, and more efficient code, making it an excellent choice for performance-critical applications.

## Features

- Bundles TypeScript code using Google Closure Compiler and Tsickle.
- Utilizes Closure Compiler's advanced optimizations and dead code elimination.
- Enhances optimizations by relying on TypeScript types.
- Generates externs for Closure Compiler.
- Renames property names in objects for better performance.
- Radically restructures code for optimal performance.

## Install From NPM using bun

```sh
bun install gcc-ts-bundler
```

## vNext API

The package now exposes a stage-based programmatic API in addition to the CLI:

```ts
import {
  build,
  cleanCache,
  normalizeBuildOptions,
  resolveBuild,
} from "gcc-ts-bundler";

const result = await build({
  entries: ["./index.ts"],
  outDir: "./dist",
  projectRoot: process.cwd(),
  srcDir: "./src",
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

const resolved = await resolveBuild(
  normalizeBuildOptions({
    entries: ["./index.ts"],
  }),
);

await cleanCache({ projectRoot: process.cwd() });
```

Programmatic options use the vNext shape:

- `projectRoot`
- `srcDir`
- `entries`
- `outDir`
- `languageOut`
- `compilationLevel`
- `cache`
- `diagnostics`
- `postProcess`
- `externs`
- `js`

Defaults:

- `cache.mode = "persistent"`
- persistent cache lives outside the user project
- `diagnostics.preflight = "errors-only"`
- `postProcess.rewriteExports = true`
- `postProcess.minify = false`

The CLI now prefers kebab-case flags and still accepts the old snake_case aliases for one transition release.

### GCC-TS-Bundler Flags

- `--project-root`: Project root used to resolve tsconfig.json and relative paths
- `--src-dir`: The source directory
- `--entry`: Entry file relative to `--src-dir`. May be repeated
- `--out-dir`: Output directory for generated JS
- `--language-out`: ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
- `--compilation-level`: WHITESPACE_ONLY | SIMPLE | ADVANCED
- `--cache-mode`: `off | temp | persistent`
- `--cache-dir`: Explicit cache directory
- `--preflight`: `off | errors-only | full`
- `--post-minify`: `false | swc`
- `--fatal-warnings`: Whether warnings should be fatal, causing tsickle to return a non-zero exit code
- `--verbose`: Print diagnostics to the console.
- `-h, --help`: Show this help message.

### Example

```sh
gcc-ts-bundler --project-root=. --src-dir='./src' --entry='./index.ts' --out-dir='./dist'
```

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.
