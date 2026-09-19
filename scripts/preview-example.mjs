// Preview one already-built example. Building and serving are separate operations.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplesDir = path.join(root, "examples");
const names = readdirSync(examplesDir).filter((name) =>
  existsSync(path.join(examplesDir, name, "package.json")),
);

try {
  const args = process.argv.slice(2);
  const selector = args.shift();
  if (!selector || selector.startsWith("-"))
    throw new Error(
      `Usage: bun run preview:examples <name> [--host host] [--port port]\nExamples: ${names.join(", ")}`,
    );
  const matches = names.includes(selector)
    ? [selector]
    : names.filter((name) => name.startsWith(selector));
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous example ${selector}: ${matches.join(", ")}`
        : `Unknown example ${selector}`,
    );
  const options = { host: "127.0.0.1", port: "4173" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--(host|port)(?:=(.*))?$/u.exec(args[index]);
    if (!match || seen.has(match[1]))
      throw new Error(`Invalid preview argument ${args[index]}`);
    const [, key, inline] = match;
    const value = inline ?? args[++index];
    if (!value || value.startsWith("-") || /\s/u.test(value))
      throw new Error(`--${key} requires a value`);
    options[key] = value;
    seen.add(key);
  }
  if (
    !/^\d+$/u.test(options.port) ||
    Number(options.port) < 1 ||
    Number(options.port) > 65535
  )
    throw new Error("Port must be an integer from 1 to 65535");
  const directory = path.join(examplesDir, matches[0]);
  if (!existsSync(path.join(directory, "dist", "index.html")))
    throw new Error(`Build ${matches[0]} before previewing it`);
  const require = createRequire(path.join(directory, "package.json"));
  const viteManifestPath = require.resolve("vite/package.json");
  const viteManifest = JSON.parse(readFileSync(viteManifestPath, "utf8"));
  const viteEntry =
    typeof viteManifest.bin === "string"
      ? viteManifest.bin
      : viteManifest.bin?.vite;
  if (typeof viteEntry !== "string")
    throw new Error("Installed Vite does not declare its CLI");
  const child = spawn(
    process.execPath,
    [
      path.resolve(path.dirname(viteManifestPath), viteEntry),
      "preview",
      "--host",
      options.host,
      "--port",
      options.port,
      "--strictPort",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  let interrupted;
  const forward = (signal) => {
    interrupted ??= signal;
    child.kill(signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (interrupted || signal) process.kill(process.pid, interrupted ?? signal);
    else process.exitCode = code ?? 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
