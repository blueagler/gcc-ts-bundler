// Build (if needed) and preview one example: bun run preview:examples <name>
// <name> matches an examples/ dir by exact name or prefix, e.g. "react".
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplesDir = path.join(root, "examples");
const names = readdirSync(examplesDir).filter((n) =>
  existsSync(path.join(examplesDir, n, "package.json")),
);

const arg = process.argv[2];
const previewOrder = [
  "react-vite-official",
  "svelte-vite-official",
  "lit-vite-official",
  "vue-vapor-vite-official",
  "jquery-vite-official",
];
const selectedNames = arg
  ? [names.find((n) => n === arg) ?? names.find((n) => n.startsWith(arg))]
  : previewOrder.filter((n) => names.includes(n));
if (selectedNames.some((name) => !name)) {
  console.error(`Usage: bun run preview:examples [name]\nExamples: ${names.join(", ")}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(100, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function restartPort(port) {
  if (!(await portIsOpen(port))) return;
  console.log(`[preview] restarting server on ${port}`);
  spawnSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 20 && (await portIsOpen(port)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const previewArgs = process.argv.slice(arg ? 3 : 2);
const hasPort = previewArgs.some((value) => value === "--port" || value.startsWith("--port="));
const hasHost = previewArgs.some((value) => value === "--host" || value.startsWith("--host="));
const defaultPreviewArgs = [
  ...(hasHost ? [] : ["--host", "0.0.0.0"]),
  ...(hasPort ? [] : ["--port"]),
];
const children = [];

for (const name of selectedNames) {
  const dir = path.join(examplesDir, name);
  const previewPort = 4173 + previewOrder.indexOf(name);
  if (!hasPort) await restartPort(previewPort);

  // The examples consume the plugin via link:, so the package dist must exist.
  if (!existsSync(path.join(root, "dist", "index.mjs"))) {
    console.log("[preview] package dist missing — running root build");
    run("bun", ["run", "build"], root);
  }
  if (!existsSync(path.join(dir, "dist", "index.html"))) {
    console.log(`[preview] ${name}/dist missing — building example`);
    run("bun", ["run", "build"], dir);
  }

  const child = spawn(
    "bun",
    [
      "run",
      "preview",
      ...previewArgs,
      ...defaultPreviewArgs,
      ...(hasPort ? [] : [String(previewPort)]),
    ],
    { cwd: dir, stdio: "inherit" },
  );
  children.push(child);
}

if (children.length > 0) {
  const stop = () => children.forEach((child) => child.kill("SIGTERM"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
        }),
    ),
  );
}
