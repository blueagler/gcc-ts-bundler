# `oxc-diff`: the swc → oxc parity harness

Review instrument for the front-end migration assessed in the O1 report
(`swc` → `oxc`, phase **P3** and the golden re-baseline **P3b**). It runs both
front ends over the same fixture set and reports the differences **by class**,
so a re-baseline can be reviewed a class at a time instead of as one 4k-line
text diff.

It answers two questions per file, with two independent instruments:

1. **How far did the print move?** — the token classifier (`class` below). This
   is *triage*: it groups a re-baseline so it can be read in batches.
2. **Does the program still mean the same thing?** — the **structural referee**,
   which re-prints both sides through a third implementation. This is the only
   answer a disposition may rest on.

> **Binding correction (OX-D3 audit, `/tmp/gcc-oxd3.md` §2).** An earlier version
> of this document dispositioned `token-level` as *"bulk-review"* and claimed the
> classifier "never hides a difference". **Both were wrong.** D3 planted 13
> unambiguous semantic mutations — `&&`→`||`, `===`→`==`, dropped
> negation/`await`/`new`/`typeof`/`delete`, argument-order swap, operand-order
> swap, `a.b`→`a[b]`, `a?.b`→`a.b`, `(a,b)`→`a; b`, `var`→`let` — and **all 13
> classified `token-level`**, because that class is decided on *multisets* of
> names and literals and every one of those mutations preserves them. The 13 cases
> now live in `--self-check` permanently: the referee catches 13/13, the
> classifier 0/13.

## Running it

```sh
node scripts/oxc-diff.mjs                            # summary + semantic-suspect detail
node scripts/oxc-diff.mjs --show all                 # detail for every class
node scripts/oxc-diff.mjs --show comment-only        # the risk-5 comment inventory
node scripts/oxc-diff.mjs --filter enums --show all  # one file or subtree
node scripts/oxc-diff.mjs --json .tmp/oxc-diff/report.json
node scripts/oxc-diff.mjs --bench 5                  # also time both pipelines
node scripts/oxc-diff.mjs --self-check               # classifier + referee, incl. the 13 mutations
node scripts/oxc-diff.mjs --no-referee               # triage only, NOT dispositionable
node scripts/oxc-diff.mjs --refresh-corpus           # regenerate the corpus list
```

First run builds `native/oxc-probe` in release mode, which pulls the oxc crate
tree (a few minutes, once). Emitted variants land in `.tmp/oxc-diff/{swc,swc_norm,oxc}/`
for manual inspection.

Flags: `--out <dir>` moves the output tree, `--show <classes|all>` takes a
comma-separated class list, `--filter <substring>` matches repo-relative paths.
The referee is **on by default**; `--no-referee` is a fast triage pass whose
output is explicitly marked as not dispositionable.

## Inputs (checked in, so runs are reproducible)

| path | what |
|---|---|
| `test/fixtures/oxc-corpus.txt` | 133 git-tracked `.ts`/`.tsx` files, repo-relative |
| `test/fixtures/oxc-traps/` | the O1 probe's trap fixtures, plus one per risk-table entry |
| `native/oxc-probe/` | the dual pipeline (Rust), its own cargo workspace |

Both lists are repo-relative and version-controlled: no `/tmp` state, no
machine-specific paths, same verdicts in any checkout. Corpus paths that do not
exist are skipped and counted, so the harness still runs in a partial checkout.

The original probe corpus was 251 files including `examples/*/node_modules`
sources; those example trees were replaced wholesale by the official-template
examples, so the list is regenerated from git-tracked sources instead. Vendored
dependency sources are not tracked and cannot be part of a deterministic list —
point `--filter` at an installed `examples/*/node_modules` tree if you want that
coverage for a specific run.

`native/oxc-probe` is deliberately a separate cargo workspace: the oxc
dependency tree must never enter `native/Cargo.toml`, and `cargo test` on the
shipping crate does not see it. Its swc versions must stay byte-identical to
`native/Cargo.toml`, or the probe measures the wrong baseline.

## Pipelines compared

- **swc** — parse → resolver → \[JSX classic] → TS strip → codegen, mirroring
  `native/src/transpile.rs`.
- **swc_norm** — the frozen S3 shipping baseline: swc plus the retired paren
  normalizer. It remains in the probe only to classify the S4 re-baseline; shipping
  code now emits through oxc. The harness compares this historical baseline to oxc.
- **oxc** — parse → `SemanticBuilder` → `Transformer` (TS strip + JSX classic) →
  `Codegen`.

## Classes

Reported in escalation order; each file gets exactly one. **The `review` column is
how much text to read, not a safety verdict** — for that, see the referee below.

| class | meaning | how much to read |
|---|---|---|
| `identical` | byte-equal | none |
| `comment-only` | code tokens equal, comments differ | **policy**: oxc retains comments, swc has no comment store. Every comment listed here would newly reach Closure (risk 5). Gate: `test/oxc-migration-safety.test.mjs`. |
| `formatting-only` | canonical token streams equal | batch: whitespace, quotes, escapes, numeric spelling |
| `token-level` | same identifiers and same values, different arrangement | batch **only for files the referee calls structurally equal**. The class itself carries no safety: parens, `var`/`let`, *and* every operator/operand/argument-order mutation land here alike |
| `semantic-suspect` | an identifier or a literal value appeared or vanished | **read every one.** Every miscompile in the risk table lands here |
| `swc-error` / `oxc-error` / `both-error` | one or both pipelines refused the file | read |

