import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const generatedExternsFile = path.join(
  projectRoot,
  "jquery.generated.externs.js",
);

await generateExterns({
  appEntryFiles: ["./main.ts"],
  modules: ["jquery"],
  mode: "boundary-aware",
  outputFile: generatedExternsFile,
  projectRoot,
  srcDir: ".",
});

const result = await build({
  cache: { mode: "off" },
  diagnostics: { preflight: "full" },
  entries: ["./main.ts"],
  externs: ["./jquery.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: ".",
});

if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    const where = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}: `
      : "";
    console.error(`${where}${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(
  `Built jQuery extern demo to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Generated externs at ${path.relative(projectRoot, generatedExternsFile)}`,
);
