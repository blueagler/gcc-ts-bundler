#!/usr/bin/env node
// Dual-stack parity harness for the swc -> oxc migration (/tmp/gcc-o1-oxc.md,
// phase P3 / P3b). Runs both front ends over the same fixture set and emits a
// *classified* diff report, so the golden re-baseline can be reviewed by class
// instead of by 4k lines of eyeballed text.
//
// Usage:
//   node scripts/oxc-diff.mjs                     # corpus + traps, summary
//   node scripts/oxc-diff.mjs --show semantic-suspect,token-level
//   node scripts/oxc-diff.mjs --filter enums --show all
//   node scripts/oxc-diff.mjs --json .tmp/oxc-diff/report.json
//   node scripts/oxc-diff.mjs --bench 5           # also time both pipelines
//   node scripts/oxc-diff.mjs --self-check        # test the classifier itself
//   node scripts/oxc-diff.mjs --refresh-corpus    # regenerate the corpus list
//
// Inputs are checked in and repo-relative, so a run is reproducible in any
// checkout (no /tmp state, no machine-specific paths):
//   test/fixtures/oxc-corpus.txt   git-tracked TS/TSX corpus
//   test/fixtures/oxc-traps/       the trap fixtures from the probe, plus one
//                                  per risk in the report's risk table
//
// The Rust side lives in native/oxc-probe (its own cargo workspace, so the oxc
// dependency tree never enters the shipping crate). It emits three variants per
// file: `swc` (raw), `swc_norm` (swc + the precedence.rs paren normalizer, i.e.
// what our pipeline really produces) and `oxc`. This script compares
// `swc_norm` against `oxc`.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(import.meta.dirname, "..");
const corpusFile = path.join(repoRoot, "test/fixtures/oxc-corpus.txt");
const trapsDir = path.join(repoRoot, "test/fixtures/oxc-traps");
const probeManifest = path.join(repoRoot, "native/oxc-probe/Cargo.toml");
const probeBinary = path.join(repoRoot, "native/oxc-probe/target/release/oxc-probe");

const CLASSES = [
  "identical",
  "comment-only",
  "formatting-only",
  "token-level",
  "semantic-suspect",
  "swc-error",
  "oxc-error",
  "both-error",
];

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

// ponytail: regex lexer, not a parser. It handles the three things that
// otherwise produce false `semantic-suspect` verdicts on real files, because a
// review instrument that cries wolf does not get used:
//
//   * template literals are tokenized *recursively* -- the `${...}` holes carry
//     code, and the two printers format it differently (`(x)=>` vs `(x) => `),
//     which is formatting, not a value change;
//   * regex literals are recognised by the standard prev-token heuristic, so
//     their bodies do not lex as identifiers;
//   * escape style is canonicalized (`\\0` vs `\\u0000`, `<\\/script>` vs
//     `</script>`), because the decoded value is what matters.
//
// CORRECTION (OX-D3 audit, /tmp/gcc-oxd3.md §2). An earlier version of this
// comment claimed unhandled syntax "degrades toward more noise, never toward
// hiding a difference". **That claim was false** at the
// `token-level`/`semantic-suspect` boundary and is withdrawn. D3 planted 13
// unambiguous semantic mutations -- `&&`->`||`, `===`->`==`, dropped
// negation/`await`/`new`/`typeof`/`delete`, argument-order swap, operand-order
// swap, `a.b`->`a[b]`, `a?.b`->`a.b`, `(a,b)`->`a; b`, `var`->`let` -- and **all
// 13 classified `token-level`**, because that class is decided on *multisets* of
// names and literals, which every one of those mutations preserves.
//
// So the tokenizer is a *triage* instrument, not a safety gate: it says how much
// a diff moved, never whether the program still means the same thing. The
// authority for that question is `--referee` below.
const TOKEN_PATTERN = new RegExp(
  [
    "(?<comment>/\\*[\\s\\S]*?\\*/|//[^\\n]*)",
    "(?<string>\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*')",
    "(?<regex>/(?![*/])(?:\\\\[\\s\\S]|\\[(?:\\\\[\\s\\S]|[^\\]\\\\\\n])*\\]|[^/\\\\\\n])+/[dgimsuvy]*)",
    "(?<number>0[xXoObB][0-9a-fA-F_]+n?|(?:\\d[\\d_]*)?\\.?\\d[\\d_]*(?:[eE][+-]?\\d+)?n?)",
    "(?<name>[A-Za-z_$][\\w$]*)",
    "(?<punct>[^\\s])",
  ].join("|"),
  "gu",
);

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "finally", "for",
  "function", "if", "import", "in", "instanceof", "let", "new", "return",
  "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while",
  "with", "yield",
]);

