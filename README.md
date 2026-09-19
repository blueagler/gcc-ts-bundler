# GCC-TS-Bundler

A TypeScript/JavaScript bundler using a Rust/Oxc front end and Google Closure
Compiler for whole-program optimization and property renaming. Use the core
API or CLI for code-only builds; use the Vite plugin for applications that need
framework transforms, assets, CSS, or `import.meta.glob`.

## Install

```sh
bun install gcc-ts-bundler
```

The core package declares Node.js 18 or newer and loads a platform-specific
native addon from optional dependencies. The optional Vite integration has a
higher Node requirement: Vite 8.3.0 declares `^20.19.0 || >=22.12.0`. Check Vite's
engines when upgrading; the bundler declares the peer range `^8.3.0`.

## Standalone quickstart

Given `src/index.ts` and a project `tsconfig.json`:

```ts
import { build } from "gcc-ts-bundler";

const result = await build({
  entries: ["./index.ts"],
  srcDir: "./src",
  outDir: "./dist",
});

if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    console.error(diagnostic.message);
  }
  process.exitCode = 1;
}
```

Or from the CLI:

```sh
gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
```

**Use a dedicated output directory.** Compilation and cache restoration can
replace its entire contents, including unrelated files. See the
[API contract](docs/reference/api.md#paths) for output ownership, module
boundaries, and error handling; see the [CLI reference](docs/reference/cli.md)
for commands and flags.

## Vite quickstart

```ts
import { defineConfig } from "vite";
import { gccTsBundler } from "gcc-ts-bundler/vite";

export default defineConfig({
  build: { target: "esnext" },
  plugins: [gccTsBundler()],
});
```

Place framework plugins before this build-only plugin. React, Svelte, and Vue
applications should use their [framework preset](docs/reference/vite.md#framework-presets).
Development-server execution remains Vite's. Worker entry graphs, SSR, library
mode, and sourcemaps are outside the supported integration; see
[Vite build constraints](docs/reference/vite.md#supported-build-shape).

## Results and limits

ADVANCED is not a promise of smaller gzip output or faster builds. Compare a
separate plain-Vite build with the plugin build and exercise application
behavior. The opt-in [build report](docs/reference/vite.md#build-report) is an
in-build byte comparison and graph diagnostic—not proof that source is safe
to delete. Cache hits can avoid compilation; changed builds and stable chunk
names are not guaranteed.

The repository includes React, Svelte, Lit, jQuery, and Vue Vapor examples
with plugin and plain-Vite configurations. They are starter-based runtime
examples, not universally untouched templates. Dependency upgrades alone do
not establish that their tracked outputs are reproducible or their browser
behavior has been verified with the upgraded toolchain. See the
[example workflow](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/development/workflows.md#build-and-preview-an-example)
for local reproduction. Historical measurements remain in
[research documents](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/README.md#evidence-and-proposals).

## Working on the bundler

Use the repository's [documentation map](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/README.md)
to choose a guide. [Change routes](https://github.com/blueagler/gcc-ts-bundler/blob/HEAD/docs/development/changes.md)
connect common edits to source owners, failure modes, and focused verification.
Contributor and research documents are repository-only; the installed package
includes the public API, CLI, and Vite references.

## License

[Apache-2.0](LICENSE).
