import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { createFixture, execFileAsync } from "./helpers.mjs";

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
      continue;
    }
    files.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * The fixture deliberately exercises every known path-dependent hash input:
 * a query-variant module id (materialized query-hash suffix), a node_modules
 * dependency (prebundled dependency bundle names), and a dynamic import
 * (lazy chunk + runtime manifest module ordering).
 */
async function writeFixtureSources(fixture) {
  await fixture.write(
    "index.html",
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <body>",
      '    <div id="app"></div>',
      '    <script type="module" src="/src/main.js"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/main.js",
    [
      'import { greet } from "dep-pkg";',
      'import { tag } from "./widget.js?variant=1";',
      'document.getElementById("app").textContent = greet(tag);',
      'globalThis["__loadFeature"] = () =>',
      '  import("./feature.js").then((module) => module.mount());',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/widget.js",
    ['export const tag = "widget";', ""].join("\n"),
  );
  // feature.js deliberately does NOT import dep-pkg: when a dependency is
  // reachable from one region only, esbuild keeps its bundle entry as real
  // code instead of a splittable forwarder, so the entry survives collapsing
  // and its request-key-derived name reaches the output.
  await fixture.write(
    "src/feature.js",
    ["export function mount() {", '  return "feature";', "}", ""].join("\n"),
  );
  await fixture.write(
    "node_modules/dep-pkg/package.json",
    JSON.stringify(
      { main: "index.js", name: "dep-pkg", type: "module", version: "1.0.0" },
      null,
      2,
    ),
  );
  // The dependency has to be large enough that the prebundler keeps it as a
  // separate bundle instead of collapsing it into the importer: only a
  // surviving dependency bundle exposes the request-key hash in output names.
  await fixture.write(
    "node_modules/dep-pkg/index.js",
    [
      'export { greet } from "./greet.js";',
      'export { format } from "./format.js";',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/dep-pkg/greet.js",
    [
      'import { format } from "./format.js";',
      "export function greet(name) {",
      "  return format(`hello ${name}`);",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/dep-pkg/format.js",
    [
      "const parts = [];",
      "export function format(value) {",
      "  parts.push(value);",
      '  return parts.map((part) => part.trim()).join(" ");',
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "vite.config.mjs",
    [
      `import { gccTsBundler } from ${JSON.stringify(
        pathToFileURL(path.join(process.cwd(), "dist/vite/index.mjs")).href,
      )};`,
      "",
      "export default {",
      "  build: {",
      '    outDir: "dist",',
      '    target: "es2018",',
      "  },",
      "  plugins: [",
      "    gccTsBundler({",
      '      compiler: { cache: { mode: "off" } },',
      "    }),",
      "  ],",
      "};",
      "",
    ].join("\n"),
  );
}

async function buildFixture(fixture) {
  const viteBin = path.join(
    process.cwd(),
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  await execFileAsync(process.execPath, [viteBin, "build"], {
    cwd: fixture.projectRoot,
    env: { ...process.env },
  });
}

test("builds are byte-identical across different project directories", async () => {
  const first = await createFixture();
  const second = await createFixture();
  expect(first.projectRoot).not.toBe(second.projectRoot);

  await writeFixtureSources(first);
  await writeFixtureSources(second);
  await buildFixture(first);
  await buildFixture(second);

  const firstFiles = await listFiles(first.outDir);
  const secondFiles = await listFiles(second.outDir);
  expect(firstFiles.length).toBeGreaterThan(1);
  // File names (including content hashes) must match exactly.
  expect(secondFiles).toEqual(firstFiles);
  // And every file must be byte-identical.
  for (const relativePath of firstFiles) {
    const firstBytes = await fs.readFile(path.join(first.outDir, relativePath));
    const secondBytes = await fs.readFile(
      path.join(second.outDir, relativePath),
    );
    expect(
      firstBytes.equals(secondBytes),
      `dist/${relativePath} differs between project directories`,
    ).toBe(true);
  }
}, 120000);
