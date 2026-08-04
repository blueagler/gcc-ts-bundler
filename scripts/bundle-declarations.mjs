import { runCommand } from "./command.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] ?? "dist");
const entries = [
  ["index.ts", "index.d.ts"],
  ["vite/index.ts", "vite/index.d.ts"],
  ["presets/react.ts", "presets/react.d.ts"],
  ["presets/svelte.ts", "presets/svelte.d.ts"],
  ["presets/vue.ts", "presets/vue.d.ts"],
];
const temporaryRoot = await mkdtemp(path.join(root, "src", ".dts-rollup-"));

try {
  for (const [index, [entry, output]] of entries.entries()) {
    const wrapperPath = path.join(temporaryRoot, `entry-${index}.ts`);
    await writeFile(
      wrapperPath,
      `/// <reference path="../types/google-closure-compiler-utils.d.ts" />\nexport * from "../${entry.replace(/\.ts$/u, "")}";\n`, 
    );
    await mkdir(path.dirname(path.join(outDir, output)), { recursive: true });
    await runCommand(
      process.execPath,
      [
        "--require",
        "./scripts/typescript6-register.cjs",
        "./node_modules/dts-bundle-generator/dist/bin/dts-bundle-generator.js",
        "--project",
        "./tsconfig.dts-bundle.json",
        "--no-banner",
        "--export-referenced-types",
        "false",
        "--out-file",
        path.join(outDir, output),
        wrapperPath,
      ],
      { cwd: root },
    );
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
