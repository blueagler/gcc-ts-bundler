import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { packPackage } from "./npm-command.mjs";
import {
  hostNativeTarget,
  nativeTargets,
  validateNativePackage,
} from "./native-targets.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
if (
  args.length !== 0 &&
  (args.length !== 4 ||
    args[0] !== "--archive" ||
    args[2] !== "--native-archive")
) {
  throw new Error(
    "Usage: verify-package.mjs [--archive root.tgz --native-archive native.tgz]",
  );
}
const node = process.versions.bun
  ? process.platform === "win32"
    ? "node.exe"
    : "node"
  : process.execPath;
const bun = process.platform === "win32" ? "bun.exe" : "bun";
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "gcc-ts-bundler-package-"),
);

try {
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  const host = hostNativeTarget();
  let archivePath;
  let nativeArchivePath;
  if (args.length) {
    archivePath = path.resolve(args[1]);
    nativeArchivePath = path.resolve(args[3]);
  } else {
    const packed = await Promise.allSettled([
      packPackage(packageRoot, temporaryRoot),
      packPackage(
        path.join(packageRoot, "npm", host.packageName),
        temporaryRoot,
      ),
    ]);
    const failure = packed.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    [archivePath, nativeArchivePath] = packed.map((result) => result.value);
  }
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
  if (
    packedPackageJson.name !== packageJson.name ||
    packedPackageJson.version !== packageJson.version
  ) {
    throw new Error("Packed root identity differs from the prepared package");
  }
  for (const target of Object.values(nativeTargets)) {
    if (
      packedPackageJson.optionalDependencies?.[target.packageName] !==
      packedPackageJson.version
    ) {
      throw new Error(
        `Packed root must declare coordinated native version for ${target.packageName}`,
      );
    }
  }
  const packedTargets = await verifyPackageTargets(
    installedPackageDir,
    packedPackageJson,
  );
  await assertOnlyDeclaredDeclarations(installedPackageDir, packedPackageJson);
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
  const installedNativeDir = path.join(
    consumerDir,
    "node_modules",
    host.packageName,
  );
  await mkdir(installedNativeDir, { recursive: true });
  await run(
    "tar",
    [
      "-xzf",
      nativeArchivePath,
      "-C",
      installedNativeDir,
      "--strip-components=1",
    ],
    consumerDir,
  );
  validateNativePackage(
    await readJson(path.join(installedNativeDir, "package.json")),
    host,
    packedPackageJson,
  );
  const addon = await lstat(path.join(installedNativeDir, "index.node"));
  if (!addon.isFile() || addon.size === 0)
    throw new Error(`Missing packed native addon for ${host.key}`);
  await assertMissing(
    path.join(installedPackageDir, "native"),
    "checkout-local native fallback",
  );
  for (const dependency of Object.keys(packedPackageJson.dependencies ?? {})) {
    await linkDependency(consumerDir, dependency);
  }
  await linkDependency(consumerDir, "vite");
  await linkDependency(consumerDir, "@types/node");
  await writeNodeNextConsumer(consumerDir);
  const checks = await Promise.allSettled([
    run(
      process.execPath,
      [
        path.join(packageRoot, "scripts/run-typescript.mjs"),
        "-p",
        "tsconfig.json",
      ],
      consumerDir,
    ),
    runImportSmoke(node, consumerDir),
    runImportSmoke(bun, consumerDir),
    run(
      process.execPath,
      [
        path.join(installedPackageDir, packedPackageJson.bin[packageJson.name]),
        "--help",
      ],
      consumerDir,
    ),
  ]);
  const failure = checks.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  // The negative native proof deletes the addon; all readers must finish first.
  await runNativeConsumer(consumerDir, installedNativeDir);

  console.log(
    `Verified ${packedTargets.length} package targets, NodeNext declarations, Node/Bun imports, and a native-backed consumer build.`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function runNativeConsumer(consumerDir, installedNativeDir) {
  await mkdir(path.join(consumerDir, "src"));
  await writeFile(
    path.join(consumerDir, "src/index.ts"),
    "export const answer: number = 42;\n",
  );
  const script = `
import assert from "node:assert/strict";
import { build } from "gcc-ts-bundler";
import { pathToFileURL } from "node:url";
import path from "node:path";
const result = await build({
  projectRoot: process.cwd(), srcDir: "src", outDir: "output",
  entries: ["index.ts"], target: "node", platformExterns: "minimal",
  cache: { mode: "off" }, chunks: { outputType: "esm" },
});
assert.equal(result.ok, true, JSON.stringify(result));
const output = await import(pathToFileURL(path.resolve("output/index.js")).href);
assert.equal(output.answer, 42);
`;
  await run(
    process.execPath,
    ["--input-type=module", "--eval", script],
    consumerDir,
  );
  await rm(path.join(installedNativeDir, "index.node"));
  // A fresh process must not find an ambient checkout addon or cached binding.
  let rejected = false;
  try {
    await run(
      process.execPath,
      ["--input-type=module", "--eval", script],
      consumerDir,
    );
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error(
      "Packed consumer succeeded without its selected native addon",
    );
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

async function assertOnlyDeclaredDeclarations(directory, packageJson) {
  const expected = [
    ...new Set(
      [
        packageJson.types,
        ...Object.values(packageJson.exports ?? {}).map((conditions) =>
          conditions && typeof conditions === "object"
            ? conditions.types
            : undefined,
        ),
      ]
        .filter((target) => typeof target === "string")
        .map((target) => target.replace(/^\.\//u, "")),
    ),
  ].sort();
  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files
    : [];
  const inventories = await Promise.allSettled(
    packageFiles.map((filePath) => listFiles(path.join(directory, filePath))),
  );
  const failure = inventories.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const actual = inventories
    .flatMap((result) => result.value)
    .map((filePath) => path.relative(directory, filePath).replace(/\\/gu, "/"))
    .filter((filePath) => filePath.endsWith(".d.ts"))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Packed declarations must match package export types:\n${JSON.stringify({ actual, expected }, null, 2)}`,
    );
  }
}

async function listFiles(directory) {
  const stats = await lstat(directory).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!stats) return [];
  if (stats.isFile()) return [directory];
  if (!stats.isDirectory()) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
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
import assert from "node:assert/strict";
import { DEFAULT_BUILD_OPTIONS } from "gcc-ts-bundler";
import "gcc-ts-bundler/vite";
import { reactPreset } from "gcc-ts-bundler/presets/react";
import { sveltePreset } from "gcc-ts-bundler/presets/svelte";
import { vuePreset } from "gcc-ts-bundler/presets/vue";

// This consumer is not compiled with the presets: read their public keys as
// the Vite plugin and native boundary do, rather than using exported constants
// from the same optimized module as the expected value.
const userRules = [
  { callee: "userClassMap", argIndex: 2, keyPattern: "^user" },
  { callee: "userPairs", argIndex: 0, keySource: "pairArray" },
];
const configurations = new Map();
for (const [name, preset, frameworkModules] of [
  ["react", reactPreset, ["react", "react-dom"]],
  ["svelte", sveltePreset, ["svelte"]],
  ["vue", vuePreset, ["vue"]],
]) {
  const options = preset({
    externModules: ["consumer-ui", "consumer-router"],
    compiler: {
      target: "node",
      platformExterns: "minimal",
      cache: { mode: "off" },
      compat: {
        classMapCalls: userRules,
        pureCallees: ["userTemplate", "userFragment"],
      },
    },
    externs: {
      generate: {
        mode: "boundary-aware",
        modules: ["consumer-host", "consumer-tools"],
        includeDependencies: false,
        propertyPolicy: { renameable: ["consumerPrivateField"] },
        protocolHelpers: {
          keyReadCallees: ["userRead", "userReadNext"],
          keyExclusionListCallees: ["userRest", "userRestNext"],
        },
      },
    },
  });
  configurations.set(name, options);
  const { compiler, externs } = options;
  assert.equal(compiler.target, "node", name + " compiler override");
  assert.equal(compiler.platformExterns, "minimal");
  assert.equal(compiler.cache.mode, "off");
  assert.deepEqual(compiler.compat.classMapCalls.slice(-2), userRules,
    name + " appends user rules in order");
  assert.deepEqual(compiler.compat.pureCallees.slice(-2),
    ["userTemplate", "userFragment"]);
  assert.equal(externs.generate.mode, "boundary-aware",
    name + " explicit generation mode wins");
  assert.equal(externs.generate.includeDependencies, false);
  assert.deepEqual(externs.generate.propertyPolicy.renameable,
    ["consumerPrivateField"]);
  assert.deepEqual(externs.generate.modules, [
    ...frameworkModules, "consumer-ui", "consumer-router",
    "consumer-host", "consumer-tools",
  ], name + " retains framework modules before both user module lists");
  const helpers = externs.generate.protocolHelpers;
  assert.deepEqual(helpers.keyReadCallees,
    [...(name === "svelte" ? ["prop"] : []), "userRead", "userReadNext"]);
  assert.deepEqual(helpers.keyExclusionListCallees,
    [...(name === "svelte" ? ["legacy_rest_props", "rest_props"] : []),
      "userRest", "userRestNext"]);
}

// Check meaningful native rule fields and regex behavior. A renamed optional
// field must fail too: new RegExp(undefined) would otherwise match everything.
const reactRules = configurations.get("react").compiler.compat.classMapCalls;
for (const callee of ["createElement", "jsx", "jsxs", "jsxDEV", "cloneElement"]) {
  const rule = reactRules.slice(0, -2).find((rule) => rule.callee === callee);
  assert.ok(rule, "React retains " + callee);
  assert.equal(rule.argIndex, 1);
  assert.equal(rule.stringLiteralArgIndex, 0);
  assert.equal(typeof rule.keyExcludePattern, "string");
  const excluded = new RegExp(rule.keyExcludePattern);
  for (const key of ["children", "key", "ref"]) assert.equal(excluded.test(key), true);
  for (const key of ["onClick", "style", "dangerouslySetInnerHTML"]) {
    assert.equal(excluded.test(key), false);
  }
}

const svelteCompat = configurations.get("svelte").compiler.compat;
const classRule = svelteCompat.classMapCalls.slice(0, -2)
  .find((rule) => rule.callee === "set_class");
assert.ok(classRule, "Svelte retains its class-map argument contract");
assert.equal(classRule.argIndex, 5);
for (const callee of [
  "from_html", "from_mathml", "from_svg", "from_tree", "ns_template",
  "template", "template_with_script",
]) {
  assert.ok(svelteCompat.pureCallees.slice(0, -2).includes(callee),
    "Svelte retains the pure template helper " + callee);
}

const vueRules = configurations.get("vue").compiler.compat.classMapCalls.slice(0, -2);
for (const callee of ["createElementVNode", "createElementBlock"]) {
  const rule = vueRules.find((rule) => rule.callee === callee);
  assert.ok(rule, "Vue retains " + callee);
  assert.equal(rule.argIndex, 1);
  assert.equal(rule.keyPattern, undefined, "DOM vnode props are unrestricted");
}
for (const [callee, argIndex] of [
  ["createVNode", 1], ["createBlock", 1], ["h", 1],
  ["mergeProps", 0], ["mergeProps", 1], ["mergeProps", 2], ["mergeProps", 3],
]) {
  const rule = vueRules.find((rule) => rule.callee === callee && rule.argIndex === argIndex);
  assert.ok(rule, "Vue retains " + callee + " argument " + argIndex);
  assert.equal(typeof rule.keyPattern, "string");
  const pinned = new RegExp(rule.keyPattern);
  for (const key of ["onClick", "onUpdate:modelValue", "key", "ref", "ref_for", "ref_key", "class", "style"]) {
    assert.equal(pinned.test(key), true, "Vue preserves " + key);
  }
  for (const key of ["label", "once", "modelValue"]) {
    assert.equal(pinned.test(key), false, "Vue leaves component props renamable");
  }
}
const exportHelper = vueRules.find((rule) => rule.callee === "default");
assert.ok(exportHelper, "Vue retains its SFC export helper");
assert.equal(exportHelper.argIndex, 1);
assert.equal(exportHelper.keySource, "pairArray");
assert.equal(typeof exportHelper.calleeModulePattern, "string");
const helperModule = new RegExp(exportHelper.calleeModulePattern);
assert.equal(helperModule.test("plugin-vue:export-helper"), true);
assert.equal(helperModule.test("plugin-vue-export-helper"), true);
assert.equal(helperModule.test("consumer-export-helper"), false);
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
