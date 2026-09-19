# Plan: invert the mirror

Proposal, not an implemented public API. The phases below describe a possible
core/Vite boundary change; source paths and line counts are a planning snapshot.
See [Architecture](../development/architecture.md) for the current boundary and
[Programmatic API](../reference/api.md) for supported inputs. Gate descriptions
also belong to the snapshot; see [current checks](../development/workflows.md#tests-and-checks)
for today's acceptance criteria.

At the planning snapshot, the Vite plugin is a shadow bundler: 15,362 lines whose correctness
contract is byte-mirroring Rollup's emergent output, pinned to `vite ^8.2.0`
(`package.json` peerDependencies). This plan makes the core CLI/API the
product and the Vite plugin one thin, pinned consumer. Every line count below
was measured on this tree (`wc -l` over `*.ts`); `[INFERENCE]` marks anything
not measured.

---

## The thesis in one sentence

**The plugin's 15k lines are not Vite glue; most are compiler capabilities that
happen to live behind Vite's hooks, and each can move behind a public core API
without changing a single output byte — the gates that prove it already exist.**

Measured subsystem sizes (lines of TypeScript):

| subsystem | lines | share of `src/` (44,026) |
|---|---|---|
| `src/vite` | 15,362 | 34.9% |
| `src/build` | 16,687 | 37.9% |
| `src/externs` | 8,673 | 19.7% |
| `src/shared` | 1,416 | 3.2% |
| `src/native` (TS loader) | 783 | 1.8% |
| `src/api` | 430 | 1.0% |

Correction against source: the "plugin is ~80% of the TS code" framing is
wrong. It is 34.9%. What is true — and worse — is that the plugin is the
*only* consumer of five compiler capabilities totaling ~9.7k of its lines
(prebundle 3,757; type-metadata 2,649; naming 1,247; capture+analysis 1,594;
materialize 528), none reachable from the public API in `src/api/types.ts`.
The product cannot be judged, tested, or reused without booting Vite.

---

## Part A — The five seams as built

The pipeline is one chain, `transform` hook to emitted bundle. Owners today:

**1. Capture.** `src/vite/plugin/index.ts` `transform` hook →
`captureViteModule` (`src/vite/plugin/capture.ts`, engine in
`src/vite/capture/index.ts`). Workspace layout (captureRoot, coreOutDir,
finalOutDir, materializedSrcDir, srcDir) in `src/vite/workspace.ts`
(`prepareViteWorkspace`).

**2. Materialize.** `generateBundle` → `compileAndEmitViteBundle`
(`src/vite/plugin/compile.ts`) → `prepareViteGraph`
(`src/vite/plugin-graph/prepare.ts`): retained-graph resolution
(`src/vite/graph/retained.ts`), normalization
(`src/vite/plugin-graph/normalize.ts`), then `materializeCapturedGraph`
(`src/vite/materialize/`) writes the retained subgraph to
`materializedSrcDir`. The CSS-ownership scan (`analyzeViteCssOwnership`,
`src/vite/css/ownership.ts`) runs here, before compile, because only the
Rollup bundle knows which module owns which CSS.

**3. Prebundle.** `prebundleMaterializedDependencies`
(`src/vite/prebundle/index.ts:19`) classifies each materialized dependency
and rewrites unsafe CJS/mixed cores into per-import-target esbuild atoms, in
place. Extern scans await the post-prebundle graph by design — the comment in
`prepare.ts` documents the cache-key race that forced this ordering
(`generated.externs.js` is a resolve/native-emit/Closure cache-key input).

**4. Compile.** `compileViteGraph` (`src/vite/plugin-compile/compile.ts`)
builds options via `createCompilerOptions` (`src/vite/config.ts`), serializes
Rollup's chunk DAG (`serializeRollupChunkGraph`,
`src/vite/rollup-chunks.ts`), and calls core `build()` (`src/api/build.ts`)
with `HostBuildExtensions` (`src/build/types.ts:41`): `cssRuntime`,
`finalMinify: false`, `rollupChunks`, `viteAuthoredFilesFile`,
`viteRuntimeSourceMapFile`. This "host/Vite pocket" is the seam the inversion
widens: core already accepts a host chunk graph and a deferred minify — as a
private type, transported partly through sidecar files written to disk and
re-read.

