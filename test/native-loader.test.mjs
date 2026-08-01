import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { createFixture, execFileAsync } from "./helpers.mjs";

const NATIVE_PACKAGES = new Map([
  ["darwin-arm64", "gcc-ts-bundler-darwin-arm64"],
  ["darwin-x64", "gcc-ts-bundler-darwin-x64"],
  ["linux-arm64-gnu", "gcc-ts-bundler-linux-arm64-gnu"],
  ["linux-arm64-musl", "gcc-ts-bundler-linux-arm64-musl"],
  ["linux-x64-gnu", "gcc-ts-bundler-linux-x64-gnu"],
  ["linux-x64-musl", "gcc-ts-bundler-linux-x64-musl"],
  ["win32-arm64-msvc", "gcc-ts-bundler-win32-arm64-msvc"],
  ["win32-x64-msvc", "gcc-ts-bundler-win32-x64-msvc"],
]);

const nativePackageName = NATIVE_PACKAGES.get(getTargetKey());
const nativeLoaderTest = nativePackageName ? test : test.skip;

nativeLoaderTest(
  "linked installs load the consumer-side optional native package",
  async () => {
    const consumerDir = await createLinkedInstall(false);
    expect(await runConsumer(consumerDir)).toBe("loaded");
  },
);

nativeLoaderTest(
  "a broken local addon falls back to the consumer-side optional package",
  async () => {
    const consumerDir = await createLinkedInstall(true);
    expect(await runConsumer(consumerDir)).toBe("loaded");
  },
);

nativeLoaderTest(
  "native loader errors include every attempted fallback",
  async () => {
    const consumerDir = await createLinkedInstall(true, false);
    let stderr = "";
    try {
      await runConsumer(consumerDir);
    } catch (error) {
      stderr = String(error?.stderr ?? error);
    }
    expect(stderr).toContain("local development addon");
    expect(stderr).toContain(`${nativePackageName} from bundle`);
    expect(stderr).toContain(
      `${nativePackageName} from current working directory`,
    );
  },
);

async function createLinkedInstall(
  brokenLocalAddon,
  installOptionalPackage = true,
) {
  const fixture = await createFixture();
  const targetDir = path.join(fixture.projectRoot, "linked-package");
  const consumerDir = path.join(fixture.projectRoot, "consumer");
  const optionalPackageDir = path.join(
    consumerDir,
    "node_modules",
    nativePackageName,
  );
  await fs.mkdir(path.join(targetDir, "dist"), { recursive: true });
  if (installOptionalPackage) {
    await fs.mkdir(optionalPackageDir, { recursive: true });
  }
  await fs.copyFile(
    path.join(process.cwd(), "dist", "index.mjs"),
    path.join(targetDir, "dist", "index.mjs"),
  );
  if (installOptionalPackage) {
    await fs.copyFile(
      path.join(process.cwd(), "native", "index.node"),
      path.join(optionalPackageDir, "index.node"),
    );
  }
  const targetNodeModules = path.join(targetDir, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const dependencyName of [
    "@typescript/typescript6",
    "google-closure-compiler",
  ]) {
    const target = path.join(targetNodeModules, dependencyName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(
      path.join(process.cwd(), "node_modules", dependencyName),
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const assetDir of ["closure-externs", "closure-lib"]) {
    await fs.symlink(
      path.join(process.cwd(), assetDir),
      path.join(targetDir, assetDir),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await fs.writeFile(
    path.join(targetDir, "package.json"),
    JSON.stringify({
      exports: { ".": "./dist/index.mjs" },
      name: "gcc-ts-bundler",
      type: "module",
    }),
  );
  if (installOptionalPackage) {
    await fs.writeFile(
      path.join(optionalPackageDir, "package.json"),
      JSON.stringify({ main: "index.node", name: nativePackageName }),
    );
  }
  await fs.mkdir(path.join(consumerDir, "node_modules"), { recursive: true });
  await fs.symlink(
    targetDir,
    path.join(consumerDir, "node_modules", "gcc-ts-bundler"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (brokenLocalAddon) {
    await fs.mkdir(path.join(targetDir, "native"), { recursive: true });
    await fs.writeFile(path.join(targetDir, "native", "index.node"), "");
  }
  await fs.mkdir(path.join(consumerDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ESNext" },
    }),
  );
  await fs.writeFile(
    path.join(consumerDir, "src", "index.ts"),
    "export const value = 42;\n",
  );
  await fs.writeFile(
    path.join(consumerDir, "test.mjs"),
    [
      'import { build } from "gcc-ts-bundler";',
      "const result = await build({",
      '  cache: { mode: "off" },',
      '  entries: ["./index.ts"],',
      '  outDir: "./dist",',
      '  packages: "off",',
      "  projectRoot: process.cwd(),",
      '  srcDir: "./src",',
      "});",
      "if (!result.ok) { console.error(JSON.stringify(result)); process.exit(2); }",
      'console.log("loaded");',
      "",
    ].join("\n"),
  );
  return consumerDir;
}

async function runConsumer(consumerDir) {
  const { stdout } = await execFileAsync("node", ["test.mjs"], {
    cwd: consumerDir,
  });
  return stdout.trim();
}

function getTargetKey() {
  if (process.platform === "linux") {
    return `${process.platform}-${process.arch}-${detectLinuxLibc()}`;
  }
  if (process.platform === "win32") {
    return `${process.platform}-${process.arch}-msvc`;
  }
  return `${process.platform}-${process.arch}`;
}

function detectLinuxLibc() {
  const report = process.report?.getReport();
  if (typeof report?.header?.glibcVersionRuntime === "string") {
    return "gnu";
  }
  try {
    return execFileSync("ldd", ["--version"], { encoding: "utf8" }).includes(
      "musl",
    )
      ? "musl"
      : "gnu";
  } catch {
    return "musl";
  }
}
