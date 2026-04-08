import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, generateExterns } from "../../dist/index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const generatedExternsFile = path.join(root, "lazy.generated.externs.js");

await generateExterns({
  appEntryFiles: ["./main.ts"],
  modules: ["gcc-ts-bundler/runtime"],
  mode: "boundary-aware",
  outputFile: generatedExternsFile,
  projectRoot: root,
  srcDir: root,
});

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "closure-library", publicPath: "./" },
  entries: ["./main.ts"],
  externs: ["./lazy.generated.externs.js"],
  outDir: path.join(root, "dist"),
  projectRoot: root,
  srcDir: root,
});

if (result.exitCode !== 0) {
  console.error(result.diagnostics);
  process.exit(result.exitCode);
}

console.log(`Generated externs at ${path.relative(root, generatedExternsFile)}`);
