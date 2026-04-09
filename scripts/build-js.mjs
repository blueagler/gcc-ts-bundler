import { spawn } from "node:child_process";

const BUN = process.platform === "win32" ? "bun.exe" : "bun";

await runCommandsInParallel([
  [
    BUN,
    [
      "build",
      "./src/entry/cli.ts",
      "--outdir",
      "./bin",
      "--format",
      "cjs",
      "--packages",
      "external",
      "--banner",
      "#!/usr/bin/env node\nconst __gcc_current_module_url = require('node:url').pathToFileURL(__filename).href;",
      "--entry-naming",
      "gcc-ts-bundler.cjs",
      "--target",
      "node",
    ],
  ],
  [
    BUN,
    [
      "build",
      "./src/index.ts",
      "--outdir",
      "./dist",
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "index.mjs",
      "--target",
      "node",
    ],
  ],
  [
    BUN,
    [
      "build",
      "./src/index.ts",
      "--outdir",
      "./dist",
      "--format",
      "cjs",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = require('node:url').pathToFileURL(__filename).href;",
      "--entry-naming",
      "index.cjs",
      "--target",
      "node",
    ],
  ],
  [
    BUN,
    [
      "build",
      "./src/native/index.ts",
      "--outdir",
      "./dist/native",
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "index.mjs",
      "--target",
      "node",
    ],
  ],
  [
    BUN,
    [
      "build",
      "./src/native/index.ts",
      "--outdir",
      "./dist/native",
      "--format",
      "cjs",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = require('node:url').pathToFileURL(__filename).href;",
      "--entry-naming",
      "index.cjs",
      "--target",
      "node",
    ],
  ],
]);

await runCommand(BUN, ["--bun", "tsc", "-p", "./tsconfig.types.json"]);

async function runCommandsInParallel(commands) {
  const running = commands.map(([command, args]) => startCommand(command, args));
  try {
    await Promise.all(running.map(({ done }) => done));
  } catch (error) {
    for (const { child } of running) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

async function runCommand(command, args) {
  await startCommand(command, args).done;
}

function startCommand(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited via signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code ?? 1}`,
        ),
      );
    });
  });
  return { child, done };
}
