import { rm } from "node:fs/promises";
import path from "node:path";
import { runCommand, runTasksInParallel } from "./command.mjs";

const BUN = process.platform === "win32" ? "bun.exe" : "bun";

if (process.argv.length > 3)
  throw new Error("Usage: build-js.mjs [output-directory]");
const outputRoot = path.resolve(process.argv[2] ?? ".");
const distDir = path.join(outputRoot, "dist");
const binDir = path.join(outputRoot, "bin");
await rm(distDir, { force: true, recursive: true });
await rm(binDir, { force: true, recursive: true });

await runTasksInParallel([
  () =>
    runCommand(BUN, [
      "build",
      "./src/index.ts",
      "./src/vite/index.ts",
      "./src/presets/react.ts",
      "./src/presets/svelte.ts",
      "./src/presets/vue.ts",
      "--outdir",
      distDir,
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "[dir]/[name].mjs",
      "--target",
      "node",
      "--root",
      "./src",
    ], { label: "build-js:esm" }),
  () =>
    runCommand(BUN, [
      "build",
      "./src/cli/main.ts",
      "--outdir",
      binDir,
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "gcc-ts-bundler.mjs",
      "--target",
      "node",
    ], { label: "build-js:cli" }),
  () =>
    runCommand(
      process.execPath,
      ["./scripts/bundle-declarations.mjs", distDir],
      { label: "build-js:types" },
    ),
]);
