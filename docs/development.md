# Development

## Prerequisites

Local development needs:

- Bun for dependencies, JavaScript builds, strict type checking, formatting, and tests;
- a Rust toolchain with Cargo for the N-API addon;
- the platform tools required by the selected Rust target.

The published package runs on Node, but this repository uses Bun for its development scripts.

## Install and verify

```sh
bun install
bun run build
bun test ./test
```

`bun run verify:package` performs a clean JavaScript/declaration build, packs the npm archive, verifies every `exports`, `types`, and `bin` target, type-checks a NodeNext consumer, and smoke-imports the packed package with Node and Bun.
`bun run verify:selfbuild` checks the self-hosted package fixpoint. The bootstrap JavaScript build emits declarations once. Later self-build stages copy those declarations instead of running the declaration bundler again. The script still compares stage 1 and stage 2 for byte identity.

`bun run build` runs `scripts/build-self.mjs`: it builds the host native addon, then the bootstrap JavaScript bundle, then compiles the bundler with itself twice, checks that stage 1 and stage 2 are byte-identical, and publishes stage 1 into `dist/` and `bin/`. The native build also creates a platform package under `npm/`.

`bun run build:js` runs that same self-build script, so both commands replace `dist/` and `bin/` with the Closure-compiled artifact. `bun run build:js:bootstrap` (`node ./scripts/build-js.mjs`) is the only command that produces the plain bootstrap bundle.

### Build cost and the inner-loop lane

A full `bun run build` is measured at 139s wall. Where it goes:

| Phase | Time | Share |
| --- | --- | --- |
| `closure:compile` stage 1 | 52.0s | 37% |
| `closure:compile` stage 2 | 44.9s | 32% |
| declaration bundle, native emit, resolve, publish | ~42s | 31% |

So about 70% of the build is inside the Closure compiler, and stage 2 exists
only to prove the fixpoint. The published bytes are always stage 1, so skipping
stage 2 does not change the artifact — it only drops the byte-identity proof:

```sh
bun run build:fast
```

This lane skips stage 2 and reuses the persistent cache. Measured against the
139s full build: **89s cold, 28s warm**. Its output was verified byte-identical
to the full two-stage cache-off build — 20 files, zero differing hashes — so the
only thing given up is the fixpoint proof itself, which the lane warns about on
every run. Use it while editing; use `bun run build` before releasing, and in
CI.

Two environment variables control the lanes directly:

| Variable | Default | Effect |
| --- | --- | --- |
| `GCC_SELFBUILD_STAGES` | `2` | `1` builds stage 1 only and skips the fixpoint comparison |
| `GCC_SELFBUILD_CACHE` | `off` | `persistent` reuses the project cache |

`GCC_BUILD_TIMINGS=1` prints the `[gcc-ts-bundler timing]` lines the table above
came from.

Note that the per-job Closure cache takes two builds to reach full speed:
`src/build/closure/cache.ts` hashes the previous build's renaming maps into the
job key, so the key only settles once those maps stop changing. That is inherent
to pinning renaming for output stability, not a defect.

Reaching that steady state required fixing three cache bugs, each of which also
affected ordinary consumers with a warm cache:

- `getOptionsSignature` hashed absolute `outDir`, `srcDir`, `outFile`,
  `projectRoot`, and extern paths, so a build whose directory moved could never
  reuse a cache. CI runners, monorepo staging directories, and relocated
  checkouts all hit this. Those fields are now keyed relative to `projectRoot`.
- `trackedFilesMatch` compared mtime, so rewriting a file with identical
  contents invalidated everything. It now rejects on size and confirms with a
  content digest.
- The resolve cache persisted each entry's absolute `outFile` and replayed it on
  a hit, republishing the entry into the directory used by whichever build
  populated the cache. A `chunks: "off"` build with a custom `outFile` therefore
  produced an output tree missing that file. `outFile` is caller-supplied input,
  so it is no longer cached at all and is taken from the live options.

