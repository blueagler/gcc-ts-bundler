import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmCliPath = [
  process.env.npm_execpath?.endsWith("npm-cli.js")
    ? process.env.npm_execpath
    : undefined,
  path.resolve(
    path.dirname(process.execPath),
    "../lib/node_modules/npm/bin/npm-cli.js",
  ),
  path.resolve(
    path.dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  ),
].find((candidate) => candidate && existsSync(candidate));
const npmCommand = npmCliPath
  ? { args: [npmCliPath], command: process.execPath }
  : {
      args: [],
      command: process.platform === "win32" ? "npm.cmd" : "npm",
    };
const bun = process.platform === "win32" ? "bun.exe" : "bun";
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "gcc-ts-bundler-package-"),
);

try {
  await run(process.execPath, ["./scripts/build-js.mjs"], packageRoot);

  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  const rootTargets = await verifyPackageTargets(packageRoot, packageJson);
  const archivePath = await packPackage(temporaryRoot);
  const installedPackageDir = path.join(
    temporaryRoot,
    "consumer",
    "node_modules",
    packageJson.name,
  );
  await mkdir(installedPackageDir, { recursive: true });
  await run(
    "tar",
    ["-xzf", archivePath, "-C", installedPackageDir, "--strip-components=1"],
    packageRoot,
  );

  const packedPackageJson = await readJson(
    path.join(installedPackageDir, "package.json"),
  );
  const packedTargets = await verifyPackageTargets(
    installedPackageDir,
    packedPackageJson,
  );
  if (packedPackageJson.license !== "Apache-2.0") {
    throw new Error("Packed package is missing Apache-2.0 license metadata");
  }
  await assertFile(path.join(installedPackageDir, "LICENSE"), "packed LICENSE");
  if (Object.hasOwn(packedPackageJson.exports, "./native")) {
    throw new Error("Packed package still exposes the raw native binding");
  }
  await assertMissing(
    path.join(installedPackageDir, "dist/native/index.mjs"),
    "raw native entry",
  );
  await assertMissing(
    path.join(installedPackageDir, "dist/shared/lifecycle-size.mjs"),
    "standalone lifecycle-size entry",
  );

  const consumerDir = path.join(temporaryRoot, "consumer");
  for (const dependency of Object.keys(packedPackageJson.dependencies ?? {})) {
    await linkDependency(consumerDir, dependency);
  }
  await linkDependency(consumerDir, "vite");
  await linkDependency(consumerDir, "@types/node");
  await writeNodeNextConsumer(consumerDir);
  await run(
    process.execPath,
    [
      path.join(packageRoot, "scripts/run-typescript.mjs"),
      "-p",
      "tsconfig.json",
    ],
    consumerDir,
  );
  await runImportSmoke(process.execPath, consumerDir);
  await runImportSmoke(bun, consumerDir);
  await run(
    process.execPath,
    [
      path.join(installedPackageDir, packedPackageJson.bin[packageJson.name]),
      "--help",
    ],
    consumerDir,
  );

  if (rootTargets.length !== packedTargets.length) {
    throw new Error(
      `Packed target count changed (${rootTargets.length} -> ${packedTargets.length})`,
    );
  }
  console.log(
    `Verified ${packedTargets.length} package targets, NodeNext declarations, and Node/Bun imports.`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function packPackage(destination) {
  const { stdout } = await execFileAsync(
    npmCommand.command,
    [
      ...npmCommand.args,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, npm_config_dry_run: "false" },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  const filename = result[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error(`npm pack returned no filename: ${stdout}`);
  }
  return path.join(destination, filename);
}

async function verifyPackageTargets(directory, packageJson) {
  const targets = [
    ["types", packageJson.types],
    ...collectExportTargets(packageJson.exports),
    ...collectBinTargets(packageJson.bin),
  ].filter((entry) => typeof entry[1] === "string");

  for (const [label, target] of targets) {
    const relativeTarget = target.replace(/^\.\//u, "");
    const targetPath = path.resolve(directory, relativeTarget);
    if (!targetPath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw new Error(`${label} escapes the package: ${target}`);
    }
    await assertFile(targetPath, `${label} target ${target}`);
  }
  return targets;
}

function collectExportTargets(exports, label = "exports") {
  if (typeof exports === "string") {
    return [[label, exports]];
  }
  if (Array.isArray(exports)) {
    return exports.flatMap((value, index) =>
      collectExportTargets(value, `${label}[${index}]`),
    );
  }
  if (!exports || typeof exports !== "object") {
    return [];
  }
  return Object.entries(exports).flatMap(([key, value]) =>
    collectExportTargets(value, `${label}.${key}`),
  );
}

function collectBinTargets(bin) {
  if (typeof bin === "string") {
    return [["bin", bin]];
  }
  if (!bin || typeof bin !== "object") {
    return [];
  }
  return Object.entries(bin).map(([name, target]) => [`bin.${name}`, target]);
}

async function linkDependency(consumerDir, specifier) {
  const source = path.join(
    packageRoot,
    "node_modules",
    ...specifier.split("/"),
  );
  const target = path.join(
    consumerDir,
    "node_modules",
    ...specifier.split("/"),
  );
  await assertFileOrDirectory(source, `installed dependency ${specifier}`);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeNodeNextConsumer(consumerDir) {
  await writeFile(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  await writeFile(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node"],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumerDir, "consumer.ts"),
    `import {
  DEFAULT_BUILD_OPTIONS,
  type BuildOptions,
  type ExternModuleInput,
  type GenerateExternsResult,
} from "gcc-ts-bundler";
import { gccTsBundler } from "gcc-ts-bundler/vite";
import { reactPreset } from "gcc-ts-bundler/presets/react";
import { sveltePreset } from "gcc-ts-bundler/presets/svelte";
import { vuePreset } from "gcc-ts-bundler/presets/vue";
// @ts-expect-error ResolvedBuildOptions is internal.
import type { ResolvedBuildOptions } from "gcc-ts-bundler";

const options: BuildOptions = {
  chunks: { outputType: "esm", vendorChunk: true },
  compat: { classMapCalls: [] },
  entries: ["./index.ts"],
  platformExterns: "minimal",
  typedExterns: ["./runtime.typed.externs.js"],
};
const externalModule: ExternModuleInput = {
  runtime: "external",
  specifier: "host-runtime",
};
const typedDeclarations = (result: GenerateExternsResult) =>
  result.typedDeclarations;
const removedWarningOption: BuildOptions = {
  diagnostics: {
    // @ts-expect-error fatalWarnings was removed until a warning channel exists.
    fatalWarnings: true,
  },
  entries: ["./index.ts"],
};
const internalMetadata: BuildOptions = {
  entries: ["./index.ts"],
  // @ts-expect-error typeMetadata is Vite pipeline metadata.
  typeMetadata: undefined,
};

void [
  DEFAULT_BUILD_OPTIONS,
  externalModule,
  gccTsBundler,
  reactPreset,
  sveltePreset,
  typedDeclarations,
  vuePreset,
  options,
  removedWarningOption,
  internalMetadata,
];
`,
  );
}

async function runImportSmoke(command, cwd) {
  const script = `
const specifiers = [
  "gcc-ts-bundler",
  "gcc-ts-bundler/vite",
  "gcc-ts-bundler/presets/react",
  "gcc-ts-bundler/presets/svelte",
  "gcc-ts-bundler/presets/vue",
];
for (const specifier of specifiers) await import(specifier);
const { DEFAULT_BUILD_OPTIONS } = await import("gcc-ts-bundler");
const seen = new Set();
const assertDeepFrozen = (value, location = "DEFAULT_BUILD_OPTIONS") => {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Object.isFrozen(value)) throw new Error(location + " is mutable");
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, location + "." + key);
  }
};
assertDeepFrozen(DEFAULT_BUILD_OPTIONS);
if ("typeMetadata" in DEFAULT_BUILD_OPTIONS) {
  throw new Error("DEFAULT_BUILD_OPTIONS exposes internal type metadata");
}
`;
  await run(command, ["--input-type=module", "--eval", script], cwd);
}

async function assertFile(filePath, label) {
  await access(filePath, constants.R_OK).catch(() => {
    throw new Error(`Missing ${label}: ${filePath}`);
  });
}

async function assertMissing(filePath, label) {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    return;
  }
  throw new Error(`Unexpected ${label}: ${filePath}`);
}

async function assertFileOrDirectory(filePath, label) {
  await access(filePath, constants.R_OK).catch(() => {
    throw new Error(`Missing ${label}: ${filePath}`);
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
}
