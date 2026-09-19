# Architecture

This guide explains who owns each compiler handoff and which invariants survive it. For a change starting point, use [Change routes](changes.md); for commands and evidence, use [Workflows](workflows.md). Public options and limitations belong to the [API](../reference/api.md), [CLI](../reference/cli.md), and [Vite](../reference/vite.md) references.

## Ownership and boundaries

There is one core compiler pipeline: TypeScript orchestrates the build and supplies semantic metadata, Rust/Oxc resolves and lowers modules, and Closure performs whole-program optimization. The Vite plugin feeds that pipeline a host-owned graph; it is not another compiler implementation.

| Owner                                                                                                                  | Owns                                                                                       | Handoff                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [`src/api`](../../src/api), [`src/cli`](../../src/cli)                                                                 | Public facade and command-line adaptation                                                  | Build request to the core                                                        |
| [`src/build/pipeline.ts`](../../src/build/pipeline.ts), [`src/shared/cache-store.ts`](../../src/shared/cache-store.ts) | Invocation resources, failure conversion, project-cache lock                               | Owned cache store passed into resolution                                         |
| [`src/build/resolve`](../../src/build/resolve), [`native/src/graph`](../../native/src/graph)                           | Normalized paths, workspace, fresh configuration, dependency resolution and chunk planning | Resolved graph, entries, imports, preserved modules, content identities          |
| [`src/build/transpile`](../../src/build/transpile), [`native/src/transpile`](../../native/src/transpile)               | Shared semantic analysis and native emit                                                   | Closure-compatible JavaScript, delivered metadata, native externs, support files |
| [`src/externs`](../../src/externs)                                                                                     | Typed external surfaces and property barriers                                              | Closure declarations for runtime code it does not own                            |
| [`native/src/closure_jobs`](../../native/src/closure_jobs), [`src/build/closure`](../../src/build/closure)             | Job planning, compiler lifetime, postprocessing                                            | Staged output and reusable compiler artifacts                                    |
| [`src/build/cache/final`](../../src/build/cache/final)                                                                 | Canonical final manifest, publication preparation and per-destination commits              | Published files and build result                                                 |
| [`src/vite`](../../src/vite)                                                                                           | Capture, retained graph, dependencies, CSS/assets, final naming                            | Host graph into the core; compiled JavaScript back into the Vite bundle          |
| [`src/native`](../../src/native), [`src/shared`](../../src/shared)                                                     | N-API validation and filesystem/cache primitives                                           | Checked runtime data, not merely TypeScript assertions                           |

The standalone graph is JavaScript/TypeScript. Vite owns framework transforms and assets before the core sees the retained JavaScript graph. Package assets in [`closure-externs`](../../closure-externs) and [`closure-lib`](../../closure-lib) are compiler inputs, not documentation fixtures.

## Core build flow

[`src/build/pipeline.ts`](../../src/build/pipeline.ts) owns this sequence:

```text
normalize request -> create build context -> acquire persistent project lock
-> acquire CacheStore -> resolve fresh config, native graph and chunk plan
-> restore canonical final artifacts OR prepare entry shims and required type world
-> extract metadata and emit native Closure inputs
-> allocate invocation staging -> assemble Closure-only external declarations
-> prepare and compile/restore Closure jobs
-> postprocess, emit preserved modules, finish JavaScript
-> prepare canonical manifest, destination mappings and relocated bytes
-> commit cache tree, output tree and external outFiles separately
-> clean every owned resource -> release project lock -> return result
```

The workspace exposes authored sources through `workspace/src` and, when package resolution is enabled, links the nearest project `node_modules`. Resolution needs a `tsconfig.json` discoverable from `projectRoot`. Every invocation reparses configuration and rebuilds the native graph and chunk plan before final-cache reuse is considered. There is no persisted resolve snapshot or published-output fast-return layer. Later stages consume that invocation's authoritative graph; they must not independently rediscover its import targets.

### Chunk planning and linking

