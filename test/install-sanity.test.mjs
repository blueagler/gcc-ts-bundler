import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("example installs never materialize a recursive gcc-ts-bundler copy", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "check-install-sanity.mjs")],
    { encoding: "utf8" },
  );
  expect(output).toContain("Install sanity check passed.");
});
