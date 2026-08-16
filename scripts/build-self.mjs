import { runCommand } from "./command.mjs";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-selfbuild-"));
const packageManifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const publicSpecifiers = Object.keys(packageManifest.exports).map((specifier) =>
  specifier === "."
    ? packageManifest.name
    : `${packageManifest.name}/${specifier.slice(2)}`,
);
const runtimeExternals = [
  "@typescript/typescript6",
  "google-closure-compiler",
  "google-closure-compiler/lib/utils.js",
  "vite",
];
const preservedModules = ["src/native/load.ts"];
const libraryEntries = Object.entries(packageManifest.exports).map(
  ([specifier, conditions]) => {
    const outputPath = conditions.default;
    if (typeof outputPath !== "string" || !outputPath.startsWith("./dist/")) {
      throw new Error(`Unsupported package export output for ${specifier}`);
    }
    const name = outputPath.slice("./dist/".length);
    return {
      file: name.replace(/\.mjs$/u, ".ts"),
      name,
    };
  },
);
const cliOutputRelative = Object.values(packageManifest.bin)[0];
if (typeof cliOutputRelative !== "string" || !cliOutputRelative.startsWith("bin/")) {
  throw new Error("Unsupported package bin output");
}
const stagedCliOutputName = path.posix.join(
  "__bin__",
  path.basename(cliOutputRelative),
);
const packageEntries = [
  ...libraryEntries,
  { file: "cli/main.ts", name: stagedCliOutputName },
];
const presetEntryOutputs = libraryEntries
  .filter(({ file }) => file.startsWith("presets/"))
  .map(({ name }) => name);
const generatedPackageRoots = new Set(
  [
    packageManifest.types,
    ...Object.values(packageManifest.exports).flatMap((conditions) =>
      Object.values(conditions),
    ),
    ...Object.values(packageManifest.bin),
  ].map(packagePathRoot),
);
const runtimeAssetExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".node",
  ".wasm",
]);

try {
  await runCommand(process.execPath, ["./scripts/build-native.mjs"], { cwd: root });
  await runCommand(process.execPath, ["./scripts/build-js.mjs"], { cwd: root });
  const stage0 = path.join(temporaryRoot, "stage-0");
  await snapshotShippedTree(stage0);

  const stage1 = path.join(temporaryRoot, "stage-1");
  await buildStage(path.join(root, "dist/index.mjs"), stage1, "stage-1");
  const stage2 = path.join(temporaryRoot, "stage-2");
  await buildStage(path.join(stage1, "dist/index.mjs"), stage2, "stage-2");

  await assertTreesEqual(stage1, stage2);
  console.log("Self-build fixpoint: stage-1 and stage-2 are byte-identical.");
  await printSizeReport(stage0, stage1);
  await publishStage(stage1);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function buildStage(compilerPath, stageRoot, label) {
  await prepareStageRoot(stageRoot);
  await copyBootstrapDeclarations(path.join(stageRoot, "dist"));
  const compiler = await import(
    `${pathToFileURL(compilerPath).href}?selfbuild=${encodeURIComponent(label)}`
  );
  const typedExternPath = path.join(stageRoot, "public-api.typed.externs.js");
  const externResult = await compiler.generateExterns({
    modules: publicSpecifiers.map((specifier) => ({
      exports: "all",
      runtime: "external",
      specifier,
    })),
    projectRoot: stageRoot,
    srcDir: ".",
    target: "node",
    typedOutputFile: typedExternPath,
  });
  assertCompletePublicExterns(externResult);

  await runCompilerBuild(compiler.build, {
    entries: packageEntries,
    outDir: path.join(stageRoot, "dist"),
    typedExternPath,
  });
  await removePresetSharedImports(stageRoot);
  await relocateCliEntry(stageRoot);
  await copyBootstrapDeclarations(path.join(stageRoot, "dist"));
  await assertDeclaredPackageEntrypoints(stageRoot);
  await assertCliShebang(path.join(stageRoot, cliOutputRelative));
}

async function runCompilerBuild(build, { entries, outDir, typedExternPath }) {
  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "off", outputType: "esm" },
    compilationLevel: "ADVANCED",
    diagnostics: { preflight: "errors-only", verbose: true },
    entries,
    externals: runtimeExternals,
    languageOut: "ECMASCRIPT_NEXT",
    outDir,
    packages: "esm-only",
    preserveModules: preservedModules,
    projectRoot: root,
    srcDir: "src",
    target: "node",
    typedExterns: [typedExternPath],
  });
  if (!result.ok) {
    throw new Error(
      `Self-build compile failed:\n${result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n")}`,
    );
  }
}

