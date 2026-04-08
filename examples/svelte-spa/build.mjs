import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

import { compile } from "svelte/compiler";
import { build as bundleWithEsbuild } from "esbuild";

import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(projectRoot, "src");
const prebundleDir = path.join(projectRoot, ".prebundle");
const prebundleEntry = path.join(prebundleDir, "main.js");
const generatedExternsFile = path.join(projectRoot, "svelte.generated.externs.js");

await compileSvelteFile(path.join(srcDir, "App.svelte"));
await fs.rm(prebundleDir, { force: true, recursive: true });
await fs.mkdir(prebundleDir, { recursive: true });
await bundleWithEsbuild({
  bundle: true,
  entryPoints: [path.join(srcDir, "main.js")],
  format: "esm",
  outfile: prebundleEntry,
  platform: "browser",
  target: "es2018",
});
await generateExterns({
  appEntryFiles: ["./main.js"],
  mode: "runtime-aware",
  modules: ["svelte"],
  outputFile: "./svelte.generated.externs.js",
  projectRoot,
  runtimeEntryFiles: ["./.prebundle/main.js"],
  srcDir: "./src",
});

const result = await build({
  cache: { mode: "off" },
  diagnostics: { preflight: "full" },
  entries: ["./main.js"],
  externs: ["./svelte.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./.prebundle",
});

if (result.exitCode !== 0) {
  for (const diagnostic of result.diagnostics) {
    const message =
      typeof diagnostic?.messageText === "string"
        ? diagnostic.messageText
        : ts.flattenDiagnosticMessageText(
            diagnostic?.messageText ?? diagnostic,
            "\n",
          );
    console.error(message);
  }
  process.exit(result.exitCode);
}

console.log(
  `Built Svelte SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(`Bundled Svelte runtime through ${path.relative(projectRoot, prebundleEntry)}`);
console.log(`Generated externs at ${path.relative(projectRoot, generatedExternsFile)}`);

async function compileSvelteFile(inputFile) {
  const source = await fs.readFile(inputFile, "utf8");
  const outputFile = `${inputFile}.js`;
  const result = compile(source, {
    filename: outputFile,
    generate: "dom",
    dev: false,
  });
  await fs.writeFile(outputFile, result.js.code, "utf8");
}