// A `/` starts a regex only where an expression may start.
const NO_REGEX_AFTER = new Set([")", "]", "}", "+", "-", "!"]);

function canonicalNumber(raw) {
  const cleaned = raw.replaceAll("_", "");
  if (cleaned.endsWith("n")) {
    return `${BigInt(cleaned.slice(0, -1))}n`;
  }
  const value = Number(cleaned);
  return Number.isNaN(value) ? cleaned : String(value);
}

/** Decodes the escape forms the two printers disagree about. */
function decodeEscapes(body) {
  return body
    .replaceAll("\\\n", "")
    .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/gu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([0-7]{1,3})/gu, (_, digits) => String.fromCharCode(parseInt(digits, 8)))
    .replace(/\\([\s\S])/gu, (_, character) =>
      ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" })[character] ?? character);
}

function canonicalString(raw) {
  // Quote style and escape style are formatting; the decoded value is not.
  return JSON.stringify(decodeEscapes(raw.slice(1, -1)));
}

/**
 * Tokens with `kind` and canonical `text`; comments are kept but flagged.
 *
 * Template literals expand into their raw chunks (canonicalized as strings) plus
 * the tokens of every `${...}` hole, so a template is compared the way the rest
 * of the file is.
 */
export function tokenize(source) {
  const sticky = new RegExp(TOKEN_PATTERN.source, "guy");
  const tokens = [];
  let previous;
  let index = 0;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    // Templates are scanned, not matched: they nest (a `${}` hole can hold
    // another template), which no regex handles.
    if (source[index] === "`") {
      const scanned = scanTemplate(source, index);
      for (const inner of scanned.tokens) tokens.push(inner);
      index = scanned.end;
      previous = tokens.at(-1);
      continue;
    }
    sticky.lastIndex = index;
    const match = sticky.exec(source);
    if (!match) {
      index += 1;
      continue;
    }
    index = sticky.lastIndex;
    const groups = match.groups;
    if (groups.comment !== undefined) {
      tokens.push({ kind: "comment", text: groups.comment.trim() });
      continue;
    }
    if (groups.regex !== undefined) {
      // Only a regex where an expression may start; otherwise it was division,
      // so re-lex the text as ordinary tokens.
      const isRegex =
        previous === undefined ||
        previous.kind === "keyword" ||
        previous.kind === "punct" && !NO_REGEX_AFTER.has(previous.text);
      if (isRegex) {
        tokens.push({ kind: "literal", text: groups.regex });
      } else {
        for (const inner of tokenize(groups.regex.replace("/", "/ "))) tokens.push(inner);
      }
    } else if (groups.string !== undefined) {
      tokens.push({ kind: "literal", text: canonicalString(groups.string) });
    } else if (groups.number !== undefined) {
      tokens.push({ kind: "literal", text: canonicalNumber(groups.number) });
    } else if (groups.name !== undefined) {
      tokens.push({
        kind: KEYWORDS.has(groups.name) ? "keyword" : "name",
        text: groups.name,
      });
    } else {
      tokens.push({ kind: "punct", text: groups.punct });
    }
    previous = tokens.at(-1);
  }
  return tokens;
}

/**
 * Scans one template literal starting at the backtick, emitting its raw chunks
 * as canonical string literals and the tokens of each `${...}` hole. Returns the
 * index just past the closing backtick.
 */
function scanTemplate(source, start) {
  const tokens = [{ kind: "punct", text: "`" }];
  let chunk = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      chunk += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "`") {
      index += 1;
      break;
    }
    if (character === "$" && source[index + 1] === "{") {
      tokens.push({ kind: "literal", text: canonicalString(`"${chunk}"`) });
      chunk = "";
      const end = skipToMatchingBrace(source, index + 2);
      for (const inner of tokenize(source.slice(index + 2, end))) tokens.push(inner);
      index = end + 1;
      continue;
    }
    chunk += character;
    index += 1;
  }
  tokens.push({ kind: "literal", text: canonicalString(`"${chunk}"`) });
  return { end: index, tokens };
}

