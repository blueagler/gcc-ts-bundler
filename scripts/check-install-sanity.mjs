// Install-recursion canary (post-incident guard).
//
// A `file:../..` self-reference from examples once made bun recursively
// materialize node_modules/gcc-ts-bundler/examples/.../node_modules/... until
// the machine ran out of inodes. Examples must reference the parent package
// via the symlinking `link:` protocol only. This script fails when:
//   - any examples/*/node_modules/**/gcc-ts-bundler/examples path exists as a
//     real directory (a materialized copy of the repo inside an install), or
//   - gcc-ts-bundler nests under node_modules more than one level deep via
//     real directories, or
//   - any example declares gcc-ts-bundler with the file: protocol.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(repoRoot, "examples");
const failures = [];

function isRealDirectory(candidate) {
  const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
  return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink();
}

function scanNodeModules(dir, bundlerDepth, relative) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    const entryRelative = `${relative}/${entry.name}`;
    if (entry.name === "gcc-ts-bundler") {
      const nextDepth = bundlerDepth + 1;
      if (nextDepth > 1) {
        failures.push(`nested gcc-ts-bundler copy: ${entryRelative}`);
        continue;
      }
      if (isRealDirectory(path.join(entryPath, "examples"))) {
        failures.push(`materialized repo copy: ${entryRelative}/examples`);
        continue;
      }
      scanNodeModules(entryPath, nextDepth, entryRelative);
      continue;
    }
    scanNodeModules(entryPath, bundlerDepth, entryRelative);
  }
}

for (const example of fs.readdirSync(examplesDir)) {
  const exampleDir = path.join(examplesDir, example);
  if (!isRealDirectory(exampleDir)) {
    continue;
  }
  const packageJsonFile = path.join(exampleDir, "package.json");
  if (fs.existsSync(packageJsonFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
    const spec = {
      ...pkg.devDependencies,
      ...pkg.dependencies,
    }["gcc-ts-bundler"];
    if (typeof spec === "string" && spec.startsWith("file:")) {
      failures.push(
        `examples/${example} declares gcc-ts-bundler with file: (${spec}); use link:`,
      );
    }
  }
  const nodeModules = path.join(exampleDir, "node_modules");
  if (isRealDirectory(nodeModules)) {
    scanNodeModules(nodeModules, 0, `examples/${example}/node_modules`);
  }
}

if (failures.length > 0) {
  console.error("Install sanity check failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("Install sanity check passed.");
