import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { createBundleRequire } from "../../internal/bundle-location";
import { filesExist } from "../../internal/file-state";
import { collectFileStates } from "../../native/load";
import {
  LazyImport,
  NormalizedBuildOptions,
  PackageAlias,
} from "../../internal/types";
import { resolveGraph } from "../../native/load";
import { transpileSources } from "../../native/load";
import { loadCompilerOptions } from "./compiler-options";
import { collectNativeTypeAnalysis } from "./closure-ir";

const require = createBundleRequire();

export interface NativeEmitStageResult {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
  supportFiles: string[];
}

interface NativeEmitMetadata {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  supportFiles: string[];
  version: number;
}

const NATIVE_EMIT_METADATA_VERSION = 7;

export async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  fileNames: string[];
  lazyImports: LazyImport[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const usesPersistentCache = options.cache.mode === "persistent";
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "native-generated.externs.js");
  const metadataPathForNative = path.join(cacheDir, "closure-ir.json");
  const runtimePackageInputs = await collectTsxRuntimePackageInputs({
    fileNames,
    tsConfigPath,
    workspaceDir,
  });
  const runtimeSupportFiles = runtimePackageInputs.sourceFiles.map((fileName) =>
    toEmittedPath(fileName, outDir, workspaceDir),
  );
  const combinedFileNames = uniqueSorted([
    ...fileNames,
    ...runtimePackageInputs.sourceFiles,
  ]);
  const combinedPackageAliases = mergePackageAliases([
    ...packageAliases,
    ...runtimePackageInputs.packageAliases,
  ]);
  const combinedPackageJsonFiles = uniqueSorted([
    ...packageJsonFiles,
    ...runtimePackageInputs.packageJsonFiles,
  ]);
  const dependencyModules = collectDependencyModules(combinedPackageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir,
    sourceFiles: combinedFileNames,
    workspaceDir,
  });
  const cachedMetadata = usesPersistentCache
    ? await readMetadata(metadataPath)
    : null;
  if (
    cachedMetadata &&
    (await filesExist([
      cachedMetadata.externsPath,
      cachedMetadata.metadataPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
    ]))
  ) {
    return {
      dependencyModules: cachedMetadata.dependencyModules,
      dependencyRuntimeFiles: cachedMetadata.dependencyRuntimeFiles,
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles,
    };
  }

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const missingInputDiagnostics = await getMissingInputDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }

  const analysis = await collectNativeTypeAnalysis({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir,
  });
  if (analysis.diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysis.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }
  await fs.promises.writeFile(
    metadataPathForNative,
    JSON.stringify(analysis.files, null, 2),
    "utf-8",
  );
  const result = transpileSources({
    chunkMode: options.chunks.mode,
    metadataPath: metadataPathForNative,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir,
  });
  const finalSupportFiles = uniqueSorted([
    ...runtimeSupportFiles,
    ...result.supportFiles,
  ]);

  if (usesPersistentCache) {
    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify(
        {
          dependencyModules,
          dependencyRuntimeFiles,
          emittedFiles: result.emittedFiles,
          externsPath: result.externsPath,
          metadataPath: metadataPathForNative,
          supportFiles: finalSupportFiles,
          version: NATIVE_EMIT_METADATA_VERSION,
        } satisfies NativeEmitMetadata,
        null,
        2,
      ),
      "utf-8",
    );
  }

  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles,
  };
}

async function collectTsxRuntimePackageInputs({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return {
      packageAliases: [] as PackageAlias[],
      packageJsonFiles: [] as string[],
      sourceFiles: [] as string[],
    };
  }

  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return {
      packageAliases: [] as PackageAlias[],
      packageJsonFiles: [] as string[],
      sourceFiles: [] as string[],
    };
  }

  const resolvedEntry = require.resolve(runtimeSpecifier, {
    paths: [workspaceDir],
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(
    resolvedEntry,
    workspaceDir,
  );
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: path.join(workspaceDir, "src"),
    workspaceDir,
  });

  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases,
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles,
  };
}

async function getMissingInputDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
}): Promise<ts.Diagnostic[]> {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates
    .filter((state) => !state.exists)
    .map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(
        `Missing required build input(s): ${missingFiles.join(", ")}`,
      ),
    ];
  }

  return [];
}

function createSimpleDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined,
  };
}

function getJsxRuntimeSpecifier(compilerOptions: ts.CompilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case ts.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NativeEmitMetadata>;
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      dependencyModules: parsed.dependencyModules ?? [],
      dependencyRuntimeFiles: parsed.dependencyRuntimeFiles ?? [],
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      metadataPath: parsed.metadataPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function toEmittedPath(
  sourcePath: string,
  outDir: string,
  workspaceDir: string,
) {
  return path
    .join(outDir, path.relative(workspaceDir, sourcePath))
    .replace(/\.[^/.]+$/, ".js");
}

function collectDependencyModules(packageAliases: PackageAlias[]) {
  return uniqueSorted(
    packageAliases
      .filter((alias) => isDependencyFile(alias.targetPath))
      .map((alias) =>
        alias.subpath === "."
          ? alias.packageName
          : `${alias.packageName}/${alias.subpath.replace(/^\.\//, "")}`,
      ),
  );
}

function collectDependencyRuntimeFiles({
  outDir,
  sourceFiles,
  workspaceDir,
}: {
  outDir: string;
  sourceFiles: string[];
  workspaceDir: string;
}) {
  return uniqueSorted(
    sourceFiles
      .filter((filePath) => isDependencyFile(filePath))
      .map((filePath) => toEmittedPath(filePath, outDir, workspaceDir)),
  );
}

function isDependencyFile(filePath: string) {
  return path.resolve(filePath).includes(`${path.sep}node_modules${path.sep}`);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergePackageAliases(aliases: PackageAlias[]) {
  const merged = new Map<string, PackageAlias>();
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\0${alias.subpath}`, alias);
  }

  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\0${left.subpath}`;
    const rightKey = `${right.packageName}\0${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}

function toWorkspaceNodeModulesPath(
  resolvedPath: string,
  workspaceDir: string,
) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }

  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path.join(workspaceDir, relativeNodeModulesPath);
}

function toRuntimePackageAlias(
  specifier: string,
  targetPath: string,
): PackageAlias {
  const segments = specifier.startsWith("@")
    ? specifier.split("/", 3)
    : specifier.split("/", 2);
  const packageName = specifier.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const subpath = specifier.startsWith("@") ? segments[2] : segments[1];

  return {
    packageName,
    subpath: subpath ? `./${subpath}` : ".",
    targetPath,
  };
}
