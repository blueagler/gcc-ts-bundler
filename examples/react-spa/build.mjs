import path from "path";
import { fileURLToPath } from "url";
import { build, generateExterns } from "../../dist/index.mjs";
import { REACT_ELEMENT_PROPS_CALLS } from "../../dist/presets/react.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const generatedExternsFile = path.join(
  projectRoot,
  "react.generated.externs.js",
);

await generateExterns({
  appEntryFiles: ["./main.tsx"],
  modules: ["react", "react-dom", "@tanstack/react-router"],
  mode: "boundary-aware",
  outputFile: generatedExternsFile,
  projectRoot,
  srcDir: "./src",
});

const result = await build({
  cache: { mode: "off" },
  // React dispatches on literal prop keys for host elements; the preset
  // carries that knowledge so `onClick` survives ADVANCED renaming.
  compat: { classMapCalls: [...REACT_ELEMENT_PROPS_CALLS] },
  diagnostics: { preflight: "full" },
  entries: ["./main.tsx"],
  externs: ["./react.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./src",
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
  `Built React SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Generated externs at ${path.relative(projectRoot, generatedExternsFile)}`,
);
