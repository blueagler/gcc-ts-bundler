// Two-axis size gate: gzip is transfer cost, raw is what V8 parses.
//
// The Ant Design Pro trial app (2,352 modules, compiler v20260811) measured
// +31.3 KB gzip (+4.0%) while being -79.4 KB raw (-3.3%) versus no plugin.
// Reporting one axis hid the 4.0% wire regression while every check stayed
// green. This script always prints both deltas; only gzip is gated, because
// transfer is the cost users pay on the wire.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positionals = [];
  let tolerance = 0;
  for (const arg of argv) {
    if (arg.startsWith("--tolerance=")) {
      const raw = arg.slice("--tolerance=".length);
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        fail(
          `Invalid --tolerance=${raw}: expected a non-negative number (percent)`,
        );
      }
      tolerance = value;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown argument: ${arg}`);
    }
    positionals.push(arg);
  }
  if (positionals.length !== 2) {
    fail(
      "Usage: bun ./scripts/size-gate.mjs <baselineDir> <candidateDir> [--tolerance=<percent>]",
    );
  }
  return {
    baselineDir: positionals[0],
    candidateDir: positionals[1],
    tolerance,
  };
}

function errorDetail(error) {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown error";
}

function assertDirectory(dirPath, label) {
  let stats;
  try {
    stats = fs.statSync(dirPath);
  } catch (error) {
    fail(
      `${label} is not a readable directory: ${dirPath} (${errorDetail(error)})`,
    );
  }
  if (!stats.isDirectory()) {
    fail(`${label} is not a directory: ${dirPath}`);
  }
}

function listJsFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(
      `Cannot read directory: ${directory} (${errorDetail(error)})`,
    );
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

function measureDirectory(directory) {
  const files = listJsFiles(directory);
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file);
    } catch (error) {
      fail(`Cannot read file: ${file} (${errorDetail(error)})`);
    }
    raw += content.byteLength;
    gzip += zlib.gzipSync(content, { level: 9 }).byteLength;
  }
  return { files: files.length, gzip, raw };
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDelta(deltaBytes, baselineBytes) {
  const signedKb = `${deltaBytes >= 0 ? "+" : ""}${(deltaBytes / 1024).toFixed(1)} KB`;
  if (baselineBytes === 0) {
    return deltaBytes === 0 ? `${signedKb} (+0.00%)` : `${signedKb} (n/a %)`;
  }
  const percent = (deltaBytes / baselineBytes) * 100;
  const sign = percent > 0 ? "+" : "";
  return `${signedKb} (${sign}${percent.toFixed(2)}%)`;
}

function gzipDeltaPercent(baselineGzip, candidateGzip) {
  const delta = candidateGzip - baselineGzip;
  if (baselineGzip === 0) {
    return delta === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (delta / baselineGzip) * 100;
}

function pad(value, width) {
  return value.padEnd(width);
}

const { baselineDir, candidateDir, tolerance } = parseArgs(
  process.argv.slice(2),
);
assertDirectory(baselineDir, "baselineDir");
assertDirectory(candidateDir, "candidateDir");

const baseline = measureDirectory(baselineDir);
const candidate = measureDirectory(candidateDir);
const rawDelta = candidate.raw - baseline.raw;
const gzipDelta = candidate.gzip - baseline.gzip;
const gzipPercent = gzipDeltaPercent(baseline.gzip, candidate.gzip);

const axisWidth = 8;
const colWidth = 16;
console.log(
  "Two-axis size gate (raw = parse/compile CPU; gzip -9 = transfer)",
);
console.log(`baseline:  ${path.resolve(baselineDir)}  (${baseline.files} .js)`);
console.log(`candidate: ${path.resolve(candidateDir)}  (${candidate.files} .js)`);
console.log(`tolerance: ${tolerance}% gzip`);
console.log("");
console.log(
  `${pad("axis", axisWidth)}${pad("baseline", colWidth)}${pad("candidate", colWidth)}delta`,
);
console.log(
  `${pad("raw", axisWidth)}${pad(formatKb(baseline.raw), colWidth)}${pad(formatKb(candidate.raw), colWidth)}${formatDelta(rawDelta, baseline.raw)}`,
);
console.log(
  `${pad("gzip", axisWidth)}${pad(formatKb(baseline.gzip), colWidth)}${pad(formatKb(candidate.gzip), colWidth)}${formatDelta(gzipDelta, baseline.gzip)}`,
);

if (gzipPercent > tolerance) {
  const shown =
    Number.isFinite(gzipPercent) ? `${gzipPercent.toFixed(2)}%` : "n/a %";
  console.error(
    `FAIL: candidate gzip exceeds baseline by ${shown} (tolerance ${tolerance}%)`,
  );
  process.exit(1);
}

console.log("PASS");
