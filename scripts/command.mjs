import { spawn } from "node:child_process";

function startCommand(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });
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

export async function runCommand(command, args, options) {
  await startCommand(command, args, options).done;
}
