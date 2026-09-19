import { test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFileAsync = promisify(execFile);

test("prepared packed package compiles and executes through its declared native package without a local fallback", async () => {
  // The verifier packs prepared dist and npm/<host>; it never builds the package,
  // installs dependencies, or downloads a replacement native addon.
  await execFileAsync(
    process.execPath,
    [path.join(root, "scripts/verify-package.mjs")],
    {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}, 180000);
