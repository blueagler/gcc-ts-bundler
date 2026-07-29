import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const npmCliPath = [
  process.env.npm_execpath?.endsWith("npm-cli.js")
    ? process.env.npm_execpath
    : undefined,
  path.resolve(
    path.dirname(process.execPath),
    "../lib/node_modules/npm/bin/npm-cli.js",
  ),
  path.resolve(
    path.dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  ),
].find((candidate) => candidate && existsSync(candidate));
const command = npmCliPath
  ? { args: [npmCliPath], executable: process.execPath }
  : {
      args: [],
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
    };

const child = spawn(
  command.executable,
  [...command.args, "publish", "--access", "public", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(
      new Error(
        signal
          ? `npm publish exited via signal ${signal}`
          : `npm publish exited with code ${code ?? 1}`,
      ),
    );
  });
});
