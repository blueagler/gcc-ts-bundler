import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";
import { runCommand } from "./command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.argv[2] ?? "dist");
const entries = [
  "index",
  "vite/index",
  "presets/react",
  "presets/svelte",
  "presets/vue",
];
const rawDir = await mkdtemp(path.join(os.tmpdir(), "gcc-declarations-"));

try {
  await runCommand(process.execPath, [
    "./scripts/run-typescript.mjs",
    "--noEmit", "false",
    "--declaration",
    "--emitDeclarationOnly",
    "-p", "tsconfig.dts-bundle.json",
    "--outDir", rawDir,
    "--rootDir", root,
    "--noCheck",
  ], { cwd: root });

  for (const entry of entries) {
    const bundle = await rolldown({
      // Match the declaration emitter's relative region paths.
      cwd: rawDir,
      input: path.join(rawDir, "src", `${entry}.d.ts`),
      external: (id) =>
        !id.startsWith("\0") && !id.startsWith(".") && !path.isAbsolute(id),
      plugins: [
        dts({
          cwd: root,
          tsconfig: "./tsconfig.dts-bundle.json",
          dtsInput: true,
          emitDtsOnly: true,
        }),
      ],
    });
    try {
      await bundle.write({
        dir: path.dirname(path.join(outDir, `${entry}.d.ts`)),
        format: "es",
      });
    } finally {
      await bundle.close();
    }
  }
} finally {
  await rm(rawDir, { force: true, recursive: true });
}
