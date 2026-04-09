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

await compileSvelteDirectory(srcDir);
await fs.rm(prebundleDir, { force: true, recursive: true });
await fs.mkdir(prebundleDir, { recursive: true });
await bundleWithEsbuild({
  bundle: true,
  chunkNames: "chunks/[name]-[hash]",
  entryPoints: [path.join(srcDir, "main.js")],
  format: "esm",
  outdir: prebundleDir,
  platform: "browser",
  splitting: true,
  target: "es2018",
});
// await generateExterns({
//   appEntryFiles: ["./main.js"],
//   mode: "runtime-aware",
//   modules: ["svelte"],
//   outputFile: "./svelte.generated.externs.js",
//   projectRoot,
//   runtimeEntryFiles: await collectRuntimeEntries(prebundleDir),
//   srcDir: "./src",
// });

const result = await build({
  cache: { mode: "off" },
  chunks: { loader: "script", mode: "bundler-runtime" },
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

async function compileSvelteDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await compileSvelteDirectory(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".svelte")) {
      continue;
    }
    const source = await fs.readFile(entryPath, "utf8");
    const outputFile = `${entryPath}.js`;
    const result = compile(source, {
      filename: outputFile,
      generate: "dom",
      dev: false,
    });
    await fs.writeFile(outputFile, result.js.code, "utf8");
  }
}

async function collectRuntimeEntries(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const runtimeEntries = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      runtimeEntries.push(...await collectRuntimeEntries(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      runtimeEntries.push(
        `./${path.relative(projectRoot, entryPath).replace(/\\/g, "/")}`,
      );
    }
  }
  return runtimeEntries.sort((left, right) => left.localeCompare(right));
}
