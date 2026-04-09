import { spawn } from "node:child_process";

await runCommandsInParallel([
  [process.execPath, ["./scripts/build-native.mjs"]],
  [process.execPath, ["./scripts/build-js.mjs"]],
]);

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
