import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import ts from "@typescript/typescript6";

import { collectDeclarationExportGraph } from "../export-graphs";
import type {
  DeclarationOverlayResult,
  ResolutionMode,
  RuntimeResolutionIdentity,
  TypeMetadataDiagnostic,
} from "../types";

const DECLARATION_EXTENSION = /\.d\.(?:cts|mts|ts)$/u;

export async function resolveDeclarationOverlays(
  inputs: readonly {
    compilerOptions?: ts.CompilerOptions;
    containingFilePath?: string;
    resolution: RuntimeResolutionIdentity;
    resolutionMode: ResolutionMode;
  }[],
): Promise<DeclarationOverlayResult[]> {
  const results: DeclarationOverlayResult[] = [];
  const groups: {
    compilerOptions: ts.CompilerOptions;
    projectRoot: string;
    resolutionMode: ResolutionMode;
    entries: {
      result: DeclarationOverlayResult;
      declarationEntryPath: string;
    }[];
  }[] = [];

  for (const input of inputs) {
    const { resolution } = input;
    const result = unresolved(resolution.runtimeModuleId);
    results.push(result);
    const specifier = publicPackageSpecifier(resolution);
    if (!specifier || !resolution.packageRoot) {
      continue;
    }

    const projectRoot = findProjectRoot(resolution.packageRoot);
    const containingFilePath =
      input.containingFilePath ??
      path.join(
        projectRoot,
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
      continue;
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
      result.diagnostics = [
        {
          detail: declarationEntryPath,
          reason: "declaration-resolution-escaped-package",
          runtimeModuleId: resolution.runtimeModuleId,
        },
      ];
      continue;
    }

    result.diagnostics = [];
    result.identity = {
      declarationEntryPath: path.normalize(declarationEntryPath),
    };
    if (resolution.packageJsonPath) {
      result.cacheFiles.push(path.normalize(resolution.packageJsonPath));
    }
    const declarationPackageJson = declarationPackageRoot
      ? path.join(declarationPackageRoot, "package.json")
      : undefined;
    if (
      declarationPackageJson &&
      declarationPackageJson !== resolution.packageJsonPath &&
      (await fileExists(declarationPackageJson))
    ) {
      result.cacheFiles.push(path.normalize(declarationPackageJson));
    }

    let group = groups.find(
      (candidate) =>
        candidate.projectRoot === projectRoot &&
        candidate.resolutionMode === input.resolutionMode &&
        isDeepStrictEqual(candidate.compilerOptions, compilerOptions),
    );
    if (!group) {
      group = {
        compilerOptions,
        projectRoot,
        resolutionMode: input.resolutionMode,
        entries: [],
      };
      groups.push(group);
    }
    group.entries.push({ result, declarationEntryPath });
  }

  for (const group of groups) {
    // Even isolated augmentation graphs share parsing, never checker state.
    // This host and its source files live only for this compatible batch.
    const host = ts.createCompilerHost(group.compilerOptions);
    const getSourceFile = host.getSourceFile;
    const sourceFiles = new Map<string, ts.SourceFile | undefined>();
    host.getSourceFile = (fileName, languageVersion, onError) => {
      if (!sourceFiles.has(fileName)) {
        sourceFiles.set(
          fileName,
          getSourceFile(fileName, languageVersion, onError),
        );
      }
      return sourceFiles.get(fileName);
    };
    const program = ts.createProgram(
      group.entries.map((entry) => entry.declarationEntryPath),
      group.compilerOptions,
      host,
    );
    // A second root can introduce globals or augment another module. Do not
    // let those declarations become visible to an unrelated entry's checker.
    // Default libraries are already shared by every entry under these options.
    const isolate =
      group.entries.length > 1 &&
      program
        .getSourceFiles()
        .some(
          (sourceFile) =>
            !program.isSourceFileDefaultLibrary(sourceFile) &&
            (!ts.isExternalModule(sourceFile) || hasAugmentation(sourceFile)),
        );
    let cacheFiles: string[] | undefined;
    for (const entry of group.entries) {
      const entryProgram = isolate
        ? ts.createProgram(
            [entry.declarationEntryPath],
            group.compilerOptions,
            host,
          )
        : program;
      if (isolate || !cacheFiles) {
        cacheFiles = entryProgram
          .getSourceFiles()
          .filter(
            (sourceFile) =>
              DECLARATION_EXTENSION.test(sourceFile.fileName) &&
              !entryProgram.isSourceFileDefaultLibrary(sourceFile),
          )
          .map((sourceFile) => path.normalize(sourceFile.fileName));
      }
      const { result } = entry;
      // Shared groups deliberately retain the union of declaration dependencies:
      // the collection invalidates as a unit, including transitive declarations.
      result.cacheFiles = [
        ...new Set([...result.cacheFiles, ...cacheFiles]),
      ].sort();
      result.exports = collectDeclarationExportGraph(
        entryProgram,
        entry.declarationEntryPath,
      );
    }
  }

  return results;
}

function hasAugmentation(node: ts.Node): boolean {
  return (
    (ts.isModuleDeclaration(node) &&
      (ts.isStringLiteral(node.name) ||
        (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0)) ||
    (ts.forEachChild(node, hasAugmentation) ?? false)
  );
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
