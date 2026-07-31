// Build (if needed) and preview one example: bun run preview:examples <name>
// <name> matches an examples/ dir by exact name or prefix, e.g. "react".
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplesDir = path.join(root, "examples");
const names = readdirSync(examplesDir).filter((n) =>
  existsSync(path.join(examplesDir, n, "package.json")),
);

const arg = process.argv[2];
const name = names.find((n) => n === arg) ?? names.find((n) => n.startsWith(arg ?? ""));
if (!arg || !name) {
  console.error(`Usage: bun run preview:examples <name>\nExamples: ${names.join(", ")}`);
  process.exit(1);
}
const dir = path.join(examplesDir, name);

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// The examples consume the plugin via link:, so the package dist must exist.
if (!existsSync(path.join(root, "dist", "index.mjs"))) {
  console.log("[preview] package dist missing — running root build");
  run("bun", ["run", "build"], root);
}
// The example's own dist is the plugin-built output vite preview serves.
if (!existsSync(path.join(dir, "dist", "index.html"))) {
  console.log(`[preview] ${name}/dist missing — building example`);
  run("bun", ["run", "build"], dir);
}
run("bun", ["run", "preview", ...process.argv.slice(3)], dir);
