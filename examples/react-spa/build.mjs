import path from "path";
import ts from "typescript";
import { build } from "../../dist/index.mjs";

const projectRoot = process.cwd();
const result = await build({
  cache: { mode: "off" },
  diagnostics: { preflight: "full" },
  entries: ["./main.tsx"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./src",
});

if (result.exitCode !== 0) {
  for (const diagnostic of result.diagnostics) {
    const message =
      typeof diagnostic?.messageText === "string"
        ? diagnostic.messageText
        : ts.flattenDiagnosticMessageText(diagnostic?.messageText ?? diagnostic, "\n");
    console.error(message);
  }
  process.exit(result.exitCode);
}

console.log(
  `Built React SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