[`native/src/graph.rs`](../../native/src/graph.rs) and [`native/src/closure_jobs.rs`](../../native/src/closure_jobs.rs) fold public `split` and `bundler-runtime` modes into the same native execution path. That graph is compiled as one Closure job. Planner entries carry `outputName`, `sourcePath` and `shimPath` together; off mode walks each entry's own shim rather than a parallel shim list. Host Rollup projections supply file identity, static import edges, entry/module membership and chunk names — not unused dynamic-chunk filename lists. Off mode may share implementation chunks between entries; connected components determine compiler jobs. Public mode/output compatibility belongs to the [API reference](../reference/api.md).

The native [hoist layer](../../native/src/transpile/hoist) owns binding and namespace linkage across the chunk plan. In off mode, [`emit_goog/live_bindings.rs`](../../native/src/transpile/emit_goog/live_bindings.rs) derives live imports, aliases and reexports from authoritative resolved-import identities, not a second filesystem resolution pass. [`shims.rs`](../../native/src/shims.rs) transports public bindings as getters; [`exports.rs`](../../native/src/exports.rs) removes that transport after optimization only when the binding-protocol bootstrap is present. A same-spelled user export without that bootstrap is not a protocol message. These are internal compiler protocols, not callable public APIs.

Dense registry slots are internal storage, not the public module namespace. Lazy imports, namespace imports and namespace reexports select a stable getter facade; ordinary named imports and CommonJS transport still address internal slots. Public namespace keys must not expose numeric slots, renamed aliases or synthetic CommonJS storage. Facade getters retain live binding updates.

Raw-slot, goog-live and hoist analysis share export-topology classification. The collector runs against each stage's appropriate authored or lowered syntax; liveness, dense slots and enum erasure remain separate policies. `export default expression` owns a snapshot, while `export { value as default }` is a live binding. Snapshot lineage used for enum erasure must not become a live forwarding edge. Goog emission initializes static dependencies before body statements while preserving dependency declaration order.

Runtime linking plans helper renames and module-index rewrites against one original AST and applies one edit list. A single readable/debug policy controls registry storage and diagnostics; text-only renderers are infallible, while parsing and identity checks still return real errors. Chunk index zero is valid for both dynamic import and preload. Multi-chunk hoisted emit pins assigners for the whole plan; a single-chunk plan has nowhere to move them.

Const-enum source exports carry their classification through aliases and export stars. Runtime export filtering and metadata share the TypeScript retention policy: explicit `preserveConstEnums`, `isolatedModules` or `verbatimModuleSyntax` retains the object; otherwise its runtime export names disappear. Retained enum objects keep original member names and numeric reverse mappings. Generated entry shims use a namespace-record view only for retained const-enum values, without disabling authored TypeScript diagnostics or degrading ordinary export getter types.

[`pathing.rs`](../../native/src/pathing.rs) validates module/output identities before graph facts or emitted files can collide; [`transpile_run`](../../native/src/transpile/transpile_run) also rejects writes over source inputs. A lowering change must preserve evaluation order, binding updates and shadowing—not only produce parseable JavaScript. Unread literal-only ESM namespaces may drop the generated IIFE while keeping `N || (N = {})` and each property write in order; exported, merged, written, evaluated, or locally-read namespaces keep the wrapper. Chunk names, module ownership and lazy-import targets remain inputs to both compilation and delivery.

### Type metadata and the Oxc envelope

Syntax candidates are indexed by `SourceFile` identity and shared by metadata
collectors without changing their phase order or diagnostic coverage.
Successful alias, symbol-spelling and canonical-identity queries are memoized
only within their owning type-render context/checker. Rendered types, failed
queries and recursion-sensitive diagnostics are not cross-context caches.
Preflight and metadata extraction continue to share the same `TypeWorld`.

External ownership caches ordered type identities, normalized source filenames
and file-provenance answers within one origins collection. File inputs are
complete before those caches are created. Boundary-type membership and owned
properties remain live checks because their sets are populated afterward;
recursive boundary answers are never memoized across query-local visited sets.
Contextual alignment also reuses property lookups by receiver type/name and
declaration-site property types by symbol/declaration within that phase only.
Generic instantiations sharing a declaration must retain distinct symbols.
Use-site type queries and recursive alignment outcomes are not cached.

Ordinary native PURE-comment discovery borrows the parsed program's source
text. Decorator metadata retains the existing effective-file fallback; this
does not widen the native preparation ABI or create a second source cache.

