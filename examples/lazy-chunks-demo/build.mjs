import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "../../dist/index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "bundler-runtime", publicPath: "./" },
  entries: ["./main.ts"],
  outDir: path.join(root, "dist"),
  projectRoot: root,
  srcDir: root,
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
