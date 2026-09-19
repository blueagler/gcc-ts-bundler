# Workflows

Use this guide to choose a command, prepare its dependencies, and understand what its result proves. [Change routes](changes.md) maps a requested change to source and affected contracts; [Architecture](architecture.md) explains pipeline ownership. User-facing behavior belongs to the [API](../reference/api.md), [CLI](../reference/cli.md), and [Vite](../reference/vite.md) references.

## Prerequisites and setup

Repository commands use the **system Bun on `PATH`**, and scripts also invoke Node. Use a Node version supported by the installed Vite dependency, not merely the package's lower consumer minimum. The [release workflow](../../.github/workflows/native-packages.yml) uses Node 22, latest Bun, and JDK 21. There is no archived Bun provisioning, cached runtime selector, or runtime-path override in example verification. [`package.json`](../../package.json) and the lockfiles own dependency versions: current Closure is `20260909.0.0`, the Oxc family is `0.150.0`, and Oxc requires **Rust 1.96 or newer**. The root and its own optional native packages remain coordinated at `0.2.1`; upgrading external dependencies does not independently version those packages.

Install the tools needed by the lane you are exercising:

| Lane                                      | Prerequisites and relevant side effects                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-only TypeScript checks             | Bun, compatible Node, installed repository dependencies                                                                                                                                                                                                                                                                                                 |
| Native build or native-backed integration | Rust/Cargo 1.96+, **rustup**, and the selected target's linker/build tools. [The build script](../../scripts/build-native.mjs) checks installed targets and Cargo subcommands and fails with provisioning guidance; it does not install them. Linux cross-builds commonly use `cargo-zigbuild` plus Zig; Windows cross-builds may require `cargo-xwin`. |
| Real Closure compilation / self-build     | Native addon plus a compatible Java environment. Use **JDK 21** to match release CI: first-use resident-driver compilation invokes `com.sun.tools.javac.Main`, which a JRE alone does not provide. A failed driver probe falls back to the installed compiler implementation; that is not proof that the resident path was exercised.                   |
| Official-example verification             | Full build prerequisites, system Bun, and each example's frozen dependencies; no Bun archive download or extraction                                                                                                                                                                                                                                     |
| Packed-package verification               | Full build prerequisites, system Bun for packing even under Node, and `tar` for extraction. Publication still requires npm and its authentication setup.                                                                                                                                                                                                |

From the repository root:

```sh
bun install --frozen-lockfile
bun run build
```

