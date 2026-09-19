import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

export async function runNpm(args, cwd) {
  return execFileAsync(
    npmCliPath
      ? process.execPath
      : process.platform === "win32"
        ? "npm.cmd"
        : "npm",
    [...(npmCliPath ? [npmCliPath] : []), ...args],
    {
      cwd,
      env: { ...process.env, npm_config_dry_run: "false" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

export async function packPackage(directory, destination) {
  // Use the same packer for direct Bun invocation and Node package scripts.
  // Select the archive path explicitly instead of parsing console output.
  const bun = process.versions.bun
    ? process.execPath
    : process.platform === "win32"
      ? "bun.exe"
      : "bun";
  const archive = path.resolve(destination, `${randomUUID()}.tgz`);
  await execFileAsync(
    bun,
    ["pm", "pack", "--ignore-scripts", "--filename", archive, "--quiet"],
    {
      cwd: directory,
      env: { ...process.env, npm_config_dry_run: "false" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return archive;
}
