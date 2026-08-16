import { readFile, writeFile } from "fs/promises";
import path from "path";

import prettier from "prettier";

const files = [
  "README.md",
  ".oxlintrc.json",
  "package.json",
  "tsconfig.json",
  "tsconfig.types.json",
];

async function main() {
  const checkOnly = process.argv.includes("--check");
  const dirty = [];
  const cwd = process.cwd();
  const sourceFiles = [];
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    absolute: false,
    cwd,
  })) {
    sourceFiles.push(file);
  }

  for (const file of [...sourceFiles, ...files]) {
    const filePath = path.resolve(cwd, file);
    const source = await readFile(filePath, "utf-8");
    const options = (await prettier.resolveConfig(filePath)) ?? {};
    const formatted = await prettier.format(source, {
      ...options,
      filepath: filePath,
    });

    if (formatted !== source) {
      if (checkOnly) {
        dirty.push(file);
      } else {
        await writeFile(filePath, formatted, "utf-8");
      }
    }
  }

  if (dirty.length > 0) {
    console.error(
      `format --check: ${dirty.length} file(s) need formatting:\n${dirty.join("\n")}`,
    );
    process.exit(1);
  }
}

await main();
