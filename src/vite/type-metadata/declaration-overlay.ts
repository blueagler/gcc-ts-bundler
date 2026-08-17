import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { collectDeclarationExportGraph } from "./export-graphs";
import type {
  DeclarationOverlayResult,
  ResolutionMode,
  RuntimeResolutionIdentity,
  TypeMetadataDiagnostic,
} from "./types";

const DECLARATION_EXTENSION = /\.d\.(?:cts|mts|ts)$/u;

export async function resolveDeclarationOverlay(input: {
  compilerOptions?: ts.CompilerOptions;
  containingFilePath?: string;
  resolution: RuntimeResolutionIdentity;
  resolutionMode: ResolutionMode;
}): Promise<DeclarationOverlayResult> {
  const { resolution } = input;
  const diagnostics: TypeMetadataDiagnostic[] = [];
  const specifier = publicPackageSpecifier(resolution);
  if (!specifier || !resolution.packageRoot) {
    return unresolved(resolution.runtimeModuleId);
  }

  const containingFilePath =
    input.containingFilePath ??
    path.join(
      findProjectRoot(resolution.packageRoot),
      input.resolutionMode === "import"
        ? "__gcc_type_overlay__.mts"
        : "__gcc_type_overlay__.cts",
    );
  const customConditions = [
    ...new Set([
      ...(input.compilerOptions?.customConditions ?? []),
      ...resolution.conditions.filter(
        (condition) =>
          !["default", "import", "node", "require", "types"].includes(
            condition,
          ),
      ),
    ]),
  ];
  const compilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    ...input.compilerOptions,
    customConditions,
  } satisfies ts.CompilerOptions;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFilePath,
    compilerOptions,
    ts.sys,
    undefined,
    undefined,
    input.resolutionMode === "import"
      ? ts.ModuleKind.ESNext
      : ts.ModuleKind.CommonJS,
  ).resolvedModule;
  const declarationEntryPath = resolved?.resolvedFileName;
  if (
    !declarationEntryPath ||
    !DECLARATION_EXTENSION.test(declarationEntryPath)
  ) {
    return unresolved(resolution.runtimeModuleId);
  }

  const declarationPackageRoot =
    await resolveDeclarationPackageRoot(declarationEntryPath);
  if (
    declarationPackageRoot &&
    !isSamePackageOrTypesPackage(
      resolution.packageRoot,
      declarationPackageRoot,
      resolution.packageName,
    )
  ) {
    diagnostics.push({
      detail: declarationEntryPath,
      reason: "declaration-resolution-escaped-package",
      runtimeModuleId: resolution.runtimeModuleId,
    });
    return { cacheFiles: [], diagnostics, exports: [] };
  }

  const program = ts.createProgram([declarationEntryPath], compilerOptions);
  const cacheFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        DECLARATION_EXTENSION.test(sourceFile.fileName) &&
        !program.isSourceFileDefaultLibrary(sourceFile),
    )
    .map((sourceFile) => path.normalize(sourceFile.fileName))
    .sort((left, right) => left.localeCompare(right));
  if (resolution.packageJsonPath) {
    cacheFiles.push(path.normalize(resolution.packageJsonPath));
  }
  const declarationPackageJson = declarationPackageRoot
    ? path.join(declarationPackageRoot, "package.json")
    : undefined;
  if (
    declarationPackageJson &&
    declarationPackageJson !== resolution.packageJsonPath &&
    (await fileExists(declarationPackageJson))
  ) {
    cacheFiles.push(path.normalize(declarationPackageJson));
  }

  return {
    cacheFiles: [...new Set(cacheFiles)].sort(),
    diagnostics,
    exports: collectDeclarationExportGraph(program, declarationEntryPath),
    identity: {
      declarationEntryPath: path.normalize(declarationEntryPath),
    },
  };
}

function unresolved(runtimeModuleId: string): DeclarationOverlayResult {
  return {
    cacheFiles: [],
    diagnostics: [
      { reason: "declaration-unresolved", runtimeModuleId },
    ] satisfies TypeMetadataDiagnostic[],
    exports: [],
  };
}

function publicPackageSpecifier(resolution: RuntimeResolutionIdentity) {
  if (!resolution.packageName) {
    return null;
  }
  const subpath = resolution.packageSubpath;
  return !subpath || subpath === "."
    ? resolution.packageName
    : `${resolution.packageName}/${subpath.replace(/^\.\//u, "")}`;
}

function findProjectRoot(packageRoot: string) {
  let current = path.resolve(packageRoot);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === "node_modules") {
      return path.dirname(current);
    }
    current = path.dirname(current);
  }
  return path.dirname(packageRoot);
}

async function resolveDeclarationPackageRoot(filePath: string) {
  let current = path.dirname(filePath);
  while (path.dirname(current) !== current) {
    if (await fileExists(path.join(current, "package.json"))) {
      return path.normalize(current);
    }
    current = path.dirname(current);
  }
  return undefined;
}

function isSamePackageOrTypesPackage(
  runtimePackageRoot: string,
  declarationPackageRoot: string,
  packageName?: string,
) {
  if (
    path.normalize(runtimePackageRoot) ===
    path.normalize(declarationPackageRoot)
  ) {
    return true;
  }
  if (!packageName) {
    return false;
  }
  const typesName = packageName.startsWith("@")
    ? packageName.slice(1).replace("/", "__")
    : packageName;
  return (
    path.basename(path.dirname(declarationPackageRoot)) === "@types" &&
    path.basename(declarationPackageRoot) === typesName
  );
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