/** Index of the `}` closing a `${` hole, skipping nested strings and templates. */
function skipToMatchingBrace(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      index = scanTemplate(source, index).end;
      continue;
    }
    if (character === '"' || character === "'") {
      index += 1;
      while (index < source.length && source[index] !== character) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return source.length;
}


function multiset(tokens, kind) {
  const counts = new Map();
  for (const token of tokens) {
    if (token.kind !== kind) continue;
    counts.set(token.text, (counts.get(token.text) ?? 0) + 1);
  }
  return counts;
}

function multisetDelta(left, right) {
  const added = [];
  const removed = [];
  for (const [text, count] of right) {
    const delta = count - (left.get(text) ?? 0);
    if (delta > 0) added.push(count === delta ? text : `${text} (+${delta})`);
  }
  for (const [text, count] of left) {
    const delta = count - (right.get(text) ?? 0);
    if (delta > 0) removed.push(count === delta ? text : `${text} (-${delta})`);
  }
  return { added, removed };
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index].text !== right[index].text) return index;
  }
  return left.length === right.length ? -1 : limit;
}

function contextAround(tokens, index, radius = 6) {
  return tokens
    .slice(Math.max(0, index - radius), index + radius)
    .map((token) => token.text)
    .join(" ");
}

/**
 * Classifies one swc/oxc output pair. The ladder is deliberately coarse: it
 * answers "does a human have to read this diff?", not "are these programs
 * equivalent" (undecidable, and Closure is downstream anyway).
 */
export function classify(swcCode, oxcCode) {
  if (swcCode === oxcCode) return { class: "identical" };

  const swcTokens = tokenize(swcCode);
  const oxcTokens = tokenize(oxcCode);
  const swcCode_ = swcTokens.filter((token) => token.kind !== "comment");
  const oxcCode_ = oxcTokens.filter((token) => token.kind !== "comment");

  const sameCode =
    swcCode_.length === oxcCode_.length &&
    swcCode_.every((token, index) => token.text === oxcCode_[index].text);
  if (sameCode) {
    const swcComments = swcTokens.filter((token) => token.kind === "comment");
    const oxcComments = oxcTokens.filter((token) => token.kind === "comment");
    const sameComments =
      swcComments.length === oxcComments.length &&
      swcComments.every((token, index) => token.text === oxcComments[index].text);
    if (sameComments) return { class: "formatting-only" };
    return {
      class: "comment-only",
      // Comment retention is risk 5: these are the comments that would newly
      // reach Closure. `test/oxc-migration-safety.test.mjs` is the gate.
      commentsAdded: oxcComments
        .filter((token) => !swcComments.some((other) => other.text === token.text))
        .map((token) => token.text),
    };
  }

  const names = multisetDelta(multiset(swcCode_, "name"), multiset(oxcCode_, "name"));
  const literals = multisetDelta(
    multiset(swcCode_, "literal"),
    multiset(oxcCode_, "literal"),
  );
  const index = firstDifference(swcCode_, oxcCode_);
  const evidence = {
    firstDifference: index,
    oxcContext: contextAround(oxcCode_, index),
    swcContext: contextAround(swcCode_, index),
  };

  if (names.added.length === 0 && names.removed.length === 0 &&
      literals.added.length === 0 && literals.removed.length === 0) {
    // Same names, same values, different arrangement: parens, `var` vs `let`,
    // statement order of emitted helpers. Reviewable in bulk.
    return { class: "token-level", ...evidence };
  }
  // A name or a value appeared or vanished. Every real miscompile in the risk
  // table lands here: an un-inlined const-enum read adds the enum's name back,
  // a wrong direct binding swaps one identifier for another.
  return { class: "semantic-suspect", literals, names, ...evidence };
}

// ---------------------------------------------------------------------------
// structural referee -- the disposition authority
// ---------------------------------------------------------------------------
//
// Promoted from the OX-D3 audit (`/tmp/gcc-oxd3/referee.mjs`), unchanged in
// method, because it is the only instrument here that can answer "do these two
// programs still mean the same thing?".
//
// Both sides are re-printed through a THIRD implementation -- esbuild, already a
// devDependency -- with `--minify-whitespace`. esbuild always prints from its own
// AST, so it re-derives parentheses from precedence, normalises whitespace and
// quoting, and drops non-legal comments. Two programs differing only in those
// collapse to byte-identical text; anything that changes the parse tree survives.
//
// A positive and a negative control run on every invocation, so a silent esbuild
// change cannot quietly turn this into a rubber stamp. If the controls fail the
// referee reports `CONTROLS-FAILED` and every verdict is withheld.

