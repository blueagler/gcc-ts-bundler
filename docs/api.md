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
- Relative `externs`, `js`, and `cache.dir` paths are resolved from `projectRoot`.
- A `tsconfig.json` must be discoverable from `projectRoot`.

### Build options

| Option             | Default           | Meaning                                                                                                                      |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `entries`          | required          | Entry files: a path, or `{ file, name }` with an explicit output filename. At least one is required.                         |
| `projectRoot`      | current directory | Root for configuration, dependencies, and relative paths.                                                                    |
| `srcDir`           | `src`             | Source root used for entry resolution and output-relative module IDs.                                                        |
| `outDir`           | `dist`            | Published output directory. It is replaced on a non-cached compile.                                                          |
| `compilationLevel` | `ADVANCED`        | Closure level: `WHITESPACE_ONLY`, `SIMPLE`, or `ADVANCED`.                                                                   |
| `languageOut`      | `ECMASCRIPT_NEXT` | Closure output syntax: `ECMASCRIPT3`, `ECMASCRIPT5`, `ECMASCRIPT6`, or `ECMASCRIPT_NEXT`.                                    |
| `externs`          | `[]`              | Additional Closure extern files.                                                                                             |
| `js`               | `[]`              | Additional JavaScript inputs passed to Closure jobs.                                                                         |
| `packages`         | `esm-only`        | `esm-only` resolves supported browser package graphs; `off` restricts graph resolution to the materialized source workspace. |

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
  fatalWarnings: false,
  verbose: false,
}
```

- `off` skips TypeScript preflight diagnostics.
- `errors-only` reports only error-category diagnostics.
- `full` also reports warning and suggestion categories collected by preflight.
- `verbose` raises Closure warning output from quiet to verbose.
- `fatalWarnings` is accepted and included in cache identity, but the current native and Closure stages do not promote warnings based on it.

### Chunk options

```ts
chunks: {
  mode: "off",              // "off" | "split" | "bundler-runtime"
  publicPath: "./",
  baseChunkName: "main",
  manifestFile: "",
}
```

Both chunked modes are for browser applications:

- entries must not export values;
- lazy boundaries use native `import("./literal")` syntax;
- chunks are loaded by appending script tags using `publicPath`;
- `manifestFile`, when non-empty, is emitted in `outDir`.

`split` (recommended) compiles every module as one Closure program with
`--chunk`, so eager code keeps flat-build optimization quality: modules are
scope-hoisted, renamed and moved across chunks by the compiler. Dynamic
import is served by a small (~0.6 KB) loader prelude prepended to the base
chunk, and the prelude is omitted entirely when no dynamic import exists.

`bundler-runtime` wraps every module in a runtime registration closure so
chunks can be compiled as separate Closure jobs (parallel, per-chunk
incremental caching) at a significant size cost: expect roughly 20% larger
compressed output than `split` plus a fixed ~2.6 KB runtime.

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

### Candidates mode

List extern candidates from dependency declaration files without requiring application entries.

```ts
const result = await generateExterns({
  mode: "candidates",
  modules: ["some-package/subpath.js"],
  includeDependencies: false,
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

| Option                | Default           | Meaning                                                   |
| --------------------- | ----------------- | --------------------------------------------------------- |
| `modules`             | required          | Package or package-subpath specifiers to inspect.         |
| `mode`                | `boundary-aware`  | `boundary-aware`, `candidates`, or `runtime-aware`.       |
| `appEntryFiles`       | `[]`              | Application entry files used for boundary/usage analysis. |
| `runtimeEntryFiles`   | `[]`              | JavaScript runtime files used by runtime-aware mode.      |
| `includeDependencies` | `true`            | Follow imported declaration files.                        |
| `projectRoot`         | current directory | Root for module and config resolution.                    |
| `srcDir`              | project root      | Base for relative app/runtime entry paths.                |
| `tsConfigPath`        | discovered        | Explicit tsconfig path relative to `projectRoot`.         |
| `outputFile`          | none              | Write to this file; otherwise consume `result.text`.      |

The result contains `mode`, copied `modules`, absolute `scannedFiles`, generated `text`, and an absolute `outputFile` when one was requested.
