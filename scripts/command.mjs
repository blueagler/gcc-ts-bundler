import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export async function runCommand(command, args, options = {}) {
  const { label, ...spawnOptions } = options;
  const startedAt = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, stdio: "inherit" });
    let commandError;
    child.once("error", (error) => {
      commandError = error;
    });
    child.once("close", (code, signal) => {
      if (commandError) {
        reject(commandError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            signal
              ? `${command} ${args.join(" ")} exited via signal ${signal}`
              : `${command} ${args.join(" ")} exited with code ${code ?? 1}`,
          ),
        );
      }
    });
  });
  if (process.env.GCC_BUILD_TIMINGS === "1" && label) {
    const durationMs = performance.now() - startedAt;
    console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
  }
}

export async function runTasksInParallel(tasks) {
  // Drain every writer before callers clean up. Killing a wrapper can orphan
  // its Cargo or TypeScript child, which may still be writing shared outputs.
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
