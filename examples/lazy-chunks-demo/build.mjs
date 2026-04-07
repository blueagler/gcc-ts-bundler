import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "../../dist/index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "closure-library", publicPath: "./" },
  entries: ["./main.ts"],
  outDir: path.join(root, "dist"),
  projectRoot: root,
  srcDir: root,
});

if (result.exitCode !== 0) {
  console.error(result.diagnostics);
  process.exit(result.exitCode);
}