[`src/build/transpile/emit.ts`](../../src/build/transpile/emit.ts) coordinates analysis, metadata reuse and native emission. The runtime semantic API comes from `@typescript/typescript6@6.0.2`; the repository's TypeScript 7 CLI/declaration tooling has a separate role described in [Workflows](workflows.md#build-lanes). Standalone builds and Vite use the shared metadata representation; Vite additionally supplies runtime-source provenance. Declaration probing uses compiler options without creating a program. A `TypeWorld` is created only for typed extern generation, analysis without a metadata sidecar, or Node ambient globals. Skipped-program paths still protect tsconfig declarations and their transitive references from output publication. `closure-ir.json` is the semantic handoff, while native emit reports the metadata actually delivered to each output. Extracted counts and delivered counts are not interchangeable.

Graph resolution parses each fresh module once and collects dynamic-import/CommonJS facts from that program. Native graph arrays pass directly to their consumers instead of cycling through a JavaScript record. Scoping-only semantic consumers disable Oxc's node store, but hoist live-writer analysis retains it because it walks reference ancestors. Binding-sensitive rewrites require checked symbol identity; identifier spelling is not a substitute under shadowing. CommonJS classification, normalization and import preparation share one parsed program. Preparation mutates the AST before semantic construction, retains authored spans for moved bodies, and quotes generated CommonJS protocol accesses consistently. Preserved-module import rewrites also update the existing AST. Hoist planning shares CommonJS/export topology for the emitted program, moves owned import payloads, and resolves binding and namespace linkers from one export-name enumeration.

CommonJS wrappers own the initial `this` receiver independently of mutable `module.exports`. Keep that object identity stable through Closure optimization so arrows retain the original receiver after exports reassignment.

The native prelude collects complete authored enum facts before AST mutation; named import consumers borrow those facts instead of reparsing compiled targets. Uncovered declaration/source fallback paths retain their independent discovery. Decorator property names come from the already-parsed lowered program, with standalone parsing only for metadata inputs outside prelude coverage. Lazy-import lookup retains authored file identity even when decorator lowering changes the effective syntax filename.

Metadata and declarations are borrowed while their owner remains alive. Native preparation no longer serializes rewritten source or remaps metadata offsets; separately mutated target outputs still get separate records. Diagnostics and reference maps supply their own counts; object-literal brands have one shape-to-declaration owner. TypeScript module-resolution caches belong to one invocation or declaration batch, never a process-wide negative cache. Runtime-usage analysis reads and parses runtime files independently; it does not reuse `TypeWorld` ASTs. Only boundary-usage analysis constructs its `ContractRegistry`; nominal usage retains the member-name set consumed by extern rendering, not separate per-symbol static and instance inventories. Constructor and receiver contracts use the same program's checked symbols, never a class-name lookup; unresolved imports cannot borrow an unrelated package's contract. Mutually recursive type renderers are colocated in `type-render/to-closure.ts`, without a mutable registration lifecycle or a module cycle that Closure cannot compile.

The native emit cache includes chunk membership and opaque external specifiers because they affect emitted linkage. Authored membership is an invocation value (`authoredFiles`), not a JSON path or process-global memo. The Vite runtime source-map output remains a sidecar and participates in native artifact validation. Source facts needed after lowering—such as decorator/property keys—must enter metadata or preserved-property channels before Closure rather than being guessed from optimized text.

[`native/src/closure_capabilities.rs`](../../native/src/closure_capabilities.rs) owns the syntax boundary for `google-closure-compiler@20260909.0.0`; the Oxc family is pinned to `0.150.0`. Direct parser measurements for this compiler are private class elements **false**, class static blocks **true**, and top-level await **false**. The prebundle target remains `es2021`. These parser measurements do not prove native lowering or application runtime gates passed.

Oxc lowers private elements around that boundary. [`graph/deps.rs`](../../native/src/graph/deps.rs) classifies module-level `await`, `for await` and `await using`, while excluding nested function/arrow bodies; the resolver preserves unsupported module-level await rather than feeding it to Closure. Compiler-upgrade evidence comes from the [direct jar probes](../../test/native/closure-capabilities.test.mjs), then separate lowering/runtime cases.