Canonicalization treats as *formatting*: whitespace and indentation, quote
style, escape spelling (`\0` vs `\u0000`, `<\/script>` vs `</script>`), numeric
spelling (`1e3` vs `1000`, separators), and the formatting of code inside
template-literal `${...}` holes. Everything else is a token difference.

`semantic-suspect` is where the report's risks become visible: an un-inlined
const enum puts the enum's name back into the output, and a wrong cross-chunk
direct binding swaps one identifier for another. Both show up as a name delta.
It is a *sufficient* trigger to read a file, never a necessary one — a mutation
that preserves the name and literal multisets is `token-level`, which is why the
referee runs on every file rather than only on the suspicious ones.

## The structural referee — what a disposition rests on

Both sides are re-printed through a **third independent implementation**
(esbuild, already a devDependency) with `--minify-whitespace`. esbuild always
prints from its own AST, so it re-derives parentheses from precedence, normalises
whitespace/quoting/numerics and drops non-legal comments. Two programs differing
only in those collapse to byte-identical text; anything that changes the parse
tree survives.

| verdict | meaning | disposition |
|---|---|---|
| `STRUCTURALLY-EQUAL` | a third parser agrees the trees match | print-shape only; batch-accept with its class |
| `STRUCTURALLY-DIFFERENT` | the trees differ | **read it**, whatever the class says |
| `UNPARSEABLE` | esbuild refuses the input (e.g. parameter decorators) | **read it** — the referee abstains, so the class is unbacked |
| `NO-OUTPUT` | a pipeline produced nothing | read it |

A positive and a negative control (`((a)+b)*(c)` ≡ `(a+b)*c` ≢ `a+b*c`) run on
**every invocation**. If they fail, every verdict is withheld and the run exits
non-zero — a silent esbuild change cannot turn the gate into a rubber stamp.

The referee is not omniscient either, and its blind spot is stated rather than
implied: it compares *printed trees*, so it cannot see a difference that
esbuild's own printer normalises away, and it says nothing about behaviour that
depends on Closure's later passes. Where behaviour is the question, the answer is
an executing test in `test/oxc-migration-safety.test.mjs`, not either instrument
here. The method and the original controls are OX-D3's
(`/tmp/gcc-oxd3/referee.mjs`), promoted into this harness unchanged.

## Baseline (repo @ `eee7c8e`, oxc 0.142, swc 74.0.2)

144 files — 11 traps + 133 corpus, 0 pipeline failures:

| class | count |
|---|---|
| `identical` | 6 |
| `comment-only` | 39 |
| `formatting-only` | 41 |
| `token-level` | 53 |
| `semantic-suspect` | **5** |

Referee verdicts over the same 144 files:

| class / verdict | count |
|---|---|
| `identical` / `STRUCTURALLY-EQUAL` | 6 |
| `comment-only` / `STRUCTURALLY-EQUAL` | 39 |
| `formatting-only` / `STRUCTURALLY-EQUAL` | 41 |
| `token-level` / `STRUCTURALLY-EQUAL` | 51 |
| `token-level` / `STRUCTURALLY-DIFFERENT` | 1 (`hostile_jsdoc.ts`) |
| `token-level` / `UNPARSEABLE` | 1 (`decorators.ts`) |
| `semantic-suspect` / `STRUCTURALLY-DIFFERENT` | 5 |

So the disposition is: **7 files to read** — the 5 `semantic-suspect` traps plus
the 2 `token-level` files the referee refused to clear — and **0 corpus files**.
All five `semantic-suspect` files are traps and each is a known risk-table entry:
`const_enum.ts` and `const_enum_expression.ts` (oxc does not inline const enums —
our inliner must own it), and `namespace.ts`, `nested_namespace.ts`,
`merged_namespace.ts` (different namespace lowering shape). Every one of the 133
corpus files is structurally equal under a third parser, which is what makes
"mechanical" a finding rather than a hope.

These numbers reproduce OX-D3's independently-run grid exactly.

## Limits

Neither instrument is a proof, and their blind spots are different — which is the
point of having both:

* the **classifier** is a lexer. It decides `token-level` on multisets of names
  and literals, so any mutation preserving those (every operator, operand-order
  and argument-order change; `var`→`let`; `a.b`→`a[b]`) is invisible to it. It is
  triage. Never disposition from it alone.
* the **referee** compares printed trees through esbuild, so it cannot see what
  esbuild's printer normalises away, it abstains on input esbuild refuses
  (`UNPARSEABLE` — which is a read-it verdict, not a pass), and it says nothing
  about behaviour arising in Closure's later passes.
* **behaviour** is settled by neither: it is settled by the executing tests in
  `test/oxc-migration-safety.test.mjs`. The `export let` enum defect (§risk 6
  there) is the worked example — the classifier files it as `token-level`
  (`var`→`let`), the referee correctly calls it structurally different, and only
  the executing test says *why it matters*: a forward reference throws instead of
  reading `undefined`.

`--self-check` covers every class, every canonicalization rule, the referee
controls and the 13 planted mutations. Extend it before extending either
instrument.
