import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";
import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const generatedExternsFile = path.join(projectRoot, "lit.generated.externs.js");

// await generateExterns({
//   appEntryFiles: ["./main.ts"],
//   modules: ["lit", "@lit-labs/router", "@lit-labs/motion"],
//   mode: "boundary-aware",
//   outputFile: generatedExternsFile,
//   projectRoot,
//   srcDir: ".",
// });

const result = await build({
  cache: { mode: "off" },
  chunks: { loader: "script", mode: "bundler-runtime" },
  entries: ["./main.ts"],
  // externs: ["./lit.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: ".",
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
  `Built Lit playground to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(`Generated externs at ${path.relative(projectRoot, generatedExternsFile)}`);
