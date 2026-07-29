# Release notes draft (unreleased — covers the correctness/externs/annotation program)

Draft for the next release. Numbers below were independently re-verified by
the final integration validation (V3); reports live in `/tmp/gcc-*.md` during
development and the durable design rationale in `docs/research/`.

## Breaking

- **`generateExterns` `candidates` mode removed.** It pinned entire declared
  type surfaces (+3,480 gzip on the React example) and is superseded by
  evidence-derived generation. `boundary-aware` and `runtime-aware` remain.
- **`ResolvedBuildOptions` and `fatalWarnings` removed** (dead API).
- **`lint` script is now read-only** (`format --check`, `eslint` without
  `--fix`); use the new `fix` script to mutate.
- **Structured extern module form**: extern modules are declared with
  `runtime: "external" | "compiled"`; typed declarations render only for
  external modules.

## Correctness

- `export * as ns from` no longer produces an empty namespace object
  (silent miscompile; fixed in both the emitter and the chunk-graph
  collector, locked by an executing regression).
- `export = x` sources no longer emit an unbound `module.exports` write
  (every `export =` consumer was affected; rewritten to a default export
  before strip).
- TypeScript namespaces no longer emit syntactically invalid JavaScript
  (assignment-in-binary and function-expression-statement precedence
  normalizer over swc output).
- `const enum` now matches `tsc` semantics: erased with member reads inlined
  (honors `preserveConstEnums` / `isolatedModules`); previously a runtime
  object was materialized and exported.
- Ambient `.d.ts` files are now part of the checker program exactly as `tsc`
  would include them (tsconfig `files`/`include`/`types`/triple-slash refs);
  ambient globals route to externs, `declare module "x"` members never pin.
- Declaration merging synthesizes one declaration per merged symbol
  (was: per site → duplicate declarations).
- Extensionless imports of dotted filenames (`./enum.untyped` →
  `enum.untyped.ts`) resolve correctly; real extensions keep byte-identical
  behavior.
- Platform extern slicing no longer drops bare-global browser functions
  (`window.setTimeout` and friends were renamed under `platformExterns:
  "minimal"` — silent page-breaking miscompile, now regression-locked).
- New generic evidence class `selfReferentialKeys`: a string literal value
  naming a sibling object-literal key (jQuery's `easing._default: "swing"`)
  pins that key. The jQuery demo now ships zero hand-written externs.
- CommonJS export names now participate in renaming when provably safe
  (`OpaqueCommonJs` verdict drives all three emission sites; reflecting
  packages fail closed). React example: −2,322 raw / −557 gzip.
- Deleted three unsound post-Closure text transforms (decorator-metadata
  string rewriting, ES5 helper fingerprint substitution, `replaceAll` root
  canonicalization) that could corrupt user data and code.

## Robustness (measured on tsickle's own 157-suite corpus)

- Robustness score 118/132 vs tsickle 109; there is no suite tsickle builds
  that we do not, and we build 9 it cannot. Correctness is a tie with zero
  unique defects on either side.
- Type rendering adopted the hardened tsickle translate-table rows
  (`unknown → *`, `{} → *`, tuples, enum literals, `function(new:T)`
  nullability, `this`-params, `?<...>` guard, and more) — each row carries a
  regression test naming the trap it encodes.

## Performance

- Closure jobs already run on the GraalVM native image (spawn ≈ 5 ms).
  Platform-extern archive identity is now `(path, size, mtime)`-keyed with a
  content-hash slow path, removing a 147 ms jar read from every warm build;
  generated slices are cached per project keyed by schema digest, jar hash,
  and seed-set digest.
- Persisted platform-extern index is guarded by a schema digest derived from
  the parser source (stale manual version constants can no longer serve wrong
  slices machine-wide), and tests can never write the machine-shared cache
  (injectable cache roots, enforced by regression).
- Overall example corpus since the program baseline: −77,286 raw (−9.5%) /
  −6,177 gzip with prototype sentinels eliminated (1,659 → 0), while the
  jQuery demo intentionally grew ~5× in exercised behavior.

## Investigated and rejected (with evidence, see docs/research/)

- Owner-typed/`@record` extern shapes: Closure's extern property namespace is
  flat; shape changes nothing — only extern *count* matters.
- J2CL and TeaVM compilation of Closure Compiler to JS/WASM: linker-level
  no-go (reflection/IO/concurrency); would buy ~5 ms.
- Receiver-aware platform-pin reduction: 2 of 1,226 names addressable under
  fail-closed rules until per-access-site owner provenance exists.
- Whole-annotation fidelity as a size lever: tsickle's typed emit is
  byte-identical to its untyped emit across the corpus; annotation work is
  justified by correctness only.