A fourth defect is contained rather than fixed: the resident JVM never exits, so
Closure's renaming-report writers are not flushed on job completion and a report
can land truncated on disk — one was exactly 98304 bytes, ending mid-token at
`module$contents`, which made the next build die in `VariableMap.load` with
`java.text.ParseException`. Maps are now validated for the `key:value` shape
before they are cached and again before they are handed back to Closure, and a
malformed map is deleted rather than used, so a truncated report costs one
recomputation instead of failing the build.

### What Closure is given for runtime-owned modules

A configured `externals` specifier is never compiled by Closure, so its
declarations exist to *name* the boundary, not to describe it. Seeds are already
narrowed to the exports a program actually uses, but the type closure of those
exports is not the boundary: one export returning a `ts.Program` reaches
essentially all of TypeScript's type graph.

Unbounded, this repo's own three externals (`@typescript/typescript6`,
`google-closure-compiler`, `vite`) rendered a **51 MB, 875,460-line** extern file
describing 164,758 members — 25x the 2.01 MB of program being compiled — and it
was handed to every compile job. Measured directly against the same compiler on
the same 289-file program, holding everything else fixed and reaching an
identical stopping point with zero undefined-variable errors:

| Externs supplied | Size | Elapsed |
| --- | --- | --- |
| unbounded closure | 50.97 MB | 38.7s |
| declarations only, JSDoc types stripped | 21.64 MB | 33.2s |
| bindings and property barriers only | 0.03 MB | 4.5s |

Type detail is only a small part of it; the declaration *count* is the cost, and
every name in that file also leaves Closure's renaming and disambiguation
candidate sets program-wide. `shouldEnableTypeInference` measures the
optimization value of that type information at 0.03% of output size.
Type metadata is therefore kept for compile time and diagnostics — it selects
the minimal platform-extern slice and typed boundary surfaces — not for
output size.

`GenerateExternsOptions.maxSymbolDepth` bounds how far past a seed a referenced
type is still spelled out; past the bound a reference degrades to `?`, which is
what an untyped extern would have been anyway. It never changes which names are
declared, so boundary bindings stay resolvable. `resolveTypedExternSurfaces`
sets it to 0 for runtime-owned specifiers: a seed export is always spelled
out, and at depth 0 nothing past the seeds is.

Leave it unset wherever the emitted surface is a published contract: the
self-build asserts its own public API externs carry no degradations, and a bound
there fails the build closed rather than shipping a `?`.

Setting it took the external extern file from 50.97 MB unbounded to 32.8 MB at
depth 1 to 1.9 KB / 90 lines at depth 0, and `closure:compile` from 164.8s to
41.3s per stage (full build 6m03s to under 2m), while the self-build fixpoint
stayed byte-identical, all five example dists stayed byte-for-byte, and the
self-build's own output got slightly smaller (`dist/vite/index.mjs` 150,465 to
149,580 raw bytes) because fewer property names are pinned.

#### One declaration per boundary variable

The native emitter deliberately gives the same external export the same
`e{token}_0_{slot}` binding name in every module that imports it — that shared
name *is* the shared boundary global. So the extern file has several producers
for one name: the native section emits `/** @type {?} */ var X;`, and the typed
append step emits `/** @type {!T} */ var X;` once per importing module.

Closure rejects that with `JSC_VAR_MULTIPLY_DECLARED_ERROR`. Normal builds mask
it at their warning level, which is why it stayed latent; `GCC_DISABLE_TYPE_INFERENCE=1`
surfaces it and hard-fails, so that escape hatch was broken for as long as the
duplicates existed.

The invariant is now that the file as a whole declares each variable exactly
once. `appendExternalTypedExterns` dedups by declared name and strips the
untyped native declaration for exactly the names it is about to declare typed —
the typed declaration wins because it is strictly more informative.
The invariant is fail-closed at assembly: after the typed append, the whole
file is re-scanned and any name declared twice — by any producer, native or
typed — aborts the build immediately instead of surfacing only under
`GCC_DISABLE_TYPE_INFERENCE=1`.

Property lines (`X.member;`) are additive, not declarations: they are deduped by
full member path and every distinct one is kept. They are rename barriers, so
satisfying uniqueness by dropping them would silently under-pin a property and
can break a runtime boundary. `test/build/build.test.mjs` asserts both halves —
uniqueness *and* barrier survival — against a fixture with three importers of
one external export.

