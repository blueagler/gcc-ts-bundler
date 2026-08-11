# Programmatic API

The root package exports `build`, `cleanCache`, `generateExterns`, `DEFAULT_BUILD_OPTIONS`, and their TypeScript types.

```ts
import {
  build,
  cleanCache,
  generateExterns,
  type BuildOptions,
} from "gcc-ts-bundler";
```

## `build(options)`

```ts
const result = await build({
  entries: ["./index.ts"],
  projectRoot: process.cwd(),
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

### Paths

- `projectRoot` defaults to `process.cwd()`.
- `srcDir` defaults to `<projectRoot>/src`.
- `outDir` defaults to `<projectRoot>/dist`.
- Relative `entries` are resolved from `srcDir`.
- Relative `externs`, `typedExterns`, `js`, `preserveModules`, and `cache.dir` paths are resolved from `projectRoot`.
- `preserveModules` paths are canonicalized before graph resolution. Escaping symlink targets fail closed, and in-tree symlink aliases are also rejected with an explicit policy error.
- A `tsconfig.json` must be discoverable from `projectRoot`.

### Build options

| Option             | Default           | Meaning                                                                                                                      |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `entries`          | required          | Entry files: a path, or `{ file, name }` with an explicit output filename. At least one is required.                         |
| `projectRoot`      | current directory | Root for configuration, dependencies, and relative paths.                                                                    |
| `srcDir`           | `src`             | Source root used for entry resolution and output-relative module IDs.                                                        |
| `outDir`           | `dist`            | Published output directory. It is replaced on a non-cached compile.                                                          |
| `compilationLevel` | `ADVANCED`        | Closure level: `WHITESPACE_ONLY`, `SIMPLE`, or `ADVANCED`.                                                                   |
| `languageOut`      | `ECMASCRIPT_NEXT` | Closure output syntax: `ECMASCRIPT3`, `ECMASCRIPT5`, `ECMASCRIPT6`, `ECMASCRIPT_2015`, `ECMASCRIPT_2016`, `ECMASCRIPT_2017`, `ECMASCRIPT_2018`, `ECMASCRIPT_2019`, `ECMASCRIPT_2020`, `ECMASCRIPT_2021`, `STABLE`, or `ECMASCRIPT_NEXT`. |
| `externals`        | `[]`              | Exact runtime-owned ESM specifiers preserved as real imports. Requires standalone ESM output.                               |
| `preserveModules`  | `[]`              | Authored modules published with stable runtime/API semantics and no optimization or renaming; Oxc minifies comments/whitespace and erases TypeScript types. |
| `externs`          | `[]`              | Explicit externs consumed by Closure and scanned by native as rename-barrier opt-in.                                         |
| `typedExterns`     | `[]`              | Closure-only owner-qualified typed declarations; native preservation never scans these.                                      |
| `js`               | `[]`              | Additional JavaScript inputs passed to Closure jobs.                                                                         |
| `packages`         | `esm-only`        | `esm-only` resolves supported browser package graphs; `off` restricts graph resolution to the materialized source workspace. |
| `platformExterns`  | `minimal`         | Typed ADVANCED browser jobs use a dependency-closed platform slice; server targets use `CUSTOM` plus generated target externs. |
| `target`           | `browser`         | Target policy: `browser`, `node`, `bun`, `workerd`, or `webworker`. Node/Bun builtins become runtime-owned boundaries.       |
| `compat`           | empty rules       | Generic property-renaming rules such as framework class-map calls and pure callees.                                          |

### Cache options

```ts
cache: {
  mode: "persistent", // "off" | "temp" | "persistent"
  dir: "",            // optional explicit cache root
}
```

- `persistent` reuses graph, native emit, Closure job, and final output artifacts across builds.
- `temp` creates and removes an isolated workspace for the build.
- `off` also uses a temporary workspace and disables persistent artifact restoration.

Use `cleanCache()` to remove the cache directory for one project root.

### Diagnostics options

```ts
diagnostics: {
  preflight: "errors-only", // "off" | "errors-only" | "full"
  verbose: false,
}
```

- `off` skips TypeScript preflight diagnostics.
- `errors-only` reports only error-category diagnostics.
- `full` also reports warning and suggestion categories collected by preflight.
- `verbose` raises Closure warning output from quiet to verbose.

### Chunk options

```ts
chunks: {
  mode: "off",              // "off" | "split" | "bundler-runtime"
  outputType: "auto",       // "auto" | "script" | "esm"
  vendorChunk: false,        // false | true | "auto"
  publicPath: "./",
  baseChunkName: "main",
  manifestFile: "",
}
```

Both chunked modes are for browser applications:

- entries must not export values;
- lazy boundaries use native `import("./literal")` syntax;
- `script` output loads chunks by injecting classic `<script>` elements;
- `esm` output loads chunks with native dynamic `import()`;
- chunked standalone `auto` resolves to `esm` unless a language or worker gate forces script; off-mode `auto` resolves to `script`;
- `manifestFile`, when non-empty, is a safe relative path emitted inside `outDir`; absolute paths and `..` escapes are rejected.

`vendorChunk: true` moves eager dependencies into a separate vendor chunk only for `bundler-runtime` with resolved ESM output. `"auto"` and the default `false` leave the entry unsplit. It is a no-op under the Vite plugin: there the chunk plan mirrors Rollup's own chunk graph, which already separates dependency code.

`split` (recommended) compiles every module as one Closure program with
`--chunk`, so eager code keeps flat-build optimization quality: modules are
scope-hoisted, renamed, and moved across chunks by the compiler. Under script
output, dynamic imports use a small loader prelude in the base chunk; under ESM
output, they use native module imports.

`bundler-runtime` emits runtime registration for modules that cannot be
scope-hoisted and compiles the planned chunk graph in one Closure job. Its
runtime injects classic scripts for `script` output and calls dynamic `import()`
for ESM output.

Off mode emits importable entry bundles and can produce a shared chunk for common code.

### Build result

```ts
interface BuildDiagnostic {
  file?: string;
  line?: number;
  message: string;
}