### External boundaries and compilation

Typed fragment ownership uses iterative strongly connected components and
compact module-owner sets when declaration closures actually overlap.
Disjoint closures bypass component factoring. Declaration order, shared
namespace ownership and independent diagnostic multiplicity remain contracts.

Used-export discovery indexes namespace-import spellings before visiting uses,
including forward references and nested ambient modules. Unrelated identifier
spellings bypass the checker; candidates still resolve their actual symbols,
so lexical shadows do not become namespace uses. Local export specifiers keep
their semantic alias lookup regardless of spelling. This changes query work,
not the export-selection policy or selected declaration/member coverage.

Node ambient discovery is shared within one prepared-job invocation. A supplied
`TypeWorld` supplies declaration semantics; emitted-only binding discovery still
distinguishes genuine free globals from lexical shadows. Rendering reuse is
keyed by the complete free-global set, not by a subset from another job.

Runtime external modules are not Closure inputs. [`external-plan.ts`](../../src/externs/build-plan/external-plan.ts) generates their used seed declarations with a bounded type closure. This is distinct from self-build public API externs, whose surfaces must be complete before publication.

[`create-type-world.ts`](../../src/externs/build-plan/create-type-world.ts) puts emit inputs, TSX support, tsconfig ambient declarations and resolved external declaration roots into one shared program. Node ambient roots are included even without a builtin import. [`generate.ts`](../../src/externs/generate/generate.ts) resolves typed seeds before creating its analysis context and renders one typed batch, preserving shared declaration identity. Shared [`value-identifier classification`](../../src/shared/typescript.ts) distinguishes actual reads from accessor/binding keys; optional global-protocol evidence must not protect unrelated local receiver properties merely because their names match a bare global.

Extern assembly has two producers: native untyped boundaries and TypeScript-derived typed declarations. `assembleExternalExterns` treats cached native extern bytes as immutable and writes a Closure-only assembly into invocation scratch. A typed declaration replaces only its exact untyped target; initialized namespace roots and unrelated property carriers remain. Duplicate variable declarations are rejected. Required explicit/native extern inputs fail closed; that is separate from the automatic external-type planner's documented opaque fallback when declarations cannot be resolved.

[`compile-jobs`](../../src/build/closure/compile-jobs) owns compiler artifacts, stable renaming-map reuse and prepared-job execution. Silent type inference is gated on ADVANCED and delivered declaration **and** member-annotation counts; platform-extern slicing has its own gate. The [resident driver](../../src/build/closure/driver) is preferred when its probe succeeds; the installed compiler implementation is the fallback. Its shipped source, [`closure-lib/ResidentCliWorker.java`](../../closure-lib/ResidentCliWorker.java), uses a direct `CommandLineRunner` subclass with a fresh runner/compiler per job, not reflective access to compiler internals. First use compiles into a private source-hashed cache. The queue, bounded reply frames and fresh job state are lifecycle boundaries, not a compiler-state cache. A failed resident session is terminated and awaited before fallback may write the same paths. Spawned fallback results also wait for process/stream closure. Diagnostics belong to the retained attempt, not a discarded retry.

[`src/shared/concurrency.ts`](../../src/shared/concurrency.ts) stops admitting work on the first rejection, drains already-active jobs and only then rejects. It preserves successful result order. A concurrency limit controls prepared jobs; it is not a separate optimizer lane for each runtime chunk. Resource owners may clean staging or release locks only after their writers have drained. File snapshot collection, validation and published-output hashing reuse this helper with eight lanes per operation; digests and file membership remain authoritative.

### Delivery invariants

[`run-closure/finalize.ts`](../../src/build/closure/run-closure/finalize.ts) owns postprocessing, preserved-module emission, shebangs, empty-chunk pruning, finishing and canonical compiler-output caching, in that order.

