# `oxc-diff`: the swc → oxc parity harness

Review instrument for the front-end migration assessed in the O1 report
(`swc` → `oxc`, phase **P3** and the golden re-baseline **P3b**). It runs both
front ends over the same fixture set and reports the differences **by class**,
so a re-baseline can be reviewed a class at a time instead of as one 4k-line
text diff.

It answers one question per file: *does a human have to read this diff?*

## Running it

```sh
node scripts/oxc-diff.mjs                            # summary + semantic-suspect detail
node scripts/oxc-diff.mjs --show all                 # detail for every class
node scripts/oxc-diff.mjs --show comment-only        # the risk-5 comment inventory
node scripts/oxc-diff.mjs --filter enums --show all  # one file or subtree
node scripts/oxc-diff.mjs --json .tmp/oxc-diff/report.json
node scripts/oxc-diff.mjs --bench 5                  # also time both pipelines
node scripts/oxc-diff.mjs --self-check               # test the classifier itself
node scripts/oxc-diff.mjs --refresh-corpus           # regenerate the corpus list
```

First run builds `native/oxc-probe` in release mode, which pulls the oxc crate
tree (a few minutes, once). Emitted variants land in `.tmp/oxc-diff/{swc,swc_norm,oxc}/`
for manual inspection.

Flags: `--out <dir>` moves the output tree, `--show <classes|all>` takes a
comma-separated class list, `--filter <substring>` matches repo-relative paths.

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
- **swc_norm** — the same, plus the `precedence.rs` paren normalizer. This is
  what our pipeline actually emits, and it is the side the harness compares.
- **oxc** — parse → `SemanticBuilder` → `Transformer` (TS strip + JSX classic) →
  `Codegen`.

## Classes

Reported in escalation order; each file gets exactly one.

| class | meaning | review |
|---|---|---|
| `identical` | byte-equal | none |
| `comment-only` | code tokens equal, comments differ | **policy**: oxc retains comments, swc has no comment store. Every comment listed here would newly reach Closure (risk 5). Gate: `test/oxc-migration-safety.test.mjs`. |
| `formatting-only` | canonical token streams equal | bulk-accept: whitespace, quotes, escapes, numeric spelling |
| `token-level` | same identifiers and same values, different arrangement | bulk-review: added parens, `var` vs `let`, statement order |
| `semantic-suspect` | an identifier or a literal value appeared or vanished | **read every one.** Every miscompile in the risk table lands here |
| `swc-error` / `oxc-error` / `both-error` | one or both pipelines refused the file | read |

Canonicalization treats as *formatting*: whitespace and indentation, quote
style, escape spelling (`\0` vs `\u0000`, `<\/script>` vs `</script>`), numeric
spelling (`1e3` vs `1000`, separators), and the formatting of code inside
template-literal `${...}` holes. Everything else is a token difference.

`semantic-suspect` is where the report's risks become visible: an un-inlined
const enum puts the enum's name back into the output, and a wrong cross-chunk
direct binding swaps one identifier for another. Both show up as a name delta.

## Baseline (repo @ `eee7c8e`, oxc 0.142, swc 74.0.2)

144 files — 11 traps + 133 corpus, 0 pipeline failures:

| class | count |
|---|---|
| `identical` | 6 |
| `comment-only` | 39 |
| `formatting-only` | 41 |
| `token-level` | 53 |
| `semantic-suspect` | **5** |

All five `semantic-suspect` files are traps, none is corpus code, and each is a
known risk-table entry: `const_enum.ts` and `const_enum_expression.ts` (oxc does
not inline const enums — our inliner must own it), and `namespace.ts`,
`nested_namespace.ts`, `merged_namespace.ts` (different namespace lowering
shape). That is the whole finding: the corpus differences are mechanical, and the
semantic ones are exactly the four cases pinned by executing tests in
`test/oxc-migration-safety.test.mjs`.

## Limits

The classifier is a lexer, not a checker. It cannot prove equivalence — nothing
can, and Closure is downstream anyway. Unhandled syntax degrades toward *more*
noise, never toward hiding a difference, which is the safe direction for a gate.
`--self-check` covers each class and each canonicalization rule; extend it
before extending the classifier.
