import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const BUN = process.platform === "win32" ? "bun.exe" : "bun";
const SHOW_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";

await Promise.all([
  rm("./dist", { force: true, recursive: true }),
  rm("./bin", { force: true, recursive: true }),
]);

await runCommandsInParallel([
  {
    args: [
      "build",
      "./src/index.ts",
      "./src/vite/index.ts",
      "./src/presets/react.ts",
      "./src/presets/svelte.ts",
      "./src/presets/vue.ts",
      "--outdir",
      "./dist",
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
    ],
    label: "build-js:esm",
  },
  {
    args: [
      "build",
      "./src/cli/main.ts",
      "--outdir",
      "./bin",
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
    ],
    label: "build-js:cli",
  },
]);

await runCommand(process.execPath, ["./scripts/bundle-declarations.mjs"], {
  label: "build-js:types",
});

async function runCommandsInParallel(commands) {
  const running = commands.map(({ args, label }) =>
    startCommand(BUN, args, { label }),
  );
  try {
    await Promise.all(running.map(({ done }) => done));
  } catch (error) {
    for (const { child } of running) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

async function runCommand(command, args, options = {}) {
  await startCommand(command, args, options).done;
}

function startCommand(command, args, { label } = {}) {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    stdio: "inherit",
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        logTiming(label, startedAt);
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

function logTiming(label, startedAt) {
  if (!SHOW_TIMINGS || !label) {
    return;
  }

  const durationMs = performance.now() - startedAt;
  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}