type BuildResult =
  | { ok: true; cacheHit: boolean; outputFiles: readonly string[] }
  | { ok: false; diagnostics: readonly BuildDiagnostic[] };
```

- `ok` discriminates success from failure; there is no exit code in the API.
- `outputFiles` contains absolute published paths.
- `cacheHit` means a final cached result was restored or reused.
- Diagnostics are flattened messages with an optional file and 1-based line.
- Expected compiler and graph failures are returned as `ok: false`. Invalid option normalization can reject the promise, so callers should still use normal promise error handling.

## `cleanCache(options)`

```ts
await cleanCache({
  projectRoot: process.cwd(),
  // cacheDir: "./custom-cache",
});
```

`projectRoot` defaults to the current directory. `cacheDir` selects the cache root; otherwise the platform default is used. Only the hashed cache directory for that project is removed.

## `generateExterns(options)`

Extern generation protects JavaScript property contracts that Closure cannot infer safely across package or runtime boundaries.

### Boundary-aware mode

Use dependency declarations plus actual application usage. `appEntryFiles` is required.

```ts
const result = await generateExterns({
  mode: "boundary-aware",
  modules: ["lit"],
  appEntryFiles: ["./main.ts"],
  projectRoot: process.cwd(),
  srcDir: "./src",
  outputFile: "./closure-externs/lit.generated.js",
});
```

### Runtime-aware mode

Analyze emitted/runtime JavaScript contracts. `runtimeEntryFiles` is required; application entries are optional and can narrow usage.

```ts
const result = await generateExterns({
  mode: "runtime-aware",
  modules: ["some-runtime"],
  runtimeEntryFiles: ["./node_modules/some-runtime/index.js"],
  appEntryFiles: ["./main.ts"],
  projectRoot: process.cwd(),
  srcDir: "./src",
});
```

### Extern options and result

| Option                | Default           | Meaning                                                                                                    |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `modules`             | required          | Strings mean compiled runtime; `{ specifier, runtime: "external" }` opts into typed external declarations. |
| `mode`                | `boundary-aware`  | `boundary-aware` or `runtime-aware`.                                                                       |
| `appEntryFiles`       | `[]`              | Application entry files used for boundary/usage analysis.                                                  |
| `runtimeEntryFiles`   | `[]`              | JavaScript runtime files used by runtime-aware mode.                                                       |
| `includeDependencies` | `true`            | Follow imported declaration files.                                                                         |
| `projectRoot`         | current directory | Root for module and config resolution.                                                                     |
| `srcDir`              | project root      | Base for relative app/runtime entry paths.                                                                 |
| `tsConfigPath`        | discovered        | Explicit tsconfig path relative to `projectRoot`.                                                          |
| `outputFile`          | none              | Rename-barrier artifact path.                                                                              |
| `typedOutputFile`     | external-module sibling | Closure-only typed declaration artifact path; omitted for compiled-only module lists.                      |

The result carries the barrier accounting:

| Field | Meaning |
| --- | --- |
| `renameBarriers.propertyNames` | Every property name pinned program-wide, across **both** artifacts. |
| `typedDeclarations.propertyNames` | The typed artifact's share of that set. |
| `barrierWarnings` | Non-fatal cost signals for any artifact above 200 barriers, naming the top contributing declaration packages. |

### Barrier cost

An `Object.prototype.X;` line is a *global* barrier: `X` leaves Closure's
renaming **and** disambiguation candidate sets for every owner type in the
program, including your own. Both surviving modes derive their barriers from
evidence — application usage or emitted runtime code — for that reason.

A mode that pinned every member of every reachable declaration
(`candidates`) was removed. Evidence-derived sets keep ordinary application
properties available to Closure while preserving proven boundary names.

If a package's API is assembled from strings at runtime, that is a
`runtime-aware` job: it sees constructed keys, including the
`deferred[tuple[0] + "With"]` form that a declaration scan cannot see at all.

Typed declarations are rename barriers too: an owner-qualified
`T.prototype.P` and a record key `{"P": …}` both put `P` into Closure's extern
property set exactly like `Object.prototype.P` does. They are counted here for
that reason. Explicit extern files passed to `build({ externs })` are audited
on the same threshold.

The result routes two artifacts independently:

- `renameBarriers` (`text`, `outputFile`, `propertyNames`) contains only proven runtime rename hazards. Pass its file through `build.externs`;
- `typedDeclarations` (`text`, `outputFile`, `moduleExports`) contains owner-qualified declarations for structured external runtimes. Pass its file through `build.typedExterns`, never `build.externs`.

Each `moduleExports` entry also carries a `runtimeBridge` snippet. Compile that snippet through `build.js` only when the runtime is genuinely external and the host already supplies `__gccExternalRuntimeLoad(specifier)`. The bundler does not invent an external loader. Legacy string `modules` remain compiled runtime and do not produce typed external declarations.

Explicit user `build.externs` files keep their historical ambiguous semantics: Closure consumes them and native scans their property declarations as an intentional preservation opt-in. Use `build.typedExterns` for typed declarations that must not become native/global rename barriers.