const esbuildBinary = path.join(repoRoot, "node_modules/.bin/esbuild");

function esbuildNormalize(code, workDir, tag) {
  const file = path.join(workDir, `${tag}.js`);
  fs.writeFileSync(file, code);
  try {
    return {
      ok: true,
      // stderr captured, not inherited: an unparseable file is a *verdict*, not
      // noise to print twice.
      out: execFileSync(esbuildBinary, ["--minify-whitespace", file], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stderr ?? error.message).split("\n").slice(0, 3).join(" | "),
    };
  }
}

/** `((a)+b)*(c)` must equal `(a+b)*c` and must not equal `a+b*c`. */
function refereeControlsPass(workDir) {
  const redundant = esbuildNormalize("x = ((a)+b)*(c);", workDir, "ctl_a");
  const plain = esbuildNormalize("x = (a+b)*c;", workDir, "ctl_b");
  const reassociated = esbuildNormalize("x = a+b*c;", workDir, "ctl_c");
  return (
    redundant.ok &&
    plain.ok &&
    reassociated.ok &&
    redundant.out === plain.out &&
    plain.out !== reassociated.out
  );
}

/**
 * `STRUCTURALLY-EQUAL` | `STRUCTURALLY-DIFFERENT` | `UNPARSEABLE` for one pair.
 *
 * `UNPARSEABLE` is not a pass: esbuild refuses some legal-for-us input (a
 * decorator form), and those files fall back to human review rather than to the
 * token class.
 */
function refereeVerdict(swcCode, oxcCode, workDir) {
  const left = esbuildNormalize(swcCode, workDir, "swc");
  const right = esbuildNormalize(oxcCode, workDir, "oxc");
  if (!left.ok || !right.ok) {
    return {
      detail: left.ok ? `oxc: ${right.out}` : `swc: ${left.out}`,
      verdict: "UNPARSEABLE",
    };
  }
  return { verdict: left.out === right.out ? "STRUCTURALLY-EQUAL" : "STRUCTURALLY-DIFFERENT" };
}

// ---------------------------------------------------------------------------
// self-check
// ---------------------------------------------------------------------------

