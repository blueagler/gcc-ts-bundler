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
- Relative `outFile` values are resolved from `projectRoot`. Off-mode publication rewrites the entry's relative imports at the destination. If the destination is outside `outDir`, the original entry inside `outDir` is removed; an additional destination inside `outDir` retains the original.
- Relative `externs`, `typedExterns`, `js`, `preserveModules`, and `cache.dir` paths are resolved from `projectRoot`.
- `preserveModules` paths are canonicalized before graph resolution. Escaping symlink targets fail closed, and in-tree symlink aliases are also rejected with an explicit policy error.
- A `tsconfig.json` must be discoverable from `projectRoot`.

**Output ownership:** dedicate `outDir` to this build. Both compilation and
final-cache restoration can replace the entire directory, deleting unrelated
files. `cacheHit: true` does not mean the filesystem was left untouched.

The build rejects destinations that could overwrite its inputs or cache.
`outDir` cannot contain project/source roots or resolved input files, overlap
the selected cache workspace, or sit inside the selected cache root.
An entry's `outFile` cannot be inside `srcDir`, contain a protected input or
`outDir`, overlap the selected cache/workspace, or collide with another
entry destination or generated output. Checks resolve existing symlink
ancestors rather than trusting lexical paths alone.

Final JavaScript bytes, cache metadata, destination mappings, and relocated
entry imports are prepared before publication. The cache tree, `outDir`, and
each external `outFile` are then committed separately—not as one
whole-filesystem transaction. A publication or cleanup failure can therefore
return failure after an earlier destination has changed. Do not treat
`ok: false` as a guarantee that every previous output remains untouched.

Owned staging trees reject escaping, duplicate, and file/directory-conflicting
artifact paths, as well as symlinks at the selected root or along an artifact's
inner/leaf path. Symlinked ancestors (for example, a linked checkout or
temporary-directory parent) are allowed. These checks are not a sandbox
against hostile concurrent filesystem mutation.

### Build options

