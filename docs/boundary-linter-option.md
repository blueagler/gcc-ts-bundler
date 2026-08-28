# Option: a standalone boundary linter

Priced proposal, not a plan. The question: should the ADVANCED pass be
sold as *proof*, for teams that never ship Closure output — a linter
that reports dead exports, rename-unsafe boundary contracts, and
reflective property hazards?

The by-product already ships. `src/vite/types.ts` (report option
docstring) states it outright: "The report is useful even when you
ship stock Vite output: dead modules and pinned properties are
findings about your graph, not about this bundler." This document
prices promoting that sentence into a product surface.

## 1. User-visible surface

One new subcommand beside `build` / `externs` / `clean-cache`
(dispatch pattern: `src/cli/run.ts`), reusing the documented build
flags:

```sh
gcc-ts-bundler lint --project-root=. --src-dir=./src --entry=./index.ts \
  --report=./gcc-lint.json --preflight=full
```

Runs the same whole-program ADVANCED job the build runs, publishes
nothing, writes one JSON report. Shape follows the `ViteBuildReport`
precedent (`src/vite/types.ts`, written by `src/vite/report.ts`,
default file `gcc-report.json`): versioned, every number measured on
this run's artifacts, nothing estimated.

```jsonc
{
  "version": 1,
  "deadExports":       [{ "module": "src/util.ts", "export": "legacyParse" }],
  "unsafeBoundaries":  [{ "contract": "Settings", "member": "retries",
                          "site": "src/http.ts:41", "channel": "indexed-key" }],
  "reflectiveHazards": [{ "name": "events", "site": "src/store.ts:12",
                          "reader": "dataPriv.get" }]
}
```

Exit non-zero when findings exceed a threshold, mirroring how
`bun run verify:examples` treats its floors as kill criteria.

## 2. Exists vs. must be built

| Capability | Status | Anchor |
|---|---|---|
| Whole-program ADVANCED link proving modules dead | exists (Vite path) | `src/vite/report.ts` `collectDeadModules` |
| Versioned evidence-report writer + JSON shape | exists | `src/vite/report.ts`, `ViteBuildReport` in `src/vite/types.ts` |
| Boundary contract collection (interfaces/aliases/classes at package boundaries) | exists | `src/externs/contracts/registry.ts` `collectContracts` |
| App-side usage analysis of those contracts | exists | `src/externs/contracts/usage.ts` `analyzeAppUsage` |
| Rename-barrier scan + hand-written extern audit | exists | `src/externs/barriers.ts` `auditExternFiles` (already run non-fatally by `src/api/build.ts`) |
| Reflective key detection (literal/indexed/constructed keys, key-reading callees) | exists | `src/externs/runtime/{literal-keys,indexed-keys,constructed-keys,key-reader}.ts` |
| External boundary plan with fail-closed uniqueness invariant | exists | `src/externs/build-plan/external-plan.ts` `deriveExternalExternPlan`, `assertUniqueExternVarDeclarations` |
| Per-channel name attribution with real input sites | exists (script, not product) | `scripts/property-ledger.ts` `indexInputSites`, `parseRenamingReport` |
| Framework knowledge as generic config | exists | `src/presets/{react,svelte,vue}.ts` |
| `lint` subcommand + flag parsing | build | extends `src/cli/run.ts`, `src/cli/parse/` |
| Core-path report (dead evidence exists only against a Vite chunk baseline today) | build | new collector beside `src/build/pipeline` |
| Export-level granularity (today: module-level) | build | diff the export bag / removal evidence |
| Findings with source locations (today: name lists + extern lines) | build | productize the `property-ledger` site indexing |
| Proof-only mode (compile, publish nothing) | build | short-circuit publication stage |

## 3. Effort

| Item | Days |
|---|---:|
| CLI `lint` subcommand, flags, exit-code policy | 1 |
| Core-path evidence collector + lint report writer | 3 |
| Dead-*export* granularity on the whole-program link | 2 |
| Rename-unsafe boundary findings with `file:line` sites | 3 |
| Reflective hazards as diagnostics (re-surface `src/externs/runtime` collectors) | 2 |
| Proof-only build mode | 1 |
| Docs + smoke run across the five committed examples | 1 |
| **Total** | **13** |

`[INFERENCE]` — estimates assume no native/Rust changes; all listed
work is TypeScript-side over existing collectors.

## 4. Risks

- **False positives are structural, not bugs.** Dead-export proof is
  sound only relative to the entry set; HTML-referenced scripts,
  tests, and server entries look dead. And the hazards the linter
  warns about are exactly what the analysis can miss — jQuery reads
  its handler store by string key (`README.md`, jquery example); a
  missed reader means a false "safe to rename".
- **Framework compat is load-bearing.** Without the presets
  (`src/presets/*.ts`) configured, React/Svelte/Vue apps flood the
  report with host props and framework internals. The linter must
  accept preset input on the CLI — a surface that exists only as
  Vite plugin options today.
- **Vite mirror: not required, but fidelity on Vite apps is.** The
  linter rides the standalone core (`src/api/build.ts` →
  `src/build/pipeline`), same as the `externs` subcommand — no
  mirror dependency. But SFC/JSX transforms produce the actual
  reflective sites; linting authored source of a Vite app misses
  them. v1 lints plain TS graphs honestly and says so.
- **Cost vs. incumbents.** ADVANCED-as-proof is a whole-program
  compile — cold builds ~10x stock Vite (`README.md`, Results and
  limits). knip/ts-prune answer the dead-export question in seconds
  without proofs. The pitch is soundness; the tax is minutes.
- **Maintenance couples to Closure internals.** Findings depend on
  the renaming report and removal evidence; that surface has already
  produced a truncated-report defect once (renaming-map validation
  in the resident driver). Every Closure upgrade re-verifies the
  linter, not just the bundler.

## 5. Recommendation

**No-go now.** The zero-cost probe already exists: the Vite plugin's
`report` option writes dead modules and pinned properties on every
build, even for teams comparing against stock Vite output
(`src/vite/types.ts`). Ship nothing, watch that channel.

**Adoption criterion that flips it to go:** within one quarter, at
least three independent external requests or issue reports that cite
`gcc-report.json` findings from apps shipping *stock Vite* output —
i.e. users deriving value from the proof while discarding the
optimizer. That is direct evidence the by-product carries demand at
zero marketing cost; 13 days is then a priced bet, not a hope.

## 6. Non-goals

- No autofix, no ESLint plugin, no editor integration, no watch mode.
- No speed parity with heuristic dead-code tools; soundness is the axis.
- No Vite-graph fidelity in v1 (no mirror dependency, stated above).
- No shipping of Closure output — the linter never writes to `outDir`.
- No new framework special cases in core; presets remain the only channel.
