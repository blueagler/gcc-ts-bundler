import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const typescriptRoot = path.join(packageRoot, "node_modules", "typescript");
const packageJson = JSON.parse(
  readFileSync(path.join(typescriptRoot, "package.json"), "utf8"),
);
const launcherPath = path.resolve(typescriptRoot, packageJson.bin.tsc);
const result = spawnSync(
  process.execPath,
  [launcherPath, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