For the complete check used by the package script:

```sh
bun run test
```

This runs:

1. Rust unit tests;
2. `bun run build` — the native addon, the bootstrap JavaScript bundle, and the self-build fixpoint published into `dist/` and `bin/`;
3. the Bun integration test suite.

Use the fast inner-loop lane while editing:

```sh
bun run test:fast
```

This lane runs 12 pure and native test files. It took about 14 seconds in the measured run. CI and pre-commit use the full `bun run test` suite.

Run the repository's formatting, type, and Oxlint pass with:

```sh
bun run lint
```

The lint script checks Rust formatting and Clippy, then runs the TypeScript formatting and Oxlint checks.

## Type-safety rules

The TypeScript configuration enables exact optional properties, unchecked index protection, unused-symbol checks, isolated modules, and verbatim module syntax. Oxlint rejects explicit `any`, type assertions, non-null assertions, unsafe `any` flow, and value imports used only as types.

Treat filesystem caches, native addons, package configuration, and generated manifests as trust boundaries. Parse them as `unknown` and narrow them with validators from `src/shared/validation.ts`; do not add a generic cast-based JSON reader.

Build those validators with `isObjectOf<T>({ ... })` rather than hand-written `value is T` predicates. A hand-written predicate is an unchecked assertion: adding a field to `T` and forgetting to check it compiles cleanly and yields a validator that accepts data missing that field, so the type lies about parsed input. `ObjectSchema<T>` requires an entry for every key of `T`, which turns that drift into a compile error, and it forces literal unions to be validated with `oneOf` instead of a bare `isString`.

Prefer types derived from value tuples, `satisfies`, and exact internal contracts over duplicated unions or assertions.

## Useful build commands

| Command                                        | Purpose                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `bun run build:js`                             | Run the same self-build as `bun run build`.                      |
| `bun run build:js:bootstrap`                   | Build the plain bootstrap ESM, CLI, and declaration outputs into `dist/` and `bin/`. |
| `bun run build:native`                         | Build the host Rust addon and its platform package.              |
| `bun run build:native:cross`                   | Build Linux x64 GNU and Windows x64 MSVC targets.                |
| `bun run build:native:all`                     | Build every configured native target.                            |
| `bun run build`                                | Build the native addon and bootstrap JavaScript, then self-build and publish `dist/` and `bin/`. |
| `bun run typecheck`                            | Check source and declaration-build TypeScript configurations.    |
| `bun run format:rust`                          | Check native Rust formatting with rustfmt.                       |
| `bun run lint:rust`                            | Run Clippy for all native targets and features with warnings denied. |
| `cargo test --manifest-path native/Cargo.toml` | Run only Rust tests.                                             |
| `bun test ./test/vite/plugin.test.mjs`         | Run one JavaScript integration test file.                        |
| `bun run verify:package`                       | Build, pack, and validate the published package contract.        |

Set `GCC_BUILD_TIMINGS=1` to print internal cache and stage timings during builds. `GCC_CLOSURE_CONCURRENCY` can force the number of concurrent Closure jobs in bundler-runtime mode; `1` is useful for deterministic comparison while debugging.

Set `GCC_DISABLE_TYPE_INFERENCE=1` to bisect metadata-related regressions. It disables optional annotations, silent `checkTypes` inference, and typed platform slicing while preserving semantic enum/decorator lowering; cache identities keep this mode separate.

## Repository map

| Path              | Contents                                               |
| ----------------- | ------------------------------------------------------ |
| `src/api`         | Public API surface: option and result types, facades   |
| `src/cli`         | CLI entry, argument parsing, usage text                |
| `src/build`       | Build pipeline: resolve, transpile, and Closure stages |
| `src/externs`     | Extern generator                                       |
| `src/vite`        | Vite adapter                                           |
| `src/native`      | Validated native binding loader and TypeScript wrapper |
| `src/shared`      | Generic primitives: validation, files, caching, timing |
| `native/src`      | Rust N-API implementation                              |
| `test`            | Bun integration and behavior tests                     |
| `examples`        | Browser and framework fixtures                         |
| `scripts`         | JavaScript and native packaging scripts                |
| `closure-externs` | Bundler-owned extern additions                         |
| `closure-lib`     | Closure support library shipped to consumers           |

