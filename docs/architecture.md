# Architecture

`gcc-ts-bundler` is a Node package with three cooperating compiler layers:

1. **TypeScript/JavaScript orchestration** resolves options, manages workspaces and caches, performs type-aware analysis, invokes Closure Compiler, and publishes outputs.
2. **The Rust native addon** resolves module graphs, parses and rewrites modules with SWC, plans chunks, transpiles sources, generates Closure inputs, and performs output rewrites.
3. **Google Closure Compiler** performs the final optimization and property renaming pass.

The Vite plugin is an adapter around the same core build pipeline rather than a separate compiler.

Runtime data crossing filesystem, native-addon, compiler-package, or generated-manifest boundaries is parsed as `unknown` and narrowed with explicit validators. Internal TypeScript is compiled with exact optional properties and unchecked index protection; linting rejects `any`, type assertions, non-null assertions, and unsafe `any` propagation.

## Package boundaries

| Area                 | Responsibility                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `src/api`            | Public API, build result types, extern generation                                         |
| `src/pipeline`       | Option normalization, graph resolution orchestration, cache keys, stage coordination      |
| `src/stages/native`  | TypeScript preflight and Closure IR metadata before native transpilation                  |
| `src/stages/closure` | Closure job execution, job caching, postprocessing, output publication                    |
| `src/vite`           | Vite graph capture, materialization, dependency prebundling, CSS/HTML integration         |
| `src/native`         | Platform binding loader and typed JavaScript wrappers around N-API                        |
| `native/src`         | Rust graph resolver, chunk planner, SWC transforms, extern emission, Closure job planning |
| `closure-externs`    | Extra browser, CommonJS, worker, Closure, and tslib externs                               |
| `closure-lib`        | Closure support library shipped with the package                                          |

## Core build flow

A call to `build()` follows this path:

```text
BuildOptions
  -> normalize paths and defaults
  -> create cache/workspace
  -> resolve module graph and entry exports (Rust)
  -> plan off-mode or bundler-runtime chunks (Rust)
  -> run TypeScript preflight and collect Closure IR
  -> transpile TS/JS/CommonJS into Closure-ready JS (Rust + SWC)
  -> generate native property externs
  -> prepare Closure compile jobs (Rust)
  -> run Google Closure Compiler
  -> rewrite exports, decorator metadata, and ES5 runtime helpers
  -> publish output files and cache metadata
```

### 1. Normalize and create a workspace

`normalizeBuildOptions()` resolves `projectRoot`, `srcDir`, `outDir`, extern paths, and extra JavaScript inputs. A build workspace exposes the source tree as `workspace/src`; when `packages.mode` is `esm-only`, the project `node_modules` directory is exposed in the workspace too.

A `tsconfig.json` must be discoverable from `projectRoot`.

### 2. Resolve the graph

The native graph resolver starts at every entry and returns:

- source files and dependency edges;
- entry export metadata;
- literal dynamic imports;
- package aliases and package metadata used during transpilation;
- hashes and tracked files used by persistent caching.

Package resolution supports browser-safe ESM and statically analyzable CommonJS. Dynamic `require()`, Node builtins, JSON modules, and native addons are intentionally outside the supported browser graph.

### 3. Plan outputs

There are two output models:

- **`chunks.mode = "off"`** creates Closure entry shims and emits importable entry bundles. Multiple entries may produce shared chunks.
- **`chunks.mode = "bundler-runtime"`** treats entries as application bootstraps and converts literal `import()` calls into an internal script-chunk runtime. Entry exports are rejected because this mode does not produce library entry modules.

Dynamic import specifiers must be string literals. Dynamic imports are rejected when chunk mode is off.

### 4. Analyze types and transpile

The JavaScript layer uses the TypeScript compiler API for diagnostics and for Closure metadata that needs semantic information, including type declarations, JSDoc, enums, and decorators. Plain JavaScript files can take a faster scan path when no semantic work is needed.

The Rust layer then transforms files in parallel with SWC. It strips TypeScript, lowers JSX where needed, normalizes supported CommonJS, rewrites imports/exports for the selected output model, emits support files, and generates property externs.

### 5. Compile and postprocess

Rust prepares explicit Closure jobs and postprocess actions. The JavaScript layer invokes the installed `google-closure-compiler` package, preferring its native compiler binary when available.

Off mode runs Closure serially. Bundler-runtime mode may compile independent jobs concurrently and caches each Closure job separately. Postprocessing then:

- converts Closure wrapper exports back into ESM exports in off mode;
- rewrites decorator metadata using the property-renaming report;
- shares ES5 helper code across runtime chunks;
- wraps application chunks and publishes the requested manifest when enabled.

## Persistent cache

The default persistent cache is outside the project:

| Platform | Default root                                                  |
| -------- | ------------------------------------------------------------- |
| macOS    | `~/Library/Caches/gcc-ts-bundler`                             |
| Windows  | `%LOCALAPPDATA%/gcc-ts-bundler`                               |
| Linux    | `$XDG_CACHE_HOME/gcc-ts-bundler` or `~/.cache/gcc-ts-bundler` |

Each project gets a directory keyed by its absolute `projectRoot`. The main cache layers are:

1. **Resolve snapshot** — graph, entries, lazy imports, tracked file state.
2. **Native emit** — transpiled Closure inputs, metadata, externs, and support files.
3. **Closure jobs** — compiler artifacts keyed per job and compiler version.
4. **Final metadata** — immutable cached outputs that can repopulate a deleted `outDir`.
5. **Final-fast snapshot** — returns immediately when options, inputs, package/runtime signatures, and published output sizes still match.

`cache.mode = "temp"` uses an isolated temporary workspace and does not reuse data across builds. `cache.mode = "off"` also uses a temporary workspace and disables compiler artifact restoration.

## Vite adapter flow

During `vite build`, `gccTsBundler()` runs as a post plugin:

```text
Vite transforms modules
  -> plugin captures transformed JS-like modules
  -> Rollup creates its final retained graph
  -> plugin keeps only retained modules
  -> normalize and materialize the graph on disk
  -> prebundle dependency regions with Vite's esbuild
  -> call core build() in bundler-runtime mode
  -> merge Vite CSS ownership into the runtime manifest
  -> apply Vite output naming
  -> replace Rollup JS and rewrite HTML entry scripts
```

Vite remains responsible for framework compilation, asset handling, CSS generation, and deciding which modules survive tree shaking. The core compiler receives the transformed, retained JavaScript graph with package resolution disabled because dependencies have already been materialized.

See [Vite integration](vite.md) for supported configuration and limitations.