- **Preservation is a graph boundary.** The [resolver](../../native/src/graph/resolve.rs) requires configured preserved modules to be entry-reachable, promotes their static dependency closure and rejects recorded dynamic imports targeting the preserved set. Preserved modules are emitted separately; TypeScript can be erased and sources reprinted, so preservation is not byte copying. They are excluded from final minification.
- **Pruning keeps runtime addresses valid.** [Empty-chunk pruning](../../src/build/closure/prune-empty) updates dependencies and ownership without invalidating lazy roots or dense manifest indices embedded in runtime calls.
- **Preparation precedes publication.** [`persist.ts`](../../src/build/cache/final/persist.ts) records canonical cache artifacts as unique safe relative names, sizes and digests. [`publish.ts`](../../src/build/cache/final/publish.ts) validates mappings and prepares relocated imports and temporary external files before committing destinations.
- **Publication owns the output tree.** Fresh builds and cache restores replace `outDir`, rather than merging. Unrelated files there can be removed. Off-mode external `outFile` relocation removes the original emitted entry from the published tree and returned list, but never rewrites canonical cached bytes. Restore copies those bytes into an output-sibling staging directory and repeats destination preparation. Fresh compilation owns output and compiler-cache staging roots; scratch externs share the latter's raw-input directory. Only persistent cache mode copies canonical final outputs; `off` and `temp` publish the staged output directly.
- **Commits remain separate.** The cache directory, `outDir` and each external destination are independent commits. Preparation failures precede those commits, but a later commit/cleanup failure can follow an earlier successful publication. This is not whole-filesystem atomicity.

## Persistent cache

Before final-cache restoration, external type resolution observes the bytes of
consulted package manifests and the identity/content of resolved declarations,
including importer-local lookup roots. Newly appearing or nearer declarations
must invalidate reuse. Identical manifest or declaration rewrites do not
invalidate solely because their timestamps changed; resolution observations
are deduplicated within the invocation, never retained as process-wide
negative results.

[`src/shared/cache-store.ts`](../../src/shared/cache-store.ts) owns platform cache roots and the absolute-project-root namespace. Configuration belongs to the [API reference](../reference/api.md); this section describes reuse boundaries.

| Reusable state                     | Owner / validity boundary                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite metadata sidecars             | [Metadata cache](../../src/vite/type-metadata/cache.ts): semantic metadata and dependency provenance                                               |
| Native emit                        | [Emitter cache](../../src/build/transpile/emit-native/cache.ts): emitted artifacts, metadata, input state and chunk shape                          |
| Closure jobs / renaming maps       | [Compiler jobs](../../src/build/closure/compile-jobs): effective inputs, externs, compiler environment and map identity                            |
| Canonical final manifest and bytes | [Final cache](../../src/build/cache/final): fresh graph/config-derived key, package/options signatures, metadata dependencies and artifact digests |

A final-cache hit validates canonical artifacts and republishes them, including replacing modified or missing output. It does not trust the previous destination tree. [`Package identity`](../../src/build/resolve/signatures.ts) includes deterministic relative names, contents and membership of owned shipped JavaScript trees, including shared implementation behind stable public facades, plus package metadata and the optional local addon. It does not traverse dependencies. Stable renaming maps are mutable project state, separate from immutable job artifacts; map changes can change subsequent job keys. A warm build is not a fixed-duration promise.

`temp` and `off` allocate isolated temporary workspaces rather than cross-build persistent state. Metadata dependencies travel as paths for output protection in these modes, without computing persistent-cache digests. Persistent builds capture content identities before native emission and retain them through both cache writers. Off also disables Closure artifact restoration. Persistent core builds hold one project-cache lock across mutable stages. Dead-owner or stale unidentified locks fail closed with an exact-path manual-recovery diagnostic; they are never stolen automatically. An operator must establish that no build is active before removing that lock. Release checks the acquisition token and refuses to remove another owner's lock.

## Failure and resource boundaries

The pipeline records ownership of `CacheStore` before resolution begins. Its failure boundary covers normalization, setup, compilation and publication; cleanup attempts invocation staging, the cache store and finally the project lock, independently. Operational and cleanup errors return `BuildFailure`; aggregate errors retain primary and cleanup diagnostics. A cleanup failure after otherwise successful publication still returns failure. This fixes the earlier setup ownership gap: no returned `ResolvedBuild` is required to dispose an acquired temporary workspace.