See [Architecture](architecture.md) for the runtime flow across these directories.

`GCC_DISABLE_BARRELS=1` disables prebundle barrel flattening, for comparing
module placement against Closure's own cross-chunk code motion.

`GCC_CLOSURE_EXTRA_FLAGS="--flag[=value] ..."` appends verbatim flags to
every Closure invocation — useful for measuring candidate compiler flags
without a rebuild. Do not override pipeline-managed flags (reports, chunk
paths) with it.

Examples depend on the repo via `"gcc-ts-bundler": "link:gcc-ts-bundler"`.
Run `bun link` once at the repo root before installing an example; the
install then symlinks the repo instead of copying it (a `file:` dependency
would copy the whole repo — including `examples/*/node_modules` —
recursively into every example, exhausting inodes).

## Test coverage map

- `test/build/build.test.mjs` covers package graphs, entry exports, diagnostics, decorators, extern preservation, and final cache restoration.
- `test/build/chunks-runtime.test.mjs` covers literal dynamic imports, chunk manifests, runtime postprocessing, concurrency, and per-job cache behavior.
- `test/build/type-metadata.test.mjs` covers type/JSDoc scanning and Closure metadata generation.
- `test/externs/generate.test.mjs` covers all extern modes and CLI output.
- `test/vite/plugin.test.mjs` covers retained graph capture, directed dependency routing and atom bundles, CSS ownership, naming, target mapping, cache reuse, and plugin guards.
- `test/cli/args.test.mjs` prevents deprecated option aliases from silently returning.
- `test/shared/validation.test.mjs` covers schema validation, including rejection of unknown chunk kinds and malformed cache records.
- `scripts/verify-package.mjs` covers the packed exports/bin contract, NodeNext declarations, and Node/Bun import smoke tests.

Prefer adding a focused case to the existing behavior file instead of creating a new test harness.

## Native package builds

`scripts/build-native.mjs` supports these published targets:

- macOS arm64 and x64;
- Linux arm64/x64 with GNU or musl libc;
- Windows arm64/x64 with MSVC.

The script builds `native/src/lib.rs` as a `cdylib`, copies the host addon to `native/index.node` unless told not to, and writes an npm package containing `index.node`, license metadata, and `LICENSE` under `npm/<platform-package>`.

Musl cross-builds use `cargo-zigbuild`. The GitHub Actions workflow builds every native package independently and publishes them before the root package on a GitHub release.

## Published package layout

The root package publishes:

- `bin/` for the CLI;
- `dist/` for the root, Vite, and preset ESM entries plus declarations (the package is ESM-only);
- `closure-externs/` and `closure-lib/`;
- `docs/`, the root README, and `LICENSE`.

Platform addons are optional dependencies. At runtime, `src/native/index.ts` prefers a local `native/index.node` development build, then loads the matching optional package for the current OS, architecture, and Linux libc.

`npm publish` and `bun run publish:npm` both run the same `prepublishOnly` package verification hook before publishing.

GitHub releases use npm trusted publishing. Each publish job requests `id-token: write`, configures `https://registry.npmjs.org`, and installs npm `>= 11.5.1`; it does not use a stored token secret. Configure an exact repository trusted publisher for the root package and each platform package on npmjs.com. A new platform package needs one bootstrap publish before npm can attach its trusted publisher. The root manifest declares `repository`, and `scripts/build-native.mjs` copies that field into each platform manifest.

## Generated files

These paths are build products and should not be edited by hand:

- `bin/`;
- `dist/`;
- `native/index.node`;
- `native/target/`;
- `npm/`;
- example `dist/` directories;
- `.gcc-debug/` and `.investigate-*` capture directories;
- the Vite capture workspace under the persistent cache store (`vite-capture/`), or a tmpdir when cache is off.

Make source changes under `src/` or `native/src/`, then rebuild before running integration tests that import package outputs from `dist/`. Use `bun run build:js:bootstrap` when those tests should see `src/` as authored; `bun run build` and `bun run build:js` replace `dist/` with the Closure-compiled self-build.
