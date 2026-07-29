# tsickle lessons: what to adopt, what to exceed

Source study of `angular/tsickle` @ master (archived 2024-05-13; cloned to
`/tmp/tsickle`). Companion to `externs-v3-boundary-model.md`; feeds W2-2/W2-3.
tsickle is a decade of Google production edge cases — we mine the knowledge,
not the architecture (its goog.module machinery does not apply to us; our
resolver-bound canonical symbol identities already replace
`ensureSymbolDeclared`/forwardDeclare aliasing).

## Where we independently converged (validation)

| Technique | tsickle | us |
|---|---|---|
| Type-only member declarations in `if (false) {}` | `jsdoc_transformer.ts:306` | `type-render.ts`/`docs.ts` (deep-opt wave) |
| Degrade unsupported nodes to `?`, never guess | mapped/conditional/namespaces → warn + `?` | same rule, smallest node |
| Recursion guard on type references | `seenTypes` → `?` (Closure bans recursive typedefs) | typed-render `seen` (fixed this wave after the RangeError) |
| Drop `@template` constraints | names only, `T extends X` ignored | same |

## The translate() table to adopt (type_translator.ts:447-1010)

Verified against source; each row is a trap someone at Google hit in prod.

| TS construct | Closure emission | Trap encoded |
|---|---|---|
| `object` (NonPrimitive) | `!Object` | checked before the switch |
| Template literal types | `string` | flag outside the switch mask |
| `any` | `?` | |
| `unknown` | `*` | **not `?`** — `*` is the ALL type; honest and distinct from unknown. We emit `?` today; switch. |
| `{}` (empty anonymous) | `*` | **not `!Object`** — `!Object` is not a supertype of `string`/`number`, breaks assignability |
| string/number/boolean literals + `StringMapping` | widened primitive | |
| `bigint` | `bigint` | |
| enum member literal | `!EnumName` (never `EnumName.MEMBER`) | via `getBaseTypeOfLiteralType`; single-member enums return the literal itself — walk to parent symbol (TS#28869); TS5 enums are unions of literals |
| `symbol` / unique symbol | `symbol` | Closure has no uniqueness |
| `never` | warn + `?` | should not be emitted |
| type parameter `T` | `T`, `!`-prefixed only when the symbol resolves to a class/interface (bound param) | type params are non-null by default in Closure |
| union | translate members, **dedupe** (boolean literal unions collapse to one `boolean`), single → bare, else `(a\|b)` | |
| class / interface reference | `!Name` | interfaces with value+type merged symbols → `?` unless handled (`typeValueConflictHandled`) |
| generic reference `Foo<A,B>` | `!Foo<A,B>` | slice off **outer** type params of nested types; drop trailing `this` type arg; `?<...>` is a Closure **syntax error** — if target degrades to `?`, drop the args too |
| tuple | `!Array<?>` | measured at Google: unioning element types didn't improve optimization as long as destructuring is aliased |
| anonymous object | `{a: T, b: U}` record literal | omit properties failing `isValidClosurePropertyName`; optionality comes from `\|undefined` in the member type, not `=` |
| index signature | `!Object<string,V>` / `!Object<number,V>` | |
| call-only anonymous | `function(...)` via signature | multiple call signatures → `?` |
| construct signature | `function(new:T, params)` | **no `!` on `new:T`** — nullability stops Closure recognizing a ctor type in externs; `*` return → `?` (ctor must return ObjectType) |
| function signature | `function(this: T, p, p=, ...r): ret` | `this` param appears in **paramDecls but not signature params** — handle and slice; optional = `questionToken` **or initializer**; rest unwraps the array type (`...number`, not `...!Array<number>`) |
| generic *function types* | mark the type params `?` (unsupported by Closure) | `markTypeParameterAsUnknown` |
| mapped / conditional / other object flags | warn + `?` | |
| non-merged non-ambient namespace types | `?` | tsickle cannot name them |
| **module-scoped types in externs context** | `?` | **externs cannot reference module types** — only ambients migrate. Directly relevant to our typed-render channel. |
| JSDoc-declared signatures (`.js` inputs) | `Function` | |

Config idea worth copying: `pathUnknownSymbolsSet` — a caller-supplied "these
symbols are always `?`" escape hatch, resolved by path, for hostile types.

## jsdoc_transformer lessons

- **Heritage (`maybeAddHeritageClauses`)**: resolve the supertype via the
  checker *at the heritage expression*; refuse symbol-less / type-literal
  supertypes (mapped-type outputs); **strip the leading `!`**
  (`@extends {X<!Y>}`, never `@extends {!X}`); `dropFinalTypeArgument`
  workaround for TS#38391. Compat hack we do NOT copy: rewriting
  `implements SomeClass` to `@extends` when no extends exists (their own
  comment: "poorly-thought-out hack", closure-compiler#3126).
- **Member declarations**: statics on `ClassName.x`, instance + constructor
  parameter properties on `ClassName.prototype.x`, all inside `if (false)`;
  interface optional members emit `{T|undefined}` **only on interfaces** —
  `?|undefined` on classes trips Closure conformance; abstract/interface
  methods become empty function assignments carrying full `@param`/`@return`
  so overrides typecheck; unhandled members become comments, never guesses.
- **Casts**: TS `as T`, `<T>expr`, and non-null `x!` become Closure casts
  `/** @type {T} */ (expr)` — with surgical *removals* inside optional
  chains (Closure can't parenthesize there). Also injects casts for
  `this`-typed accesses in `@template`-this methods. This is the seed of our
  W2-3 access-site casts — tsickle only casts where the *user* wrote an
  assertion; we extend to every checker-known inference-loss site.
- **readonly**: tsickle does **not** emit `@const` for readonly properties in
  code emission (only in externs, `externs.ts:516`). A place to exceed:
  checker-proven readonly + never-reassigned → `@const` enables collapsing.

## enum + jsdoc plumbing

- Enums: `@enum {number|string}` object literal; member typing via
  `getEnumMemberType`; unsupported-namespace guard. We already lower enums
  semantically; adopt the `@enum` tag so Closure sees the type.
- `jsdoc.ts`: maintain a banned/one-per-comment tag model when merging user
  JSDoc with synthesized tags (`type/typedef/nocollapse/const/enum` conflict
  set); `@dict` discouraged in favor of index signatures.

## Where we exceed tsickle (keep, do not regress toward it)

1. **Attachment over declaration.** tsickle annotates declaration sites and
   user-written assertions only; the records experiment proved declarations
   without instance attribution deliver zero bytes. W2-3 casts at checker-known
   inference-loss sites go beyond tsickle.
2. **Evidence-based externs.** tsickle generates externs from ambient `.d.ts`
   only; hand-written externs for everything else. Our boundary/runtime
   analysis (usage ∩ `.d.ts`, constructed-key hazards, protocol inference) has
   no tsickle equivalent.
3. **Post-bundle identity.** tsickle leans on goog.module + aliases; our IR
   binds JSDoc type names to resolver-verified identities that survive
   bundling and renaming.
4. **Ledger-gated emission.** tsickle has tests; we gate every annotation on
   measured `invalidated ↓ or bytes ↓` (W2-0).
5. **readonly → `@const`** (above).
6. **No compat hacks**: we do not adopt implements→extends rewriting or other
   documented-regret behaviors.

## W2-2 implementation contract (delta to current type-render.ts)

1. Reconcile the translate table above against `type-render.ts` case by case;
   adopt every row where we differ (`unknown`, `{}`, tuples, enum literals,
   ctor types, this-params, optional-by-initializer, outer type params,
   `?<...>` guard, externs-context module types).
2. Emit the nominal skeleton: `@extends`/`@implements` per the heritage rules,
   `@enum`, `@template` (constraints dropped), `@const` for checker-proven
   readonly, `!`/`?` per strictNullChecks with tsickle's positional rules
   (`!` stripped in heritage and `new:`).
3. Keep all our degradation + provenance rules; every adopted row lands with a
   regression test naming the trap it encodes.

## Status update (post-measurement, 2026-07-29)

The W2-B head-to-head (appendix in `externs-v3-boundary-model.md`) reframes
this contract. We already beat best-tuned tsickle on bytes (1,748/820 vs
1,756/825); the whole fidelity gap (5 pre-Closure `?` atoms vs 0) is worth
0.7%; and typed dead-field DCE fired identically even on the untyped floor.
The W2-1 falsification removes owner-shape motivations entirely.

Consequently the adoption table above is justified by **correctness and
robustness** — each row prevents a Closure crash, a syntax error
(`?<...>`, `!` on `new:`), a conformance break, or a wrong type — not by
bytes. W2-2 executes the contract under those acceptance dimensions (W2-C
corpus showdown), and the shared-with-tsickle mixed-access miscompile
(`SETTINGS['retries']` → −1) makes W2-R the prerequisite wave: neither
translator fidelity nor externs fix a bundler that lets one-sided renames
through.

## Appendix: corpus showdown results

W2-C ran both pipelines over **tsickle's own golden corpus**
(`angular/tsickle@master`, archived and therefore stable): 170 suites, 286 TS
fixtures, 157 kept after excluding clutz / migration-shim / goog.module
plumbing, 132 runnable. Same Closure binary (v20260726) at ADVANCED for both
sides; tsickle 0.46.3 on its peer-pinned TypeScript 4.7.4. Full report
`/tmp/gcc-w2-showdown.md`, data `/tmp/gcc-w2-showdown.json`.

| Dimension | Ours | tsickle | Verdict |
|---|---:|---:|---|
| Correctness (head-to-head, deterministic, both built) | 92 / 93 | 92 / 93 | tie |
| Robustness (suites that build, of 132) | 105 | 109 | we lose by 4 |
| Bytes raw (57 scored suites) | 14,098 | 14,148 | we win 0.35% |
| Bytes gzip | 9,806 | 9,671 | we lose 1.4% |

Two measurement problems had to be solved first, and both are worth
remembering: ADVANCED deletes these fixtures entirely (they are golden-output
tests with no observable behaviour), so each fixture's surface is pinned by
static name and printed as a digest; and modern TypeScript reports `TS7010` and
`strictPropertyInitialization` where 4.7 did not, so the generated tsconfig
mirrors tsickle's own `baseCompilerOptions` to avoid scoring a compiler-version
skew.

**The corpus paid for itself in defects, not scores.** It surfaced a
deterministic silent miscompile — `export * as ns from './ns'` emits
`var a = {}.g`, so the re-exported namespace is empty and `ns` is `undefined`
(reference and tsickle both give an object) — plus invalid emitted JavaScript
for TypeScript namespaces (`function(A) {` → `JSC_PARSE_ERROR`), a duplicated
declaration under declaration merging, and ambient `declare var self/navigator`
emitted as program code instead of externs. Six of the eight backlog items are
one theme: **namespaces, declaration merging and ambient declarations**; a
single workstream there is expected to take robustness past tsickle's 109.

**And it settled the bytes question.** tsickle's typed emit is **byte-identical
to its own untyped (`types → ?`) emit in all 109 suites where both built** —
zero differing suites, on the corpus its authors wrote to exercise type
translation. That corroborates the W2-B head-to-head (whole fidelity gap worth
0.7%) at corpus scale and confirms the reframe above: annotation fidelity is
justified by correctness and robustness, never by bytes. W2-3 (access-site
casts) should stay demoted on those grounds; the namespace/ambient workstream
is the higher-value successor.