Filesystem caches, native results, compiler packages and generated sidecars cross runtime trust boundaries. Their owners validate incoming data. [`syncDirectoryEntries`](../../src/shared/files.ts) validates the complete destination set before sweeping, permits symlinked ancestors such as linked checkouts or `TMPDIR`, and rejects a symlink as the selected root or along an expected inner/leaf destination. It is an owned-staging primitive, not a hostile concurrent-filesystem sandbox.

A representation change needs its reader, writer and invalidation path considered together; use [Change routes](changes.md) to find those surfaces. Source ownership describes intended execution, not a claim that all runtime gates have been run.

## Vite adapter

The [plugin compile boundary](../../src/vite/plugin/compile.ts) prepares the captured/retained graph, invokes the core and emits the replacement bundle. Vite transforms source; Rollup supplies retention and the chunk DAG. [`plugin/index.ts`](../../src/vite/plugin/index.ts) retains reusable transforms across watch rebuilds but creates a fresh per-output capture map, prunes vanished modules and resets rendered-output evidence before shaking. Parsed sources live on each capture record, are checked against its current text and disappear with the record; parse metrics are passed by the owning build rather than stored process-wide. Materialization and static-member annotation reuse that record's AST. Captured text uses JavaScript parsing because Vite has transformed it; provenance extensions and query suffixes do not select a second parser policy. Output-specific mutations do not become reusable transform state. Package-format lookup is cached only within that output invocation and refreshed even when Rollup reuses a transform, so an earlier package type cannot survive into the next build.

[`plugin-graph/prepare.ts`](../../src/vite/plugin-graph/prepare.ts) materializes the graph, settles dependency prebundling, then generates externs in every mode from those settled bytes. Original-source provenance remains available to metadata collection; it is not the extern runtime graph. Declaration overlays read only reachable package runtime export inputs and share parsed export facts within one collection. Unused provenance files are not content dependencies; graph membership, declaration dependencies and the independent settled-graph protocol scan still participate in validity. Fused emitted files carry the union of contributing source IDs and are scanned once under their complete sorted package set, rather than once per package; the final runtime-hazard union is unchanged. Clean ESM is materialized directly and unsafe dependencies use esbuild. The core is called with package resolution disabled.

[`plugin-compile/compile.ts`](../../src/vite/plugin-compile/compile.ts) passes the Rollup DAG, CSS-runtime requirement, authored membership and runtime-map output path before Closure. CSS ownership is needed then because final manifest rows arrive later. The adapter defers final minification until names, asset URLs and preserved imports have been rewritten. It replaces Rollup JavaScript while retaining HTML-facing chunk identities. Vite 8 emitted-file URLs cross compilation as canonical placeholders; [`output/asset-urls.ts`](../../src/vite/output/asset-urls.ts) resolves them through the host's real `resolveFileUrl` hook after chunk placement, retaining current reference/URL IDs and public callback field names. An earlier rendered URL is not authoritative for a moved chunk. Emit reads and validates the runtime source map once and shares runtime/host identity joins across naming, CSS and identity restoration. The manifest remains one mutable object through these stages, with existing write boundaries. Asset URL resolution still separates the initial naming pass from the final rehash/naming pass.

**Diagnostic boundary:** the delivered `typeMetadata` branch in [`emit.ts`](../../src/build/transpile/emit.ts) uses sidecar analysis instead of standalone semantic preflight. Required-input checks still run, but this does not establish that Vite rejects every original-source TypeScript error. Metadata delivery and semantic checking are distinct contracts.

The [capture workspace](../../src/vite/workspace.ts) has its own lifecycle and, for stable roots, a distinct lock held through emission. In persistent mode, core publication gets an invocation-owned external temporary root, separate from cached capture inputs; a fresh destination can reuse canonical bytes because out-of-project output paths key as `..`. Adapter final staging remains capture-owned. Disposal attempts the external root, applicable temporary captures and lock release independently. Temporary captures are removed; persistent captures remain. Debug mode owns only the `gcc-ts-bundler` child of the requested directory, not the caller's entire directory. Unsupported transforms, ordering and worker graphs belong to the [Vite reference](../reference/vite.md), not inferred compiler capabilities.
