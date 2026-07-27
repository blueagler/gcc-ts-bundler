import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const generatedExternsFile = path.join(
  projectRoot,
  "jquery.generated.externs.js",
);

// Full type-surface externs: jQuery constructs its API reflectively
// (`tuple[0] + "With"`), so every typed member must survive renaming.
await generateExterns({
  appEntryFiles: ["./main.ts"],
  modules: ["jquery"],
  mode: "candidates",
  outputFile: generatedExternsFile,
  projectRoot,
  srcDir: ".",
});

// Internal runtime hazards: jQuery's data layer reads members through
// string keys (`dataPriv.get(elem, "events")`) that its own code writes
// with dot syntax, so the runtime-aware scan needs the data helpers
// declared as key-read protocol callees.
const runtimeExternsFile = path.join(
  projectRoot,
  "jquery.runtime.externs.js",
);
await generateExterns({
  appEntryFiles: ["./main.ts"],
  modules: ["jquery"],
  mode: "runtime-aware",
  outputFile: runtimeExternsFile,
  projectRoot,
  protocolHelpers: {
    keyExclusionListCallees: [],
    keyReadCallees: ["access", "data", "get"],
  },
  runtimeEntryFiles: ["./node_modules/jquery/dist/jquery.js"],
  srcDir: ".",
});

const result = await build({
  cache: { mode: "off" },
  diagnostics: { preflight: "full" },
  entries: ["./main.ts"],
  externs: ["./jquery.generated.externs.js", "./jquery.runtime.externs.js"],
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