That creates the native addon, JavaScript package outputs, and declarations. It does not run all tests. For package consumption rather than development, see [Install](../../README.md#install).

### Source versus built package

Edit `src/` or `native/src/`, not generated JavaScript. Before choosing a test or example command, inspect what it imports:

- `src/` imports see TypeScript edits directly under Bun.
- `dist/`, package exports, and the CLI consume generated output. `bun test ./test` alone does **not** rebuild it.
- Either kind of test can load `native/index.node` or invoke Closure. A source import does not mean the test is JavaScript-only.
- Official examples use `link:gcc-ts-bundler` and therefore consume the root package's built exports, not its authored TypeScript.

For example, [`test/cli/args.test.mjs`](../../test/cli/args.test.mjs) targets source argument parsing; [`test/build/workspace.test.mjs`](../../test/build/workspace.test.mjs) imports source but also performs real compiler builds. A stale native addon or stale `dist/` can make a valid source edit invisible to its consumer.

## Build lanes

[`scripts/build-self.mjs`](../../scripts/build-self.mjs) prepares the host addon and private **stage-0** bootstrap concurrently, then uses that bootstrap to compile stage 1. Bootstrap ESM, CLI and declarations also run concurrently; started work drains before temporary-tree cleanup. Immutable runtime-asset discovery and boundary-extern extraction are shared across stages, while public externs remain stage-specific. Stage 1 and optional stage 2 are strictly sequential. Each stage receives declarations both before compilation, for type resolution, and afterward, because output publication replaces its tree. Only the completed stage-1 tree is copied into `dist/` and `bin/`; stage 2 must compare equal before that publication. Publishing the root `dist/` and `bin/` still uses separate remove/copy operations, not an atomic two-directory transaction.

TypeScript has two deliberate roles. [`run-typescript.mjs`](../../scripts/run-typescript.mjs) launches `typescript@7.0.2` through its declared `bin.tsc`, without a loader patch. [`bundle-declarations.mjs`](../../scripts/bundle-declarations.mjs) emits one raw declaration tree with that CLI, then bundles the five public entry points independently with Rolldown and `rolldown-plugin-dts` in `dtsInput` mode. Independent bundles avoid introducing undeclared shared declaration files; the raw-tree working directory stabilizes generated path comments. Every bundle closes and scratch cleanup runs on failure. Runtime semantic analysis and the self-build's boundary-source traversal use the vendor JavaScript API `@typescript/typescript6@6.0.2`; do not substitute the TypeScript 7 CLI package for that API. Declaration generation happens in stage 0; later self-build stages copy those declarations rather than regenerating them.

| Task                                              | Command                      | What it produces or proves                                                              |
| ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| Build the published artifact shape                | `bun run build`              | Native addon, bootstrap, then stage-1 self-build with cache off                         |
| Iterate with persistent reuse                     | `bun run build:fast`         | The same stage-1 lane with persistent cache enabled, not a reduced compiler             |
| Debug authored JavaScript before self-compilation | `bun run build:js:bootstrap` | Plain bootstrap ESM, CLI, and declarations; no native rebuild and no Closure self-build |
| Rebuild a Rust change for this host               | `bun run build:native`       | Host addon plus its platform package                                                    |
| Build configured cross targets                    | `bun run build:native:cross` | Linux x64 GNU and Windows x64 MSVC packages                                             |
| Build every configured native target              | `bun run build:native:all`   | All targets known to the build script; requires their toolchains                        |
| Check compiler self-hosting stability             | `bun run verify:selfbuild`   | Stage-1/stage-2 byte-identity comparison; still publishes stage 1                       |

`GCC_SELFBUILD_STAGES` accepts `1` or `2`; `GCC_SELFBUILD_CACHE` accepts `off` or `persistent`. The script owns their validation. Stage 2 proves a fixpoint for this build, not runtime correctness for all consumers. Cache reuse is not a timing guarantee: renaming-map changes participate in compiler job identities.

The bootstrap command replaces `dist/` and `bin/`, so it changes which compiler your package-importing tests and linked examples use. Re-run the self-build when the question is about shipped output rather than bootstrap behavior.

## Tests and checks

The native lint policy is crate-local in [`native/Cargo.toml`](../../native/Cargo.toml): `pedantic` warnings with an explicit allowlist, plus denials for unwrap/expect calls, panic, local allow attributes, debug/TODO/unimplemented macros and stdout/stderr printing. The all-target/all-feature Clippy gate promotes warnings to errors. Propagate expected failures through `Result`; do not replace checked access with hidden panic helpers or blanket suppressions. Release panic handling remains unwind-based.

The TypeScript lint configuration grants boundary-specific exceptions for `unknown` inputs/returns in six explicit modules: shared validation, cache-store and hash, native loading/admission, and esbuild admission. Use ordinary type predicates there; runtime schemas and all unsafe-use/assertion checks remain enabled. Do not introduce a recursive runtime-value type universe to bypass the boundary policy.

Native release builds use thin LTO with one codegen unit. Matched ARM64 crate rebuilds were faster than fat LTO with identical graph/minifier outputs and comparable runtime timings, at the cost of a slightly larger addon. Keep panic unwinding and runtime checks when changing this policy.

Choose the check that reaches the changed contract. There is no requirement to run every lane for every edit; [`package.json`](../../package.json) is the complete command catalog.

`test`, `test:fast` and `coverage` cap Bun file workers at four and update `.tmp/test-timings.json` to schedule expensive files first on subsequent runs. The timing file is disposable and untracked; no custom runner is involved. `test` refreshes the complete stage-1 package through `build:fast` before running the suite. `test:fast` and `coverage` still require current package/native outputs. Release builds and the self-hosting fixpoint lane retain cache-off defaults.

| Question                                     | Command                                        | Scope / limitation                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does one JavaScript behavior hold?           | `bun test ./test/build/workspace.test.mjs`     | One file, using the currently available native/package outputs; choose a file from [Change routes](changes.md) for your change                                                     |
| Do the selected integration lanes pass?      | `bun run test:fast`                            | A curated subset, including real native/Closure builds; does not build the package first                                                                                           |
| Does the broad repository test lane pass?    | `bun run test`                                 | Rust tests, fresh stage-1 build with persistent cache, then the four-worker Bun suite                                                                                              |
| Does the Rust implementation pass its tests? | `cargo test --manifest-path native/Cargo.toml` | Rust tests only; does not refresh the addon used by JavaScript                                                                                                                     |
| Do source and declaration-build types check? | `bun run typecheck`                            | Both TypeScript configurations; no emitted-output or runtime proof                                                                                                                 |
| Do repository static checks pass?            | `bun run lint`                                 | Typecheck, Rust formatting/Clippy, TypeScript formatting, and Oxlint; not compiler semantic proof                                                                                  |
| Does the package layout work for consumers?  | `bun run verify:package`                       | Install-sanity checks, packing of existing root/host-native output, NodeNext declarations, Node/Bun imports, CLI help and a native-backed consumer build; **does not build first** |
| Do published self-build stages agree?        | `bun run verify:selfbuild`                     | Rebuilds and compares stage-1/stage-2 bytes; not the full runtime suite                                                                                                            |
| Do official example bytes reproduce?         | `bun run verify:examples`                      | Fresh example builds against tracked `dist/`, plus committed baseline size floors; not browser interaction proof                                                                   |
| Are release payloads ready before upload?    | `bun run prepare:release`                      | Rust hygiene, cache-off stage-2 self-build, pack-once root/host-native artifacts and exact-tarball verification; no upload                                                         |

For a compiler bug, the useful evidence is the failing input and its observable output after compilation. A typecheck or successful compile does not establish runtime semantics. For a public-contract change, exercise a consumer through the relevant entry point; for syntax support, the [direct Closure capability probes](../../test/native/closure-capabilities.test.mjs) separate compiler support from wrapper behavior. Keep regression cases for real failure modes rather than tests that assert documentation wording.

### Official-example reproducibility

```sh
bun run verify:examples
```

[`scripts/verify-example-dists.mjs`](../../scripts/verify-example-dists.mjs) owns this proof:

1. Use `bun` from the system `PATH` and report its version. Toolchain changes can change tracked bytes; the script neither provisions an older runtime nor hides a version-dependent difference.
2. Rebuild the root package and register its `link:gcc-ts-bundler` link.
3. Copy each official example into a fresh temporary directory without existing outputs or dependencies, install its frozen lockfile, and build it.
4. Compare the entire generated `dist/` file list and SHA-256 contents with the tracked `dist/`.
5. Report committed JavaScript gzip savings against committed `dist-pure/`. Lit must save at least 8%; jQuery and the other examples are report-only. Every example still receives the complete byte-identity check.

The official plugin configurations explicitly use `compiler: { cache: { mode: "off" } }` so tracked bytes do not inherit a developer's persistent renaming-map history. Persistent reuse remains the bundler default for other consumers; its output need not be byte-identical to a cold build.

This checks reproducibility against tracked plugin output using the current system toolchain. It does not rebuild `dist-pure/` or exercise browser interactions. The Vue example remains the Vue Vapor lane (`3.6.0-rc.8`), not a substitution with stable non-Vapor Vue.

`GCC_VERIFY_EXISTING_PACKAGE=1` skips the package rebuild when deliberately checking existing output. All other prerequisites still apply. Runtime tests, self-build identity, package verification and example-byte comparison are independent evidence; passing one does not imply the others passed.

### Build and preview an example

At the repository root, build the package and run `bun link` once. Then, inside the selected example directory:

```sh
bun install --frozen-lockfile
bun run build
bun run build:pure
bun run preview --host 127.0.0.1 --port 4173 --strictPort
```

`build` writes plugin output to `dist/`; `build:pure` writes the independent Vite baseline to `dist-pure/`. Preview serves `dist/` without rebuilding. After a plugin edit, rebuild the root package and the example; after an example-only edit, rebuild the example. Open the preview and exercise the behavior under investigation—producing reproducible bytes does not prove a browser interaction works.

The root [`preview:examples` helper](../../scripts/preview-example.mjs) requires exactly one exact example name or unambiguous prefix, for example `bun run preview:examples vue`. The named `preview:react`, `preview:svelte`, `preview:lit`, `preview:vue`, and `preview:jquery` scripts select their respective example. With no selection, an unknown/ambiguous prefix, invalid flags, or missing `dist/index.html`, it fails without starting Vite. It serves through the example's installed Vite CLI, defaults to `127.0.0.1:4173`, and always enables `--strictPort`. Optional `--host` and `--port` select another binding; a non-loopback host deliberately exposes the preview beyond localhost.

The helper never builds, installs dependencies, or kills a listener to reclaim a port. Existing output may therefore be stale: build explicitly first. An occupied port fails; interrupts are forwarded only to the helper's own Vite child, whose exit status/signal is preserved.

Examples intentionally use `link:`, not a recursive `file:` copy. Register only this package; each example's dependencies resolve from its own frozen lockfile.

### Runtime coverage and property investigations

`bun run coverage` runs the JavaScript suite with Bun's lcov reporter, then [`coverage-istanbul.mjs`](../../scripts/coverage-istanbul.mjs) writes `.coverage/coverage-final.json`. It has the same built-output prerequisites as that suite and does not rebuild them. The converter combines measured line hits with TypeScript function ranges; function invocation counts are inferred from line hits, not separately instrumented calls.

`bun run ledger --json` reports property channels, costs, and suspects through [`property-ledger.ts`](../../scripts/property-ledger.ts). Use it to locate a boundary to investigate, not as proof that a property may safely be renamed. Follow the property route in [Change routes](changes.md) and the public policy contract in the [API reference](../reference/api.md).

## Debugging controls

Start by identifying the boundary where evidence diverges: resolved graph, lowered Closure input, extern assembly, Closure output, or final delivery. The [architecture guide](architecture.md) owns those boundaries. For Vite, the [reference's debug options](../reference/vite.md) expose captured-graph evidence; for a persistent-cache discrepancy, preserve the relevant artifacts before clearing them.

| Control                                        | Use / limitation                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCC_BUILD_TIMINGS=1`                          | Print internal cache and stage timings. Compare like-for-like inputs and cache states, not a historical duration target.                                                               |
| `GCC_BUILD_PROFILE=1`                          | Emit versioned JSON span receipts for builds and self-build orchestration, independently of textual timing logs.                                                                       |
| `GCC_CLOSURE_CONCURRENCY=1`                    | Limit prepared Closure jobs. Resident compilation defaults to one worker; `2` opts into at most two lazy workers with higher peak memory. The bundler-runtime graph is itself one job. |
| `GCC_CLOSURE_DRIVER=0`                         | Force the resident-driver path off to compare the installed compiler fallback.                                                                                                         |
| `GCC_CLOSURE_DEBUG=1`                          | Request Closure debug names and pretty printing. This changes compiler output, not merely logging.                                                                                     |
| `GCC_DISABLE_TYPE_INFERENCE=1`                 | Bisect optional metadata/inference-related optimization. This is an experiment control, not a replacement for fixing incorrect metadata.                                               |
| `GCC_DISABLE_BARRELS=1`                        | Disable Vite prebundle barrel flattening for comparison.                                                                                                                               |
| `GCC_CLOSURE_EXTRA_FLAGS="--flag[=value] ..."` | Try compiler flags without rebuilding. Pipeline-managed flags are rejected; parsing is whitespace-separated, not shell quoting.                                                        |

The controls are implemented in [timing](../../src/shared/timing.ts), [concurrency](../../src/build/closure/concurrency.ts), [driver probing](../../src/build/closure/driver/probe.ts), [compiler environment](../../src/build/closure/compiler/environment-resolve.ts), and [prebundle orchestration](../../src/vite/prebundle/orchestrate/bundles.ts). Compiler syntax investigations start at the [capability boundary](architecture.md#type-metadata-and-the-oxc-envelope).

Without `GCC_BUILD_TIMINGS=1`, Vite skips diagnostic graph statistics and output stat/read/gzip work rather than just suppressing their logs. Set the variable before starting the process; enabled diagnostics still report both raw and gzip sizes.

`GCC_BUILD_PROFILE=1` writes `[gcc-ts-bundler profile] ` followed by a JSON
receipt to stderr. Version 1 includes root wall time, parent-linked spans,
work counters and error flags. `selfMs` subtracts the union of direct-child
intervals; `exclusiveMs` partitions root wall time among the deepest active
spans, breaking equal-depth ties by later span ID. Use the latter for a
non-overlapping stage breakdown. Do not add nested build and self-build
receipts together, or interpret summed concurrent job durations as wall time.
Run ordinary timing samples without instrumentation and distinguish cold,
unchanged, implementation-edit and public-contract-edit cache states.

To separate Closure's own parsing, type checking and optimization costs from the surrounding pipeline, profile a cache-off build:

```sh
GCC_BUILD_TIMINGS=1 GCC_CLOSURE_EXTRA_FLAGS="--tracer_mode=TIMING_ONLY" bun run build
```

`TIMING_ONLY` emits per-pass timings, input counts, GC and JVM JIT statistics. Do not use `ALL` for ordinary timing comparisons: it also estimates output/gzip size after changing passes. `GCC_CLOSURE_DEBUG=1` changes generated names and formatting and is not a substitute for this profiler.

The compiler defaults to `min(4, available CPUs)` parsing threads. This parallelizes parsing/dependency prebuilding only; type checking and optimization remain serial. Use `GCC_CLOSURE_EXTRA_FLAGS="--num_parallel_threads=1"` to compare serial parsing or limit CPU contention. An explicit threading flag overrides the default; equivalent snake_case, camelCase and hyphenated spellings resolve to one scalar option, with the last explicit value winning. Keep compiler options, inputs and cache state fixed, compare both cold and warm runs, and verify output bytes, renaming maps and diagnostics. The [pinned-version investigation](../research/optimization-architecture.md#v20260909-build-time-verification) records the measurements and why JVM tuning, native-image preference and a CHECKS cache were not adopted.

Extern inputs are contracts, not a module-name allowlist. Keep explicit `externs`, explicit `typedExterns` (including public API declarations), native rename barriers, and generated external boundary types with their transitive dependencies. Node ambient externs should describe only genuine free global references in that compiler job: local variables, parameters, local functions and Closure's implicit module `exports` do not require Node declarations. TypeScript's declaration-free synthetic `requireSymbol` is not a lexical binding: free `require(arg)` still needs its ambient contract, while shadowed calls do not. Removing generated typed declarations solely because a namespace is not mentioned can still remove program-wide property pins. Browser minimal externs retain their existing dependency-closed selection and full-extern fallback. Keep serialized boundaries such as `ContentIdentity.digest` explicit, and require whole-build evidence before adopting a preparation partition: fewer extern lines alone are not a speedup.

For cleanup failures, inspect the [resource owner](architecture.md#failure-and-resource-boundaries): the pipeline now owns its cache store before resolution and reports primary plus cleanup diagnostics. A stale-lock diagnostic requires checking that no build is active before manually removing the exact reported lock directory; do not automate lock stealing. Historical performance/cache/extern experiments live in [Optimization research](../research/optimization-architecture.md) and the [closed-directions index](../research/closed-directions.md); they are evidence from those experiments, not current guarantees or extra build gates.

Self-build extern preparation uses one TypeWorld and one typed render.
`typedModuleFragmentsDir` factors complete declaration closures into disjoint
files with module-owner sets; the build maps those owners to original source
entries and selects files per connected Closure job. Shared declarations and
namespace initializers appear once, including when two roots share a job.
Unscoped typed files, explicit rename barriers and native contracts remain
global. Do not substitute namespace-text filtering or repeated per-entry
builds for this ownership information.

The native preparation ABI consumes only metadata counts and emitted
filenames; full declaration templates remain available to their real
TypeScript consumers without being copied through N-API again. External
serialization keys must remain explicit at the producer: the resident Java
driver's `args` request key is computed/quoted rather than accidentally
protected by unrelated library externs.

## Native packaging and releases

[`scripts/build-native.mjs`](../../scripts/build-native.mjs) builds the Rust `cdylib`, copies the host addon to `native/index.node` unless disabled, and writes the binary, license, and platform manifest under `npm/<platform-package>`. [`src/native/index.ts`](../../src/native/index.ts) tries a local development addon before a matching optional package selected by OS, architecture, and Linux libc. A working checkout with a local addon does not establish that the published optional package loads.

[`scripts/native-targets.mjs`](../../scripts/native-targets.mjs) is the supported target/metadata authority shared by native builds, package verification and release preparation. It derives platform package names and validates OS, architecture, libc, target selection and coordinated versions. Conflicting or unsupported selectors fail before reaching toolchains or replacing package directories. Multi-target or non-host builds do not replace the checkout's host addon. The [native-package workflow](../../.github/workflows/native-packages.yml) maps these targets to runners; it builds and uploads all platform artifacts before the release-preparation job can publish anything.

For the root package, [`package.json`](../../package.json) owns exports, CLI, optional native dependencies, and packed-file selection. Only reference documentation ships; development and research guides are repository-only. `verify:package` packs **existing** root and host-native outputs, so prepare those first when source has changed. Its isolated consumer extracts the root and selected optional-native tarballs with no checkout-local addon, checks declared targets and exact public declaration coverage, compiles a NodeNext consumer, imports under Node/Bun, and runs a native-backed build whose output evaluates to the expected value. A second fresh process must fail after removing that consumer's addon. Other runtime dependencies are linked from the checkout: this is stronger than a checkout-local loader smoke, but not a clean registry install. It executes only the host native target, not every release binary.

[`npm-command.mjs`](../../scripts/npm-command.mjs) always uses system Bun's `pm pack` with scripts disabled and an explicit unique archive filename. A script running under Bun uses its own executable; a Node script uses `bun` (or `bun.exe`) on `PATH`, including in CI. There is no npm pack/JSON-output branch. Verification and publication consume that exact archive; they do not assert byte-identical gzip archives across different packers or tool versions. Publication remains on the npm runner and its existing authentication path.

```sh
bun run prepare:release
```

[`prepare-release.mjs`](../../scripts/prepare-release.mjs) checks install sanity and Rust hygiene, forces a cache-off stage-2 self-build, packs root and host-native packages once, records their SHA-256 digests, and verifies those exact tarballs. Packing and native-archive checks use bounded concurrency of two with stable target order. Independent NodeNext, Node/Bun import and CLI consumers drain before the sequential positive/negative native-addon proof deletes its isolated addon. Native target discovery is shared, while Cargo target builds stay sequential. It prints the temporary directory of prepared artifacts and leaves them there for inspection; it does not upload. `bun run prepare:release --all-native` instead requires all platform package directories under `npm/`, validates the coordinated set before building, and uses the supplied host package for self-build. Every native tarball is extracted and checked for metadata and a nonempty regular addon, but only the host tarball receives the runtime consumer proof.

`bun run publish:npm` requires that complete native artifact set and is an **actual publication command**. [`publish-npm.mjs`](../../scripts/publish-npm.mjs) calls preparation itself, verifies the complete digest set before the first upload, rechecks each archive immediately before its upload, then publishes native tarballs followed by the root tarball with scripts disabled. It neither rebuilds nor repacks after verification, and it removes its temporary artifact directory afterward. `bun run publish:npm --dry-run` takes the same preparation/verification path without uploading. Arbitrary npm options or unverified paths are rejected.

[`prepublish-guard.mjs`](../../scripts/prepublish-guard.mjs) rejects direct directory `npm publish`; it is not a second build hook. All verification must finish before upload starts, but npm publication remains nontransactional: an upload failure can leave an already-published subset. A default build, the curated `test:fast` lane, or parser probes alone do not establish release readiness; the preparation script itself also does not run the full runtime suite or example-byte gate.

Release CI uses npm trusted publishing: the preparation/publication job requests `id-token: write`, configures the registry, and installs npm `12.0.2` without a stored token. Configure the exact repository trusted publisher on npmjs.com for the root and each platform package. A new platform package needs a bootstrap publish before that trusted publisher can be attached. The native builder copies the root manifest's repository metadata into platform manifests.

## Generated files

`bin/`, `dist/`, `native/index.node`, `native/target/`, `npm/`, and example output directories are generated. Rebuild their sources; when deliberately updating tracked example artifacts, use the [reproducibility workflow](#official-example-reproducibility) to explain the new bytes. Debug captures (`.gcc-debug`, `.investigate-*`, Vite `vite-capture`), cache directories, and temporary workspaces are generated state too, not implementation sources.