**5. Rename / CSS ownership.** `emitViteGraph`
(`src/vite/plugin-compile/emit/index.ts:15`) → `finalizeCompiledEmit`
(`emit/outputs.ts:23`): `renameCompiledEmitOutputs` (`emit/rename.ts:48`)
follows Rollup naming patterns, `rewriteAndRenameCompiledFiles`
(`src/vite/naming/identities-rewrite.ts:52`) performs preserved-import
rewriting, identity rewriting, and the deferred final minify in one
read/write per file; `augmentCompiledViteCss` (`src/vite/css/augment.ts:20`)
merges CSS rows into the runtime manifest; asset URLs rewrite in
`src/vite/output/asset-urls.ts`.

---

## Part B — Target architecture

**Moves into core (`src/build`, `src/externs`) as first-class API:**

- **Host build contract.** Promote `HostBuildExtensions`
  (`src/build/types.ts:41-66`) from private pocket to documented API surface
  in `src/api/types.ts`: host chunk graph (`RollupChunkInput` → neutral
  `HostChunkInput`), `cssRuntime`, deferred finalize. Sidecar-file transport
  (`viteAuthoredFilesFile`/`viteRuntimeSourceMapFile`, written then re-read in
  `plugin-compile/compile.ts`) becomes in-memory input.
- **Dependency prebundle.** `src/vite/prebundle/` (3,757 lines) operates on a
  materialized graph directory, not on Vite structures; its inputs are module
  ids, text, and dynamic roots. Any host bundler with unsafe CJS has this
  problem. It becomes a core stage available to `build()`.
- **Two-phase emit.** The compile-then-finalize split (`finalMinify: false` +
  `rewriteAndRenameCompiledFiles` + final minify) becomes a core-owned
  `finalize` API. The non-Rollup parts of `src/vite/naming/` (identity
  rewriting, preserved-import rewriting, final minify) move under
  `src/build`; renaming-map stability stays core-owned as today.
- **CSS manifest rows.** The row-attachment contract becomes public API; the
  runtime preamble already gates the `<link>` loader on `cssRuntime`
  (`src/build/types.ts:43-50`). The *scan* stays plugin — it reads the Rollup
  bundle.
- **Type-metadata collection.** `src/vite/type-metadata/` (2,649 lines)
  collects against materialized files; the sidecar contract
  (`BuildTypeMetadataSidecar`) is already core. The collector moves; the
  process-lifetime memo and sidecar placement (`type-metadata/cache.ts`)
  stay plugin.

**Stays plugin-only:**

- Rollup bundle adaptation: hook wiring (`src/vite/plugin/index.ts`), chunk
  listing (`src/vite/output/`), retained-graph read (`src/vite/graph/`),
  emission through Rollup, naming-pattern derivation, HTML tags, asset URLs.
- Vite config guards: `applyViteBuildGuards`, `build.target` →
  `languageOut` mapping, option-ownership type errors (`src/vite/config.ts`).
- Capture of transformed modules — inherently a Vite `transform` concern.
- The CSS-ownership scan of the Rollup bundle (`src/vite/css/ownership.ts`).

---

## Part C — Phases

Every phase ships alone and is judged by the committed gates: `bun run
verify:examples` (5 example dists byte-for-byte, gzip floors jquery ≥ 10%,
lit ≥ 8% vs stock Vite — README "kill criteria, not build checks"), the
self-build fixpoint (`bun run build`, stage-1/stage-2 byte compare), and
named test files. Effort assumes one engineer, measured lines as the basis.

### Phase 1 — Name the seam

Promote `HostBuildExtensions` to a public host-build input on
`src/api/types.ts`; retype `plugin-compile/compile.ts` and
`src/build/resolve/options.ts` against the public name. No behavior.
*Gate:* `verify:examples` byte-for-byte; fixpoint; `test/vite/plugin.test.mjs`;
`test/build/build.test.mjs`.
*Kill criterion:* any dist byte diff — a rename that changes bytes is not a rename.
*Effort:* 2 days (430-line `src/api` + 410-line `plugin-compile` touchpoints).

