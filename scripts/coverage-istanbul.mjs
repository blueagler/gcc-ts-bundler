#!/usr/bin/env node
// Convert an lcov trace (as emitted by `bun test --coverage-reporter=lcov`)
// into Istanbul coverage-final.json, which `fallow health --coverage` consumes
// for exact per-function CRAP scores instead of the static "untested" estimate.
//
// Usage: node ./scripts/coverage-istanbul.mjs <lcov.info> <coverage-final.json>
//
// Bun's lcov carries line hits (DA) only - no FN/FNDA function records - and
// fallow attributes coverage per function, so statement data alone is ignored.
// This script parses each covered source file with the TypeScript compiler,
// enumerates function-like declarations with their line ranges, and derives
// each function's invocation count from the hit count of the first executable
// line inside its body. Line hits are real measurements; the AST walk only
// attaches them to the functions that own those lines.
import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

function parseArgs(argv) {
  const [lcovPath, outPath] = argv;
  if (!lcovPath || !outPath) {
    console.error(
      "usage: coverage-istanbul.mjs <lcov.info> <coverage-final.json>",
    );
    process.exit(2);
  }
  return { lcovPath, outPath };
}

function parseLcov(lcovText, projectRoot) {
  const records = new Map();
  let current = null;
  for (const rawLine of lcovText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const sourcePath = line.slice(3);
      const absolute = path.isAbsolute(sourcePath)
        ? sourcePath
        : path.join(projectRoot, sourcePath);
      current = { path: absolute, lines: new Map(), branches: new Map() };
      records.set(absolute, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("DA:")) {
      const [lineNo, hits] = line.slice(3).split(",");
      current.lines.set(Number(lineNo), Number(hits));
      continue;
    }
    if (line.startsWith("BRDA:")) {
      const [lineNo, block, branch, taken] = line.slice(5).split(",");
      const key = `${lineNo}:${block}`;
      const entry = current.branches.get(key) ?? {
        line: Number(lineNo),
        hits: [],
      };
      entry.hits[Number(branch)] = taken === "-" ? 0 : Number(taken);
      current.branches.set(key, entry);
      continue;
    }
    if (line === "end_of_record") current = null;
  }
  return records;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const parent = node.parent;
  if (
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (
    parent !== undefined &&
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return "<anonymous>";
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function collectFunctions(filePath) {
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return [];
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = [];
  const visit = (node) => {
    if (isFunctionLike(node) && node.body !== undefined) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;
      const endLine =
        sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
      const bodyLine =
        sourceFile.getLineAndCharacterOfPosition(node.body.getStart(sourceFile))
          .line + 1;
      functions.push({ name: functionName(node), startLine, bodyLine, endLine });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function invocationCount(fn, lineHits) {
  // The first executable line inside the body runs once per invocation.
  for (let line = fn.bodyLine; line <= fn.endLine; line += 1) {
    const hits = lineHits.get(line);
    if (hits !== undefined) return hits;
  }
  return 0;
}

function lineLoc(startLine, endLine = startLine) {
  return {
    start: { line: startLine, column: 0 },
    end: { line: endLine, column: 10_000 },
  };
}

function toFileCoverage(record) {
  const file = {
    path: record.path,
    statementMap: {},
    s: {},
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
  let statementIndex = 0;
  for (const [line, hits] of [...record.lines].sort((a, b) => a[0] - b[0])) {
    const key = String(statementIndex);
    file.statementMap[key] = lineLoc(line);
    file.s[key] = hits;
    statementIndex += 1;
  }
  let functionIndex = 0;
  for (const fn of collectFunctions(record.path)) {
    const key = String(functionIndex);
    file.fnMap[key] = {
      name: fn.name,
      line: fn.startLine,
      decl: lineLoc(fn.startLine),
      loc: lineLoc(fn.startLine, fn.endLine),
    };
    file.f[key] = invocationCount(fn, record.lines);
    functionIndex += 1;
  }
  let branchIndex = 0;
  for (const [, branch] of record.branches) {
    const key = String(branchIndex);
    const hits = Array.from(branch.hits, (taken) => taken ?? 0);
    file.branchMap[key] = {
      type: "branch",
      line: branch.line,
      loc: lineLoc(branch.line),
      locations: hits.map(() => lineLoc(branch.line)),
    };
    file.b[key] = hits;
    branchIndex += 1;
  }
  return file;
}

export function lcovToIstanbul(lcovText, projectRoot) {
  const coverage = {};
  for (const record of parseLcov(lcovText, projectRoot).values()) {
    coverage[record.path] = toFileCoverage(record);
  }
  return coverage;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { lcovPath, outPath } = parseArgs(process.argv.slice(2));
  const lcovText = fs.readFileSync(lcovPath, "utf8");
  const coverage = lcovToIstanbul(lcovText, process.cwd());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(coverage)}\n`);
  let files = 0;
  let functions = 0;
  for (const record of Object.values(coverage)) {
    files += 1;
    functions += Object.keys(record.fnMap).length;
  }
  console.log(`Wrote ${files} file records (${functions} functions) to ${outPath}`);
}
