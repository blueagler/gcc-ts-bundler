import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "7.0.2";
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const typescriptRoot = path.join(packageRoot, "node_modules", "typescript");
const packageJson = JSON.parse(
  readFileSync(path.join(typescriptRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "typescript") {
  throw new Error(
    `Expected official typescript package, found ${String(packageJson.name)}`,
  );
}
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(
    `Expected typescript@${EXPECTED_VERSION}, found ${String(packageJson.version)}`,
  );
}
const binEntries =
  packageJson.bin &&
  typeof packageJson.bin === "object" &&
  !Array.isArray(packageJson.bin)
    ? Object.entries(packageJson.bin)
    : [];
if (
  binEntries.length !== 1 ||
  binEntries[0]?.[0] !== "tsc" ||
  binEntries[0]?.[1] !== "./bin/tsc"
) {
  throw new Error("typescript package must expose only tsc at ./bin/tsc");
}
const launcherPath = path.resolve(typescriptRoot, binEntries[0][1]);
const expectedLauncherPath = path.join(typescriptRoot, "bin", "tsc");
if (launcherPath !== expectedLauncherPath) {
  throw new Error("typescript tsc launcher resolved outside the official bin path");
}
const result = spawnSync(
  process.execPath,
  [launcherPath, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