| Option             | Default           | Meaning                                                                                                                                                                                                                                  |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries`          | required          | Entry files: a path, or `{ file, name, outFile }` with an explicit `outDir` filename and optional project-root-relative published path. At least one is required.                                                                        |
| `projectRoot`      | current directory | Root for configuration, dependencies, and relative paths.                                                                                                                                                                                |
| `srcDir`           | `src`             | Source root used for entry resolution and output-relative module IDs.                                                                                                                                                                    |
| `outDir`           | `dist`            | Bundler-owned output directory; compilation and final-cache restoration can replace its entire contents.                                                                                                                                 |
| `compilationLevel` | `ADVANCED`        | Closure level: `WHITESPACE_ONLY`, `SIMPLE`, or `ADVANCED`.                                                                                                                                                                               |
| `languageOut`      | `ECMASCRIPT_NEXT` | Closure output syntax: `ECMASCRIPT3`, `ECMASCRIPT5`, `ECMASCRIPT6`, `ECMASCRIPT_2015`, `ECMASCRIPT_2016`, `ECMASCRIPT_2017`, `ECMASCRIPT_2018`, `ECMASCRIPT_2019`, `ECMASCRIPT_2020`, `ECMASCRIPT_2021`, `STABLE`, or `ECMASCRIPT_NEXT`. |
| `externals`        | `[]`              | Exact runtime-owned ESM specifiers preserved as real imports. Requires `chunks.mode: "off"` and ESM output.                                                                                                                              |
| `preserveModules`  | `[]`              | Authored modules published without optimization or identifier renaming. Requires ESM output; comments/whitespace are minified and TypeScript types erased.                                                                               |
| `externs`          | `[]`              | Explicit externs consumed by Closure and scanned by native as rename-barrier opt-in.                                                                                                                                                     |
| `typedExterns`     | `[]`              | Closure-only owner-qualified typed declarations; native preservation never scans these.                                                                                                                                                  |
| `js`               | `[]`              | Additional JavaScript inputs passed to Closure jobs.                                                                                                                                                                                     |
| `packages`         | `esm-only`        | `esm-only` resolves supported browser package graphs; `off` restricts graph resolution to the materialized source workspace.                                                                                                             |
| `platformExterns`  | `minimal`         | Browser extern policy; see [platform externs](#platform-externs). Non-browser targets use their target-specific environment.                                                                                                             |
| `target`           | `browser`         | Target policy: `browser`, `node`, `bun`, `workerd`, or `webworker`. Node/Bun builtins become runtime-owned boundaries.                                                                                                                   |
| `compat`           | empty rules       | Generic property-renaming rules such as framework class-map calls and pure callees.                                                                                                                                                      |

`DEFAULT_BUILD_OPTIONS` is a deeply frozen defaults object, not a complete
build request: supply non-empty `entries`. Spreading it and supplying the
same entries/options has the same behavior as omitting those defaulted
fields, including current-directory `projectRoot`, warning suppression, and
automatic chunk output selection. Do not mutate its nested objects or arrays.

### Scoped typed declarations

A string in `typedExterns` remains a contract for every Closure job. To attach
a typed artifact to particular source entries, use
`{ path: "./generated/types.js", entries: ["./src/main.ts"] }`.
Both paths resolve from `projectRoot`, unlike `build.entries`, which resolves
from `srcDir`. A scope must be nonempty and name configured source entries.

A connected job receives the union of its entries' contracts. Independent
jobs omit contracts scoped only to other entries. Repeated paths union their
scopes; an unscoped occurrence keeps the file global. Explicit `externs` and
native preservation contracts are never narrowed by this selection. Scope
and file contents participate in cache identity.

Vite scopes use original source entries, not materialized or prebundled
filenames. Entry provenance survives prebundling; a fused non-entry module
does not become a valid entry merely because it contributed code.

### Module boundaries

`packages: "esm-only"` resolves browser-safe ESM and statically analyzable
CommonJS package modules. Browser builds reject Node builtins; Node/Bun builds
can preserve builtins and configured `externals` as runtime imports in
off-mode ESM output.

Off-mode compiled imports and re-exports follow the resolved module graph,
including mutable exported bindings; imported values are not merely
initialization-time copies. Source files that would collapse to the same
module identity or emitted JavaScript path are rejected before emission
rather than silently overwriting one another.

Dynamic `require()` is rejected in compiled modules and is permitted in
preserved modules. Preservation starts from `preserveModules` and includes
their transitive static dependencies. Configured paths must be inside
`srcDir` and reachable from an entry; dynamic imports targeting a preserved
module and cycles mixing preserved seeds with compiled modules are rejected.
Use static ESM imports for that boundary.

Preserved modules retain their runtime API, not their original source bytes;
the path and symlink restrictions above still apply. JSON modules and native
addons are not supported in the compiled graph.

Separately compiled bundles do not share a property-renaming map. If they
exchange structured objects, declare that boundary in an explicit `externs`
file rather than relying on incidental matching names. All chunks within one
chunked build are compiled together; the same cross-job issue does not apply
inside that build.

### Platform externs

`platformExterns: "minimal"` uses a dependency-closed slice of Closure's typed
browser declarations for eligible ADVANCED browser jobs. Eligibility does not
require delivered type metadata. Disabled type inference, polyfill jobs, or
unavailable slices use the full browser externs; a failed custom-environment
compile can also fall back to the full set. Set `"full"` to bypass slicing.
Non-browser targets use `CUSTOM` with their target externs rather than this
browser policy.

### Cache options

```ts
cache: {
  mode: "persistent", // "off" | "temp" | "persistent"
  dir: "",            // optional explicit cache root
}
```

- `persistent` reuses native emit, Closure job, and final output artifacts across builds.
- `temp` uses an isolated workspace rather than a cross-build persistent cache.
- `off` also uses a temporary workspace and disables persistent artifact restoration.

The build owns its cache workspace before resolving the graph. Temporary
workspaces, invocation staging, and acquired locks are cleaned up on success
and failure, including setup failures. All owned cleanup actions are
attempted; cleanup errors are returned as build diagnostics alongside any
primary failure.

The default persistent root is outside the project: `$XDG_CACHE_HOME/gcc-ts-bundler`
(or `~/.cache/gcc-ts-bundler`) on Linux, `~/Library/Caches/gcc-ts-bundler` on
macOS, and `%LOCALAPPDATA%/gcc-ts-bundler` on Windows. Each project uses a hashed
subdirectory. Persist the chosen root to reuse artifacts in CI.

Every invocation resolves the native graph, chunk plan, and configuration
afresh, including when final output is cached. A final cache entry has one
manifest of canonical relative artifact paths and content identities. Restore
checks the manifest, artifact contents, and type-metadata dependencies, then
copies canonical bytes into an output-sibling staging directory and applies
destination-specific rewrites there. Restoring or relocating output does not rewrite the canonical
cached bytes.

Unchanged inputs can reuse final output or cached Closure jobs; a warm cache
does not guarantee that a changed build skips compilation. Renaming maps from
prior builds can improve output stability, but do not guarantee byte-identical
unaffected chunks after edits.

Persistent builds and `cleanCache()` coordinate through a project cache lock.
An inactive recorded owner, or a lock without valid owner metadata after the
initial grace period, fails closed instead of stealing the lock. On that
diagnostic, first establish that no build or cache-clean operation is active,
then manually remove only the exact lock directory named in the error and
retry. `cleanCache()` is not a stale-lock recovery bypass.

Use `cleanCache()` to remove the cache directory for one project root,
including its saved renaming maps.

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

These settings govern the core preflight collector. The Vite integration
delivers metadata through a different path that currently skips semantic
preflight; see [Vite's typechecking limitation](vite.md#how-it-integrates).

The separate top-level `hideWarningsFor` option selects paths passed to
Closure's `--hide_warnings_for`. Omit it to keep the default suppressed type
warnings; set `hideWarningsFor: []` to report those diagnostics.

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

`split` and `bundler-runtime` currently use the same native chunk pipeline:
one Closure job compiles the planned application graph, with runtime
registration where modules cannot be scope-hoisted. The mode names do not
select different optimization strategies.

`vendorChunk: true` can move eager dependencies into a separate vendor chunk
in either chunked mode with resolved ESM output. `"auto"` and the default
`false` disable that partition. This is a tradeoff between initial-load cost
and caching across application edits, not an unconditional size optimization.
The [Vite plugin](vite.md#compiler) owns its chunk graph and does not accept
this option.

Off mode emits entry bundles and can produce a shared chunk for common code.
Dynamic `import()` requires a chunked mode; exported library entries require
off mode.

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
- Compiler, graph, option-normalization, operational, publication, and cleanup
  failures are returned as `ok: false`, rather than escaping the build promise.
  Aggregated failures retain both primary and cleanup diagnostics; cleanup
  failure also turns an otherwise successful build into failure.
- Required explicit, typed, and generated extern inputs must be readable;
  missing required externs fail the build rather than silently weakening the
  runtime contract.

## `cleanCache(options)`

```ts
await cleanCache({
  projectRoot: process.cwd(),
  // cacheDir: "./custom-cache",
});
```

`projectRoot` defaults to the current directory. `cacheDir` selects the cache
root and resolves relative to `projectRoot`; otherwise the platform default is
used. Only the hashed cache directory for that project is removed. The
operation acquires the same project lock as a persistent build and rejects
its promise on failure. If removal and lock release both fail, the aggregate
error retains both causes. See [stale-lock recovery](#cache-options).

## `generateExterns(options)`

Extern generation protects JavaScript property contracts that Closure cannot infer safely across package or runtime boundaries.

### Boundary-aware mode

Use dependency declarations plus actual application usage. For a compiled
runtime module list, `appEntryFiles` is required.

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

Analyze emitted/runtime JavaScript contracts. For a compiled runtime module
list, provide runtime entry files (at the top level or on module descriptors).
Application entries are optional and can narrow usage.

```ts
const result = await generateExterns({
  mode: "runtime-aware",
  modules: ["some-runtime"],
  runtimeEntryFiles: ["../node_modules/some-runtime/index.js"],
  appEntryFiles: ["./main.ts"],
  projectRoot: process.cwd(),
  srcDir: "./src",
});
```

### Extern options and result

| Option                | Default                 | Meaning                                                                                                    |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `modules`             | required                | Strings mean compiled runtime; `{ specifier, runtime: "external" }` opts into typed external declarations. |
| `mode`                | `boundary-aware`        | `boundary-aware` or `runtime-aware`.                                                                       |
| `appEntryFiles`       | `[]`                    | Application entry files used for boundary/usage analysis.                                                  |
| `runtimeEntryFiles`   | `[]`                    | JavaScript runtime files used by runtime-aware mode.                                                       |
| `includeDependencies` | `false`                 | Follow imported declaration files.                                                                         |
| `projectRoot`         | current directory       | Root for module and config resolution.                                                                     |
| `srcDir`              | project root            | Base for relative app/runtime entry paths.                                                                 |
| `tsConfigPath`        | discovered              | Explicit tsconfig path relative to `projectRoot`.                                                          |
| `outputFile`          | none                    | Rename-barrier artifact path.                                                                              |
| `typedOutputFile`     | external-module sibling | Closure-only typed declaration artifact path; omitted for compiled-only module lists.                      |

`typedModuleFragmentsDir` optionally writes disjoint typed declaration
fragments under a project-root-relative directory. The result's
`typedDeclarations.moduleFragments` lists each absolute `outputFile` and
its owning `modules` (module specifiers). The aggregate typed artifact
remains available. Empty directories and collisions with other artifact
destinations are rejected before writing.

Fragments are dependency units, not standalone per-module extern files.
Select **every** fragment whose `modules` intersects the required module
set. Shared declarations and namespace initializers occur once across the
fragment set, so combining module consumers does not redeclare shared types.
Map fragment owners to original source entries and pass the files through
scoped `build.typedExterns`. Do not also pass the aggregate artifact to those
jobs.

Module descriptors can select `exports: "all" | "used"` and supply their own
`runtimeEntryFiles`. A list containing an external runtime can generate typed
declarations without application/runtime entry files. Relative analysis
entries resolve from `srcDir`; output artifact paths resolve from `projectRoot`.
`outputFile` and `typedOutputFile` must resolve to distinct paths; a collision
is rejected before generation writes either artifact. This is a resolved-path
check, not a guarantee against two different paths aliasing the same file.
Extern generation rejects its promise on invalid options or operational
failure; it does not return a `BuildResult`.

`exports: "used"` selects export roots, not individual members of a retained
type. Named imports, type-only uses, namespace member reads and finite
computed keys retain their reachable declaration closures. Namespace escapes,
unknown keys, rest/spread, dynamic imports and unresolvable ownership retain
the affected module conservatively. Module identity and lexical binding
identity take precedence over matching text; a shadowed local `require` is
not an external module use.

Additional contract controls:

- `protocolHelpers.keyReadCallees` and `keyExclusionListCallees` identify helpers
  that read or exclude property names supplied as strings.
- `propertyPolicy.renameable` removes specified structural `Object.prototype.*`
  barriers. Each name must match a generated barrier; `__gcc` names are rejected.
  Typed owner-qualified pins are not filtered. Only use this after establishing
  that the named runtime contract can safely rename.
- `target` defaults to `"browser"` and selects the analysis target policy.
- `maxSymbolDepth` optionally bounds typed-declaration expansion and must be a
  finite nonnegative integer, including zero. Negative, fractional, `NaN`, and
  infinite values are rejected. Omission is unbounded; truncating a published
  contract can lose type detail.

The result includes the generated artifacts, `scannedFiles`, type
`diagnostics`, and `warnings`. Its barrier accounting is:

| Field                             | Meaning                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `renameBarriers.propertyNames`    | Every property name pinned program-wide, across **both** artifacts.                                           |
| `typedDeclarations.propertyNames` | The typed artifact's share of that set.                                                                       |
| `barrierWarnings`                 | Non-fatal cost signals for any artifact above 200 barriers, naming the top contributing declaration packages. |

### Barrier cost

An `Object.prototype.X;` line is a _global_ barrier: `X` leaves Closure's
renaming **and** disambiguation candidate sets for every owner type in the
program, including your own. Both modes derive their barriers from application
usage or emitted runtime code to avoid unnecessarily pinning ordinary
application properties.

If a package's API is assembled from strings at runtime, that is a
`runtime-aware` job: it sees constructed keys, including the
`deferred[tuple[0] + "With"]` form that a declaration scan cannot see at all.

Typed declarations are rename barriers too: an owner-qualified
`T.prototype.P` and a record key `{"P": …}` both put `P` into Closure's extern
property set exactly like `Object.prototype.P` does. They are counted here for
that reason. Explicit extern files passed to `build({ externs })` are audited
on the same threshold.

The top-level `text` and `outputFile` remain aliases for
`renameBarriers.text` and `renameBarriers.outputFile`. Both structured
artifacts remain available even when no output paths are requested.

The result routes two artifacts independently:

- `renameBarriers.text` contains generated runtime barrier declarations; pass its `outputFile` through `build.externs`. Its `propertyNames` inventory is the union of names pinned by **both** artifacts, not just names present in that text.
- `typedDeclarations` (`text`, `outputFile`, `moduleExports`) contains owner-qualified declarations for structured external runtimes. Pass its file through `build.typedExterns`, never `build.externs`.

Each `moduleExports` entry also carries a `runtimeBridge` snippet. Compile that snippet through `build.js` only when the runtime is genuinely external and the host already supplies `__gccExternalRuntimeLoad(specifier)`. The bundler does not invent an external loader. Legacy string `modules` remain compiled runtime and do not produce typed external declarations.

Explicit `build.externs` files are both Closure inputs and native preservation
opt-ins. Use `build.typedExterns` for typed declarations that must not be scanned
by native preservation. This does **not** prevent their property names from
entering Closure's global extern property set.
