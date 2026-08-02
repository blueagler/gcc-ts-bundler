# Architecture

`gcc-ts-bundler` is a Node package with three cooperating compiler layers:

1. **TypeScript/JavaScript orchestration** resolves options, manages workspaces and caches, performs type-aware analysis, invokes Closure Compiler, and publishes outputs.
2. **The Rust native addon** resolves module graphs, parses and rewrites modules with Oxc, plans chunks, transpiles sources, generates Closure inputs, and performs output rewrites.
3. **Google Closure Compiler** performs the final optimization and property renaming pass.

The Vite plugin is an adapter around the same core build pipeline rather than a separate compiler.

## Build boundary

The standalone/native CLI and programmatic API support **BASIC** builds only: TypeScript to optimized JavaScript, chunks, and externs, with future Node/Bun target basics. They do not handle worker graphs, WebAssembly, or asset transforms. Advanced features such as workers, WebAssembly, assets, `import.meta.glob`, and CSS are Vite-owned: Vite performs those transforms, and the Vite plugin passes the resulting JavaScript to `gcc-ts-bundler` for optimization without breaking Vite behavior; [`test/vite-feature-matrix.test.mjs`](../test/vite-feature-matrix.test.mjs) is that contract. `?worker` and `?worker&inline` are a planned Vite-plugin milestone that will materialize Vite's wrapper module onto the existing URL-form worker-chunk path; they are not part of the standalone pipeline.

Runtime data crossing filesystem, native-addon, compiler-package, or generated-manifest boundaries is parsed as `unknown` and narrowed with explicit validators. Internal TypeScript is compiled with exact optional properties and unchecked index protection; linting rejects `any`, type assertions, non-null assertions, and unsafe `any` propagation.

## Package boundaries

| Area                  | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/api`             | Public API surface and build result types                                                 |
| `src/externs`         | Extern generation                                                                         |
| `src/build`           | Option normalization, graph resolution, cache keys, stage coordination                    |
| `src/build/transpile` | TypeScript preflight, Closure IR metadata, native transpilation stage                     |
| `src/build/closure`   | Closure job execution, job caching, postprocessing, output publication                    |
| `src/vite`            | Vite graph capture, materialization, dependency prebundling, CSS/HTML integration         |
| `src/native`          | Platform binding loader and typed JavaScript wrappers around N-API                        |
| `native/src`          | Rust graph resolver, chunk planner, Oxc transforms, extern emission, Closure job planning |
| `closure-externs`     | Extra browser, CommonJS, worker, Closure, and tslib externs                               |
| `closure-lib`         | Closure support library shipped with the package                                          |

## Core build flow

A call to `build()` follows this path:

```text
BuildOptions
  -> normalize paths and defaults
  -> create cache/workspace
  -> resolve module graph and entry exports (Rust)
  -> plan off-mode or bundler-runtime chunks (Rust)
  -> run TypeScript preflight and collect Closure IR
  -> transpile TS/JS/CommonJS into Closure-ready JS (Rust + Oxc)
  -> generate native property externs
  -> prepare Closure compile jobs (Rust)
  -> run Google Closure Compiler
  -> convert the export bag to ESM, wrap chunks, publish
  -> publish output files and cache metadata