async function removePresetSharedImports(stageRoot) {
  for (const outputName of presetEntryOutputs) {
    const outputPath = path.join(stageRoot, "dist", outputName);
    const source = await readFile(outputPath, "utf8");
    const leafSource = source.replace(/^import["']\.\.\/shared\.js["'];/u, "");
    if (leafSource.includes("../shared.js")) {
      throw new Error(`Preset entry still depends on shared.js: ${outputName}`);
    }
    await writeFile(outputPath, leafSource, "utf8");
  }
}

async function relocateCliEntry(stageRoot) {
  const stagedPath = path.join(stageRoot, "dist", stagedCliOutputName);
  const finalPath = path.join(stageRoot, cliOutputRelative);
  const distRoot = path.join(stageRoot, "dist");
  const source = await readFile(stagedPath, "utf8");
  const relocatedSource = source.replace(
    /(\b(?:from|import)\s*)(["'])([^"']+)\2/gu,
    (full, prefix, quote, specifier) => {
      if (!specifier.startsWith(".")) return full;
      const target = path.resolve(path.dirname(stagedPath), specifier);
      if (!target.startsWith(`${distRoot}${path.sep}`)) return full;
      const relative = path
        .relative(path.dirname(finalPath), target)
        .replace(/\\/gu, "/");
      const relocatedSpecifier = relative.startsWith(".")
        ? relative
        : `./${relative}`;
      return `${prefix}${quote}${relocatedSpecifier}${quote}`;
    },
  );
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(stagedPath, relocatedSource, "utf8");
  await rename(stagedPath, finalPath);
  await rm(path.dirname(stagedPath), { force: true, recursive: true });
}

async function assertDeclaredPackageEntrypoints(stageRoot) {
  const declared = [
    ["types", packageManifest.types],
    ...Object.entries(packageManifest.exports).flatMap(
      ([specifier, conditions]) =>
        ["types", "default"].map((condition) => [
          `exports[${JSON.stringify(specifier)}].${condition}`,
          conditions[condition],
        ]),
    ),
    ...Object.entries(packageManifest.bin).map(([name, filePath]) => [
      `bin.${name}`,
      filePath,
    ]),
  ];
  for (const [label, declaredPath] of declared) {
    if (typeof declaredPath !== "string") {
      throw new Error(`Package entrypoint ${label} is not a string path`);
    }
    const normalized = declaredPath.replace(/^\.\//u, "");
    const resolved = path.resolve(stageRoot, normalized);
    if (!resolved.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) {
      throw new Error(`Package entrypoint ${label} escapes the package root`);
    }
    if (!existsSync(resolved)) {
      throw new Error(
        `Self-build did not publish package entrypoint ${label}: ${declaredPath}`,
      );
    }
  }
  console.log(
    `Self-build package entrypoints: verified ${declared.length} declared paths.`,
  );
}

function assertCompletePublicExterns(result) {
  const degradation = result.typedDeclarations.degradations;
  const failures = [];
  if (result.diagnostics.length > 0) {
    failures.push(`diagnostics: ${JSON.stringify(result.diagnostics)}`);
  }
  if (result.warnings.length > 0) {
    failures.push(`warnings: ${JSON.stringify(result.warnings)}`);
  }
  if (
    degradation.degradedOccurrences !== 0 ||
    degradation.degradedSymbolCount !== 0
  ) {
    failures.push(`degradations: ${JSON.stringify(degradation)}`);
  }
  if (
    result.typedDeclarations.moduleExports.length !== publicSpecifiers.length
  ) {
    failures.push(
      `rendered ${result.typedDeclarations.moduleExports.length} of ${publicSpecifiers.length} public declaration modules`,
    );
  }
  if (result.typedDeclarations.propertyNames.length === 0) {
    failures.push("renderer produced no public property names");
  }
  if (failures.length > 0) {
    throw new Error(`Public API extern generation failed closed: ${failures.join("; ")}`);
  }
}

async function prepareStageRoot(stageRoot) {
  await mkdir(path.join(stageRoot, "dist"), { recursive: true });
  await cp(path.join(root, "package.json"), path.join(stageRoot, "package.json"));
  await stageRuntimePackageAssets(stageRoot);
  await symlink(path.join(root, "node_modules"), path.join(stageRoot, "node_modules"), "dir");
  await symlink(path.join(root, "native"), path.join(stageRoot, "native"), "dir");
}

async function stageRuntimePackageAssets(stageRoot) {
  if (!Array.isArray(packageManifest.files)) {
    throw new Error("package.json files must declare the shipped package tree");
  }
  const assets = [];
  for (const declaredPath of packageManifest.files) {
    if (typeof declaredPath !== "string") {
      throw new Error("package.json files entries must be strings");
    }
    const relativePath = normalizePackagePath(declaredPath);
    if (generatedPackageRoots.has(packagePathRoot(relativePath))) continue;
    const sourcePath = path.join(root, relativePath);
    if (
      existsSync(sourcePath) &&
      (await containsRuntimeAsset(sourcePath))
    ) {
      assets.push(relativePath);
    }
  }
  await Promise.all(
    assets.map((relativePath) =>
      cp(path.join(root, relativePath), path.join(stageRoot, relativePath), {
        recursive: true,
      }),
    ),
  );
  console.log(`Self-build runtime assets: ${assets.sort().join(", ")}`);
}

async function containsRuntimeAsset(candidatePath) {
  const stats = await lstat(candidatePath);
  if (stats.isFile()) {
    return runtimeAssetExtensions.has(path.extname(candidatePath));
  }
  if (!stats.isDirectory()) return false;
  for (const entry of await readdir(candidatePath, { withFileTypes: true })) {
    if (await containsRuntimeAsset(path.join(candidatePath, entry.name))) return true;
  }
  return false;
}

function packagePathRoot(packagePath) {
  return normalizePackagePath(packagePath).split("/")[0];
}

function normalizePackagePath(packagePath) {
  const normalized = packagePath.replace(/^\.\//u, "").replace(/\\/gu, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Package path escapes the package root: ${packagePath}`);
  }
  return normalized;
}

async function copyBootstrapDeclarations(outDir) {
  await Promise.all(
    libraryEntries.map(async ({ name }) => {
      const relativePath = name.replace(/\.mjs$/u, ".d.ts");
      const destination = path.join(outDir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, "dist", relativePath), destination);
    }),
  );
}

async function snapshotShippedTree(destination) {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(path.join(root, "dist"), path.join(destination, "dist"), {
      recursive: true,
    }),
    cp(path.join(root, "bin"), path.join(destination, "bin"), {
      recursive: true,
    }),
  ]);
}

async function publishStage(stageRoot) {
  await Promise.all([
    rm(path.join(root, "dist"), { force: true, recursive: true }),
    rm(path.join(root, "bin"), { force: true, recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(stageRoot, "dist"), path.join(root, "dist"), {
      recursive: true,
    }),
    cp(path.join(stageRoot, "bin"), path.join(root, "bin"), {
      recursive: true,
    }),
  ]);
}

async function assertTreesEqual(leftRoot, rightRoot) {
  const leftFiles = (
    await Promise.all(
      ["bin", "dist"].map((directory) =>
        listRegularFiles(path.join(leftRoot, directory)),
      ),
    )
  ).flat();
  const rightFiles = (
    await Promise.all(
      ["bin", "dist"].map((directory) =>
        listRegularFiles(path.join(rightRoot, directory)),
      ),
    )
  ).flat();
  const leftNames = leftFiles.map((file) => path.relative(leftRoot, file));
  const rightNames = rightFiles.map((file) => path.relative(rightRoot, file));
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
    throw new Error(
      `Self-build fixpoint file set differs:\n${JSON.stringify({ leftNames, rightNames }, null, 2)}`,
    );
  }
  for (const relativePath of leftNames) {
    const [left, right] = await Promise.all([
      readFile(path.join(leftRoot, relativePath)),
      readFile(path.join(rightRoot, relativePath)),
    ]);
    if (!left.equals(right)) {
      throw new Error(`Self-build fixpoint differs at ${relativePath}`);
    }
  }
}

async function listRegularFiles(directory, excludedNames = []) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(entryPath, excludedNames)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else if (entry.isSymbolicLink()) {
      const stats = await lstat(entryPath);
      if (stats.isFile()) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function printSizeReport(stage0, stage1) {
  const stage0Entries = await shippedJavaScriptEntries(stage0);
  const stage1Entries = await shippedJavaScriptEntries(stage1);
  const names = [...new Set([...stage0Entries, ...stage1Entries])].sort();
  // Raw is parse/compile CPU; gzip -9 is transfer. On the trial app they
  // disagree in sign (+4.0% gzip / -3.3% raw), so a raw-only win is not a
  // wire win.
  console.log(
    "Self-build size report (raw = parse/compile CPU bytes; gzip -9 = transfer bytes):",
  );
  for (const relativePath of names) {
    const before = await sizes(path.join(stage0, relativePath));
    const after = await sizes(path.join(stage1, relativePath));
    console.log(
      `${relativePath}: raw ${before.raw} / gzip ${before.gzip} -> raw ${after.raw} / gzip ${after.gzip}`,
    );
  }
}

async function shippedJavaScriptEntries(stageRoot) {
  const files = await listRegularFiles(stageRoot);
  return files
    .map((file) => path.relative(stageRoot, file).replace(/\\/gu, "/"))
    .filter((file) => file.endsWith(".mjs"));
}

async function sizes(filePath) {
  try {
    const content = await readFile(filePath);
    return { gzip: (await gzipAsync(content, { level: 9 })).length, raw: content.length };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { gzip: 0, raw: 0 };
    }
    throw error;
  }
}

async function assertCliShebang(filePath) {
  const contents = await readFile(filePath, "utf8");
  if (!contents.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Self-built CLI is missing its first-line Node shebang.");
  }
}
