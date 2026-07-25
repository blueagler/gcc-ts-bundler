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
bun test ./test/*.test.mjs
```

`bun run build` builds JavaScript and the host native addon in parallel. The native build also creates a platform package under `npm/`.

For the complete check used by the package script:

```sh
bun run test
```

This runs:

1. Rust unit tests;
2. native and JavaScript builds;
3. the Bun integration test suite.

Run the repository's formatting, type, and ESLint pass with:

```sh
bun run lint
```

The lint script applies formatting and ESLint fixes, so review its diff before committing.

## Type-safety rules

The TypeScript configuration enables exact optional properties, unchecked index protection, unused-symbol checks, isolated modules, and verbatim module syntax. ESLint rejects explicit `any`, type assertions, non-null assertions, unsafe `any` flow, and value imports used only as types.

Treat filesystem caches, native addons, package configuration, and generated manifests as trust boundaries. Parse them as `unknown` and narrow them with validators from `src/internal/validation.ts`; do not add a generic cast-based JSON reader.

Build those validators with `isObjectOf<T>({ ... })` rather than hand-written `value is T` predicates. A hand-written predicate is an unchecked assertion: adding a field to `T` and forgetting to check it compiles cleanly and yields a validator that accepts data missing that field, so the type lies about parsed input. `ObjectSchema<T>` requires an entry for every key of `T`, which turns that drift into a compile error, and it forces literal unions to be validated with `oneOf` instead of a bare `isString`.

Prefer types derived from value tuples, `satisfies`, and exact internal contracts over duplicated unions or assertions.

## Useful build commands

| Command                                        | Purpose                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `bun run build:js`                             | Build ESM, CommonJS, CLI, and declaration outputs into `dist/` and `bin/`. |
| `bun run build:native`                         | Build the host Rust addon and its platform package.                        |
| `bun run build:native:cross`                   | Build Linux x64 GNU and Windows x64 MSVC targets.                          |
| `bun run build:native:all`                     | Build every configured native target.                                      |
| `bun run build`                                | Run host native and JavaScript builds in parallel.                         |
| `bun run typecheck`                            | Check source and declaration-build TypeScript configurations.              |
| `cargo test --manifest-path native/Cargo.toml` | Run only Rust tests.                                                       |
| `bun test ./test/vite-plugin.test.mjs`         | Run one JavaScript integration test file.                                  |

Set `GCC_BUILD_TIMINGS=1` to print internal cache and stage timings during builds. `GCC_CLOSURE_CONCURRENCY` can force the number of concurrent Closure jobs in bundler-runtime mode; `1` is useful for deterministic comparison while debugging.

## Repository map

| Path              | Contents                                               |
| ----------------- | ------------------------------------------------------ |
| `src/api`         | Public API and extern generator                        |
| `src/pipeline`    | Core build orchestration and cache identities          |
| `src/stages`      | Native analysis/transpile and Closure execution stages |
| `src/vite`        | Vite adapter                                           |
| `src/native`      | Validated native binding loader and TypeScript wrapper |
| `native/src`      | Rust N-API implementation                              |
| `test`            | Bun integration and behavior tests                     |
| `examples`        | Browser and framework fixtures                         |
| `scripts`         | JavaScript and native packaging scripts                |
| `closure-externs` | Bundler-owned extern additions                         |
| `closure-lib`     | Closure support library shipped to consumers           |

See [Architecture](architecture.md) for the runtime flow across these directories.

## Test coverage map

- `test/build.test.mjs` covers package graphs, entry exports, diagnostics, decorators, extern preservation, and final cache restoration.
- `test/chunks-runtime.test.mjs` covers literal dynamic imports, chunk manifests, runtime postprocessing, concurrency, and per-job cache behavior.
- `test/closure-ir.test.mjs` covers type/JSDoc scanning and Closure metadata generation.
- `test/externs.test.mjs` covers all extern modes and CLI output.
- `test/vite-plugin.test.mjs` covers retained graph capture, dependency prebundling, CSS ownership, naming, target mapping, cache reuse, and plugin guards.
- `test/cli-args.test.mjs` prevents deprecated option aliases from silently returning.
- `test/validation.test.mjs` covers schema validation, including rejection of unknown chunk kinds and malformed cache records.

Prefer adding a focused case to the existing behavior file instead of creating a new test harness.

## Native package builds

`scripts/build-native.mjs` supports these published targets:

- macOS arm64 and x64;
- Linux arm64/x64 with GNU or musl libc;
- Windows arm64/x64 with MSVC.

The script builds `native/src/lib.rs` as a `cdylib`, copies the host addon to `native/index.node` unless told not to, and writes an npm package containing `index.node` under `npm/<platform-package>`.

Musl cross-builds use `cargo-zigbuild`. The GitHub Actions workflow builds every native package independently and publishes them before the root package on a GitHub release.

## Published package layout

The root package publishes:

- `bin/` for the CLI;
- `dist/` for ESM, CommonJS, declarations, Vite, and native loader entries;
- `closure-externs/` and `closure-lib/`;
- `docs/` and the root README.

Platform addons are optional dependencies. At runtime, `src/native/index.ts` prefers a local `native/index.node` development build, then loads the matching optional package for the current OS, architecture, and Linux libc.

## Generated files

These paths are build products and should not be edited by hand:

- `bin/`;
- `dist/`;
- `native/index.node`;
- `native/target/`;
- `npm/`;
- example `dist/` directories;
- `.gcc-ts-bundler-vite/` and debug capture directories.

Make source changes under `src/` or `native/src/`, then rebuild before running integration tests because the tests import package outputs from `dist/`.