```

### 1. Normalize and create a workspace

`normalizeBuildOptions()` resolves `projectRoot`, `srcDir`, `outDir`, extern paths, and extra JavaScript inputs. A build workspace exposes the source tree as `workspace/src`; when `packages` is `esm-only`, the project `node_modules` directory is exposed in the workspace too.

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

There are three output models:

- **`chunks.mode = "off"`** creates Closure entry shims and emits importable entry bundles. Multiple entries may produce shared chunks.
- **`chunks.mode = "split"`** compiles one Closure chunk graph, preserving cross-module optimization while supporting literal lazy imports.
- **`chunks.mode = "bundler-runtime"`** treats entries as application bootstraps and compiles chunks as separate cacheable jobs. Entry exports are rejected because this mode does not produce library entry modules.

Dynamic import specifiers must be string literals. Dynamic imports are rejected when chunk mode is off. Chunked builds can emit classic script chunks loaded through the runtime or ESM chunks loaded with native `import()`, according to `chunks.outputType`.

`chunks.outputType: "auto"` (the default) resolves to **`"esm"`**. Measured on
the Svelte example, module output is 120,762 -> 115,049 bytes raw and
41,015 -> 40,262 gzipped, purely from dropping the per-chunk IIFE wrapper and
the `$gcc.` prefix on every cross-chunk reference. The gates still outrank the
default: `chunks.mode` other than `bundler-runtime`, `ECMASCRIPT3`/`ECMASCRIPT5`
output, and worker bundles all force `"script"`. A standalone consumer of a
module-output build must load the entry with `<script type="module">`; the Vite
plugin emits the right tag itself.

#### Bundler-runtime hoisted linking

Bundler-runtime modules are scope-hoisted per chunk: each module's top-level
bindings are renamed with a per-module ordinal suffix (`name$$12`) and
emitted as plain statements inside the chunk wrapper, so same-chunk imports
become direct identifier references that Closure can rename, inline, and
tree-shake across module boundaries. Only three things still go through the
`__register`/`__require` registry:

- cross-chunk imports (via small export facades pruned to the slots that are
  actually consumed anywhere in the program);
- dynamic-import targets (full facades, since namespaces are read
  member-by-member through the target slot table);
- registry-form modules that opt out of hoisting (typed metadata such as
  enums/typedefs, CommonJS modules with dependencies, or unresolvable
  graphs).

Cross-chunk top-level symbols created by Closure itself (polyfills, ES5
transpile helpers, cross-chunk code motion) are made safe under the per-file
IIFE wrappers with `--rename_prefix_namespace=$gcc`; every chunk declares
`var $gcc=globalThis.$gcc=globalThis.$gcc||{}` inside its wrapper. Hoisted
module code lives inside the chunk wrapper function, so it never pays the
`$gcc.` prefix.

### 4. Analyze types and transpile

The JavaScript layer uses one TypeScript checker/extractor for standalone and Vite. It serializes tokenized binding/member annotations, declarations, enums, canonical symbol identities, provenance, and non-fatal degradation diagnostics through `closure-ir.json`. Plain JavaScript files can take a faster scan path when no semantic work is needed.

Rust resolves that metadata against the final Oxc/import/hoist plan, transforms files in parallel, and returns exact delivered counts and diagnostics per emitted JavaScript file. The same stage strips TypeScript, lowers JSX where needed, normalizes supported CommonJS, rewrites imports/exports, emits support files, and generates proven property rename barriers.

Three things that used to be patched into Closure's *output* are decided here
instead, because this is the last point at which the provenance they need still
exists:

- **Lowering helpers.** TypeScript inlines `__esDecorate`, `__runInitializers`,
  `__classPrivateFieldGet` and friends into every file that needs them. Emission
  renames each such declaration to a *content-addressed* name
  (`__esDecorate$$h<hash of the body>`) instead of an ordinal-suffixed one and
  hands it to the driver, which emits one copy into the first file of the first
  chunk. Copies collapse only when their bodies are byte-identical, so an
  application function that merely shares a helper's name keeps its own body.
- **Reflective property keys.** A string literal compared against a `for...in`
  binding, or listed in a filter list tested against one, is a property name
  read as data. Those names go into the preserved-property channel, so Closure
  never renames them and no literal ever has to be respelled afterwards.
  Decorator metadata keys (`__esDecorate`'s `{name: "..."}` context) are
  preserved the same way.
- **Framework bundler directives.** `"use client"` / `"use server"` in the
  directive prologue are instructions to an RSC-aware bundler and are dropped;
  terminal browser output has no use for them.

Postprocessing after Closure is therefore limited to delivery shape. Each
remaining rule carries a match count and fails the build when its input says the
rule should have fired and it did not, so a rule cannot silently become a no-op.

### 5. Compile and postprocess

Rust prepares explicit Closure jobs and aggregates delivered metadata counts over each job's real native inputs. The JavaScript layer enables silent `checkTypes` inference and the typed platform extern slice only for ADVANCED jobs whose aggregate is non-empty, unless `GCC_DISABLE_TYPE_INFERENCE=1`, then invokes the installed `google-closure-compiler` package.

Off mode runs Closure serially, split mode compiles one Closure chunk graph, and bundler-runtime mode may compile independent jobs concurrently while caching each job separately. Postprocessing then:

- converts Closure wrapper exports back into ESM exports in off mode;
- wraps application chunks for the resolved script/ESM loading model and publishes the requested manifest when enabled;
- prunes chunks that survived the plan but carry no code.

### Runtime capability gating

The runtime preamble is Closure *input*, but every block hangs off the global
`__g` object, so Closure can never prove one dead. Which blocks are emitted is
therefore decided when the preamble is rendered, from the plan and the
assembled module text:

| Block | Emitted when |
| ----- | ------------ |
| `<link>` stylesheet loader + per-chunk CSS fan-out (`z`) | a manifest CSS row can exist |
| preload (`r.x`) | some module calls `__preloadDynamicImport` |
| entry runner (`r.n`) | some entry module stays in registry form |
| live-export helper (`r.g`) | some module calls `__live` |
| script URL resolution (`u`) and `<script>` injection (`p`) | script output |

Each answer is a fail-closed over-approximation: a call site anywhere in the
plan keeps the block. Standalone builds never fill a CSS row, so the CSS half
is always gated out there; the Vite plugin fills rows *after* the compile and
passes its pre-compile CSS-ownership answer in, because that is the only point
where the question can still be answered. A no-CSS ESM app drops from 2,126 to
1,007 bytes of loader code.

### Empty-chunk pruning

The planner creates a shared chunk whenever two lazy roots reach the same
module. Closure's cross-chunk code motion can then hoist every module out of
it, leaving an output file that is only scaffolding: the generated `import`
edges and the loader's "this chunk finished" call. Those chunks are dropped
after the final JavaScript exists - the file is deleted, importers lose the
`import`, the manifest row is emptied and dependency arrays and the
module-to-chunk table are rewritten onto the surviving chunk. Dynamic-import
roots are never pruned: `import()` still has to resolve to them. The row is
emptied rather than spliced out because chunk ids are dense array indices baked
into every surviving chunk's completion call.

## Persistent cache

The default persistent cache is outside the project:

| Platform | Default root                                                  |
| -------- | ------------------------------------------------------------- |
| macOS    | `~/Library/Caches/gcc-ts-bundler`                             |
| Windows  | `%LOCALAPPDATA%/gcc-ts-bundler`                               |
| Linux    | `$XDG_CACHE_HOME/gcc-ts-bundler` or `~/.cache/gcc-ts-bundler` |

Each project gets a directory keyed by its absolute `projectRoot`. The main cache layers are:

1. **Resolve snapshot** — graph, entries, lazy imports, tracked file state.
2. **Native emit** — transpiled Closure inputs, serialized metadata, delivered per-file counts/diagnostics, rename barriers, dependency-content snapshots, and support files.
3. **Closure jobs** — compiler artifacts keyed per job, compiler version, delivered counts, inference decision, platform environment, JS, and extern content.
4. **Final metadata** — immutable cached outputs plus type/declaration dependency identities that can repopulate a deleted `outDir`.
5. **Final-fast snapshot** — returns immediately only when options, metadata/provenance dependencies, package/runtime signatures, and published outputs still match.

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
  -> collect unified source/declaration metadata with exact runtime provenance
  -> call core build() in bundler-runtime mode with that sidecar
  -> merge Vite CSS ownership into the runtime manifest
  -> apply Vite output naming
  -> replace Rollup JS and rewrite HTML entry scripts
```

Vite remains responsible for framework compilation, asset handling, CSS generation, and deciding which modules survive tree shaking. The core compiler receives the transformed, retained JavaScript graph with package resolution disabled because dependencies have already been materialized. Probe-backed matrix coverage shows that transform-stage, virtual-module, and CSS plugins compose with this boundary, while post-transform and `renderChunk` postprocessors cannot observe Closure-replaced output by design.

See [Vite integration](vite.md) for supported configuration and limitations.