### Phase 2 — Two-phase emit as core API

Move identity/preserved-import rewriting and deferred minify
(`identities-rewrite.ts`, non-Rollup parts of `src/vite/naming/`, 1,247
lines) behind a core `finalize` step; plugin passes Rollup-derived rename
maps in.
*Gate:* `verify:examples`; warm-rebuild byte-identity (persistent cache +
renaming maps); `test/vite/path-independence.test.mjs`;
`test/vite/feature-matrix.test.mjs`.
*Kill criterion:* any renamed-identifier drift across a warm rebuild; gzip floors.
*Effort:* 4 days.

### Phase 3 — Prebundle into core

Move `src/vite/prebundle/` (3,757 lines — the largest plugin subsystem)
behind a core API over a materialized graph directory. Preserve the
post-prebundle extern-scan ordering; the cache-key race in `prepare.ts` is
the regression to defend.
*Gate:* `test/vite/feature-matrix.test.mjs` (CJS/mixed fixtures);
`verify:examples` (react/vue exercise atoms); fixpoint.
*Kill criterion:* gzip floors; any atom-content diff; cold build and first
rebuild disagreeing on cache keys.
*Effort:* 6 days.

### Phase 4 — Materialized-graph ingestion

`build()` accepts the host graph (entries, module files, chunk DAG,
authored-file set, runtime source map) as documented in-memory input,
retiring the sidecar files written in `plugin-compile/compile.ts`.
*Gate:* `test/build/workspace.test.mjs`;
`test/build/cache-correctness.test.mjs` (cache keys must stay free of
absolute/caller-supplied paths); `verify:examples`.
*Kill criterion:* cache-key instability; byte diff.
*Effort:* 4 days.

### Phase 5 — Type-metadata collector core-side

Move `type-metadata/collect`, `fusion.ts`, `provenance` (bulk of 2,649
lines) to core, keyed on materialized files; memo and sidecar placement stay
plugin.
*Gate:* `test/vite/type-metadata.test.mjs`;
`test/build/type-metadata.test.mjs`;
`test/build/type-architecture-e2e.test.mjs`.
*Kill criterion:* any `generated.externs.js` diff (it is a cache-key input);
any flip of the type-inference gate
(`src/build/closure/compiler/environment-type-inference.ts`).
*Effort:* 4 days.

### Phase 6 — Thin-consumer audit

Recount `src/vite`. Expected remainder: capture + graph read + config guards
+ CSS scan + emission ≈ 5-6k lines `[INFERENCE]`. Document what a Vite minor
bump must revalidate: only the Rollup-facing modules that remain.
*Gate:* full `bun run test`; measured recount published in this doc.
*Kill criterion:* remaining plugin > 8k lines — the mirror did not move, it
was renamed.
*Effort:* 1 day.

Total: ~21 days.

---

## Part D — Non-goals

- **No new bundler adapters** (webpack/rspack/rolldown) until Phase 6 lands.
  The inversion is judged by what it removes from the plugin, not by a second
  consumer `[INFERENCE]` that a second consumer would be viable.
- **No behavior change of any kind:** no new optimizations, no chunking
  changes, no option renames on the public Vite surface (`docs/reference/vite.md`
  option-ownership table stays as-is).
- **No unpinning of `vite ^8.2.0`.** The pin stays; the inversion changes
  what the pin protects (Rollup-facing modules only, after Phase 6).
- **No scope expansion:** Vite keeps workers, WebAssembly, assets,
  `import.meta.glob`, and CSS transforms (README "Build scope").
- **No extern-depth changes:** `maxSymbolDepth` policy in
  `src/externs/build-plan/external-plan.ts` is out of scope; its gates are a
  separate contract.
- **No plugin deletion.** The plugin remains the reference consumer and the
  carrier of the byte-identity example gates.