function selfCheck() {
  const cases = [
    ["identical", "var a = 1;\n", "var a = 1;\n"],
    ["formatting-only", "var a = 1;\n", "var  a  =  1.0;"],
    ["formatting-only", 'var a = "x\\n";', "var a = 'x\\n';"],
    ["formatting-only", "var a = 1e3;", "var a = 1000;"],
    ["comment-only", "var a = 1;", "/** @const */ var a = 1;"],
    ["token-level", "var a = 1;", "let a = 1;"],
    ["token-level", "a = b + c;", "a = (b + c);"],
    ["semantic-suspect", "var a = 1;", "var a = Dir.Up;"],
    ["semantic-suspect", "var a = 2;", "var a = 3;"],
    ["semantic-suspect", "f(shared);", "f(main);"],
    // Template holes carry code, and the two printers format it differently.
    ["formatting-only", "x = `a${f((y)=>y)}b`;", "x = `a${f((y) => y)}b`;"],
    // ...but a changed value inside a hole is still a changed value.
    ["semantic-suspect", "x = `a${f(one)}b`;", "x = `a${f(two)}b`;"],
    // Escape style inside strings and templates is formatting.
    ["formatting-only", 'x = "\\0";', 'x = "\\u0000";'],
    ["formatting-only", "x = `</script>`;", "x = `<\\/script>`;"],
    // A regex body must not lex as identifiers, and division must not lex as a
    // regex (`barriers` and friends came out of exactly this).
    ["identical", "x = /ab+c/gu.exec(y);", "x = /ab+c/gu.exec(y);"],
    ["token-level", "x = (a) / b / c;", "x = a / b / c;"],
    ["semantic-suspect", "x = /ab+c/gu;", "x = /ab+d/gu;"],
    // Nested templates: a hole holding another template with its own holes.
    ["formatting-only", "x = `a${`b${f((y)=>y)}c`}d`;", "x = `a${`b${f((y) => y)}c`}d`;"],
    ["semantic-suspect", "x = `a${`b${f(one)}c`}d`;", "x = `a${`b${f(two)}c`}d`;"],
  ];
  let failures = 0;
  for (const [expected, swcCode, oxcCode] of cases) {
    const observed = classify(swcCode, oxcCode).class;
    const ok = observed === expected;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${expected.padEnd(17)} ${JSON.stringify(swcCode)} -> ${JSON.stringify(oxcCode)}${ok ? "" : ` (got ${observed})`}`,
    );
  }
  // The comment channel must be reported, not silently folded away.
  const comments = classify("var a = 1;", "/** @license X */ var a = 1;");
  if (!comments.commentsAdded?.[0]?.includes("@license")) {
    console.log("FAIL comment-only evidence missing");
    failures += 1;
  }

  // OX-D3's 13 planted mutations, kept here permanently. They are *unambiguous
  // semantic changes*, and the point of the block is that the classifier calls
  // every one of them `token-level` while the referee catches every one. Both
  // halves are asserted: if a future tokenizer change starts catching some of
  // them that is an improvement, but the referee must never stop catching them,
  // and `token-level` must never be dispositioned as safe on the strength of the
  // classifier alone.
  const mutations = [
    ["operator swap", "x = a && b;", "x = a || b;"],
    ["equality loosened", "x = a === b;", "x = a == b;"],
    ["dropped negation", "x = !a;", "x = a;"],
    ["dropped await", "async function f(){ return await g(); }", "async function f(){ return g(); }"],
    ["dropped new", "x = new f(a);", "x = f(a);"],
    ["dropped typeof", "x = typeof a;", "x = a;"],
    ["dropped delete", "delete a.b;", "a.b;"],
    ["argument order", "f(a, b);", "f(b, a);"],
    ["operand order", "x = a - b;", "x = b - a;"],
    ["member form", "x = a.b;", "x = a[b];"],
    ["optional chain dropped", "x = a?.b;", "x = a.b;"],
    ["sequence split", "x = (a, b);", "a; x = b;"],
    ["binding kind", "var a = 1;", "let a = 1;"],
  ];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oxc-diff-selfcheck-"));
  const controlsPass = refereeControlsPass(workDir);
  if (!controlsPass) {
    console.log("FAIL referee controls");
    failures += 1;
  }
  let classifierCaught = 0;
  for (const [name, left, right] of mutations) {
    const classified = classify(left, right).class;
    const { verdict } = refereeVerdict(left, right, workDir);
    if (classified !== "token-level") classifierCaught += 1;
    const refereeOk = verdict === "STRUCTURALLY-DIFFERENT";
    if (!refereeOk) failures += 1;
    console.log(
      `${refereeOk ? "ok  " : "FAIL"} mutation ${name.padEnd(22)} classifier=${classified.padEnd(16)} referee=${verdict}`,
    );
  }
  fs.rmSync(workDir, { force: true, recursive: true });
  console.log(
    `\n${mutations.length} planted semantic mutations: referee caught ${mutations.length - (failures - (controlsPass ? 0 : 1))}/${mutations.length}, classifier caught ${classifierCaught}/${mutations.length} (it is triage, not a gate)`,
  );
  console.log(`${cases.length + 1 + mutations.length + 1} checks, ${failures} failed`);
  return failures === 0;
}

// ---------------------------------------------------------------------------
// corpus + probe
// ---------------------------------------------------------------------------

function refreshCorpus() {
  const tracked = execFileSync(
    "git",
    ["ls-files", "*.ts", "*.tsx"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line && !line.endsWith(".d.ts"))
    .filter((line) => !line.startsWith("test/fixtures/oxc-traps/"))
    .sort();
  const header = [
    "# Deterministic corpus for scripts/oxc-diff.mjs (see docs/oxc-diff.md).",
    "# Repo-relative paths, git-tracked only, so the harness is reproducible in any",
    "# checkout. Regenerate with: node scripts/oxc-diff.mjs --refresh-corpus",
  ];
  fs.writeFileSync(corpusFile, `${[...header, ...tracked].join("\n")}\n`);
  console.log(`wrote ${tracked.length} paths to ${path.relative(repoRoot, corpusFile)}`);
}

function readCorpus() {
  const listed = fs
    .readFileSync(corpusFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const traps = fs
    .readdirSync(trapsDir)
    .filter((name) => /\.(?:tsx?|jsx?|mts|cts)$/u.test(name))
    .sort()
    .map((name) => path.join("test/fixtures/oxc-traps", name));
  const missing = listed.filter((relative) => !fs.existsSync(path.join(repoRoot, relative)));
  return { listed, missing, traps };
}

function buildProbe() {
  const sourceStamp = fs.statSync(path.join(repoRoot, "native/oxc-probe/src/main.rs")).mtimeMs;
  if (fs.existsSync(probeBinary) && fs.statSync(probeBinary).mtimeMs > sourceStamp) {
    return;
  }
  console.error("building native/oxc-probe (release, first run pulls the oxc tree)...");
  const built = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", probeManifest],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    throw new Error("cargo build of native/oxc-probe failed");
  }
}

function runProbe(files, outDir, bench) {
  const listFile = path.join(outDir, "files.txt");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(listFile, `${files.join("\n")}\n`);
  const args = [listFile, outDir];
  if (bench > 0) args.push("--bench", String(bench));
  const run = spawnSync(probeBinary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (run.status !== 0) {
    throw new Error(`oxc-probe failed: ${run.stderr}`);
  }
  return { stderr: run.stderr, stdout: run.stdout };
}

// The probe flattens absolute paths into single file names; mirror that here.
function flatten(absolute) {
  return absolute.replaceAll("/", "__").replace(/^_+/u, "");
}

function readVariant(outDir, variant, absolute) {
  const base = path.join(outDir, variant, flatten(absolute));
  if (fs.existsSync(base)) return { code: fs.readFileSync(base, "utf8") };
  if (fs.existsSync(`${base}.err`)) return { error: fs.readFileSync(`${base}.err`, "utf8") };
  return { error: "no output produced" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    bench: 0,
    filter: "",
    json: "",
    outDir: path.join(repoRoot, ".tmp/oxc-diff"),
    // On by default: a disposition may not rest on the token class alone
    // (OX-D3 audit §2). `--no-referee` is for a quick triage pass only.
    referee: true,
    refreshCorpus: false,
    selfCheck: false,
    show: new Set(["semantic-suspect"]),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--bench": options.bench = Number(value); index += 1; break;
      case "--filter": options.filter = value; index += 1; break;
      case "--json": options.json = path.resolve(value); index += 1; break;
      case "--out": options.outDir = path.resolve(value); index += 1; break;
      case "--referee": options.referee = true; break;
      case "--no-referee": options.referee = false; break;
      case "--refresh-corpus": options.refreshCorpus = true; break;
      case "--self-check": options.selfCheck = true; break;
      case "--show":
        options.show = new Set(value === "all" ? CLASSES : value.split(","));
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.refreshCorpus) {
    refreshCorpus();
    return;
  }
  if (options.selfCheck) {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }

  const { listed, missing, traps } = readCorpus();
  const relatives = [...traps, ...listed.filter((relative) => !missing.includes(relative))]
    .filter((relative) => relative.includes(options.filter));
  const files = relatives.map((relative) => path.join(repoRoot, relative));
  if (files.length === 0) {
    throw new Error("no input files (check --filter)");
  }

  buildProbe();
  const probe = runProbe(files, options.outDir, options.bench);
  process.stderr.write(probe.stderr);

  const results = [];
  for (const [index, absolute] of files.entries()) {
    const swc = readVariant(options.outDir, "swc_norm", absolute);
    const oxc = readVariant(options.outDir, "oxc", absolute);
    const relative = relatives[index];
    if (swc.error || oxc.error) {
      results.push({
        class: swc.error && oxc.error ? "both-error" : swc.error ? "swc-error" : "oxc-error",
        file: relative,
        oxcError: oxc.error,
        swcError: swc.error,
      });
      continue;
    }
    results.push({
      file: relative,
      ...classify(swc.code, oxc.code),
      swcCode: swc.code,
      oxcCode: oxc.code,
    });
  }

  // The referee runs before anything is reported, so no summary can imply a
  // class is safe without it.
  let refereeControls = null;
  if (options.referee) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oxc-diff-referee-"));
    refereeControls = refereeControlsPass(workDir);
    for (const result of results) {
      if (result.swcCode === undefined || result.oxcCode === undefined) {
        result.referee = "NO-OUTPUT";
        continue;
      }
      const { verdict, detail } = refereeVerdict(result.swcCode, result.oxcCode, workDir);
      result.referee = verdict;
      if (detail) result.refereeDetail = detail;
    }
    fs.rmSync(workDir, { force: true, recursive: true });
  }
  for (const result of results) {
    delete result.swcCode;
    delete result.oxcCode;
  }

  const counts = new Map(CLASSES.map((name) => [name, 0]));
  for (const result of results) counts.set(result.class, counts.get(result.class) + 1);

  console.log(`\noxc-diff: ${results.length} files (${traps.length} traps, ${relatives.length - traps.length} corpus)`);
  if (missing.length > 0) {
    console.log(`  ${missing.length} corpus paths listed but absent (skipped): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}`);
  }
  console.log("");
  for (const name of CLASSES) {
    const count = counts.get(name);
    if (count === 0) continue;
    const share = ((count / results.length) * 100).toFixed(1);
    console.log(`  ${name.padEnd(17)} ${String(count).padStart(4)}  ${share.padStart(5)}%`);
  }

  // --- disposition ---------------------------------------------------------
  //
  // The token class above is triage: it says how far a diff moved. It does NOT
  // say the program still means the same thing -- 13 planted semantic mutations
  // all land in `token-level` (`--self-check`). The referee below is what a
  // re-baseline disposition rests on.
  if (!options.referee) {
    console.log(
      "\n  referee SKIPPED (--no-referee): triage only. Do NOT disposition a" +
        "\n  re-baseline from the classes above -- `token-level` cannot carry it.",
    );
  } else if (refereeControls !== true) {
    console.log(
      "\n  REFEREE CONTROLS FAILED -- esbuild did not agree that `((a)+b)*(c)`" +
        "\n  equals `(a+b)*c` and differs from `a+b*c`. Every verdict is withheld.",
    );
    process.exitCode = 2;
  } else {
    const grid = new Map();
    for (const result of results) {
      const key = `${result.class} / ${result.referee}`;
      grid.set(key, (grid.get(key) ?? 0) + 1);
    }
    console.log(`\n  structural referee (esbuild re-print, controls passed):`);
    for (const [key, count] of [...grid].sort()) {
      console.log(`    ${key.padEnd(46)} ${String(count).padStart(4)}`);
    }
    const escalated = results.filter((result) => result.referee !== "STRUCTURALLY-EQUAL");
    if (escalated.length === 0) {
      console.log("\n  every pair is structurally equal: the diffs above are print-shape only.");
    } else {
      console.log(
        `\n  ${escalated.length} pair(s) NOT structurally equal -- read every one, whatever their class:`,
      );
      for (const result of escalated) {
        console.log(
          `    [${result.class} / ${result.referee}] ${result.file}${result.refereeDetail ? `  ${result.refereeDetail}` : ""}`,
        );
      }
    }
  }

  for (const name of CLASSES) {
    if (!options.show.has(name)) continue;
    const shown = results.filter((result) => result.class === name);
    if (shown.length === 0) continue;
    console.log(`\n--- ${name} (${shown.length}) ---`);
    for (const result of shown) {
      console.log(`\n${result.file}`);
      if (result.swcError) console.log(`  swc: ${result.swcError.split("\n")[0]}`);
      if (result.oxcError) console.log(`  oxc: ${result.oxcError.split("\n")[0]}`);
      if (result.commentsAdded?.length) {
        console.log(`  comments oxc adds: ${result.commentsAdded.slice(0, 5).map((text) => JSON.stringify(text.slice(0, 60))).join(", ")}`);
      }
      if (result.names?.added.length) console.log(`  names +: ${result.names.added.slice(0, 8).join(", ")}`);
      if (result.names?.removed.length) console.log(`  names -: ${result.names.removed.slice(0, 8).join(", ")}`);
      if (result.literals?.added.length) console.log(`  values +: ${result.literals.added.slice(0, 8).join(", ")}`);
      if (result.literals?.removed.length) console.log(`  values -: ${result.literals.removed.slice(0, 8).join(", ")}`);
      if (result.swcContext) {
        console.log(`  at token ${result.firstDifference}`);
        console.log(`    swc: ...${result.swcContext}...`);
        console.log(`    oxc: ...${result.oxcContext}...`);
      }
    }
  }

  if (options.bench > 0) process.stdout.write(`\n${probe.stdout}`);

  if (options.json) {
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(
      options.json,
      `${JSON.stringify({ counts: Object.fromEntries(counts), missing, results }, null, 2)}\n`,
    );
    console.log(`\nwrote ${path.relative(repoRoot, options.json)}`);
  }
  console.log(`\noutputs: ${path.relative(repoRoot, options.outDir)}/{swc,swc_norm,oxc}/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}

