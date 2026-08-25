import path from "node:path";

import ts from "@typescript/typescript6";

import { collectExternalGlobalProtocolEvidence } from "../../../build/transpile/type-metadata/metadata/external-ownership/index";
import { loadPlatformExternArchive } from "../../../build/closure/platform-externs/archive";
import { getPlatformExternIndex } from "../../../build/closure/platform-externs/index";
import { windowGlobalPropertyAliases } from "../../../build/closure/platform-externs/seeds";
import { getDefaultPersistentCacheRoot } from "../../../shared/cache-store";
import type { ClosureTypeMetadataFile } from "../../../build/transpile/type-metadata";
import type { MaterializedGraph } from "../../internal-types";
import type { ViteTypeScriptDiagnostic } from "../types";

export async function collectMaterializedExternalGlobalProtocol(
  materialized: MaterializedGraph,
): Promise<{
  filePaths: string[];
  files: ClosureTypeMetadataFile[];
}> {
  const modulesByFile = new Map(
    materialized.modules.map((module) => [
      path.normalize(module.filePath),
      module,
    ]),
  );
  const filePaths = [...modulesByFile.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  if (filePaths.length === 0) {
    return {
      filePaths,
      files: [],
    };
  }
  const program = ts.createProgram(filePaths, {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const sourceFiles = filePaths
    .map((filePath) => program.getSourceFile(filePath))
    .filter(
      (sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined,
    );
  const cacheRoot = getDefaultPersistentCacheRoot();
  const archive = await loadPlatformExternArchive({ cacheRoot });
  const platformIndex = archive
    ? await getPlatformExternIndex(archive, { cacheRoot })
    : null;
  const evidence = collectExternalGlobalProtocolEvidence({
    checker: program.getTypeChecker(),
    platformGlobalNames: platformIndex?.globalNames,
    platformGlobalPropertyAliases: platformIndex
      ? windowGlobalPropertyAliases(platformIndex)
      : undefined,
    platformPropertyNames: platformIndex?.propertyNames,
    program,
    sourceFiles,
  });
  const files = filePaths.flatMap((filePath) => {
    const offsets = evidence.memberAccessesByFile.get(filePath) ?? [];
    const module = modulesByFile.get(filePath);
    const ambientGlobals =
      filePath === filePaths[0] ? evidence.externalGlobals : [];
    if ((offsets.length === 0 && ambientGlobals.length === 0) || !module) {
      return [];
    }
    return [
      {
        ambientGlobals: [...ambientGlobals],
        annotations: [],
        declarations: [],
        decoratedOutputText: undefined,
        diagnostics: [],
        enums: [],
        externalGlobalMemberAccesses: [...offsets],
        externalOwnedMemberAccesses: [],
        filePath,
        runtimeModuleId: module.id,
        sourceFilePath: filePath,
        symbols: [],
      } satisfies ClosureTypeMetadataFile,
    ];
  });
  if (evidence.rootProperties.length > 0) {
    console.warn(
      `gcc-ts-bundler: preserved ${evidence.rootProperties.length} external global root ${evidence.rootProperties.length === 1 ? "property" : "properties"} and ${evidence.memberProperties.length} opaque nested ${evidence.memberProperties.length === 1 ? "member" : "members"}.`,
    );
  }
  return { filePaths, files };
}

export function serializeTypeScriptDiagnostic(
  diagnostic: ts.Diagnostic,
): ViteTypeScriptDiagnostic {
  return {
    category: diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    filePath: diagnostic.file?.fileName,
    length: diagnostic.length,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    phase: "typescript",
    start: diagnostic.start,
  };
}

function diagnosticCategory(category: ts.DiagnosticCategory) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error" as const;
    case ts.DiagnosticCategory.Message:
      return "message" as const;
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion" as const;
    case ts.DiagnosticCategory.Warning:
      return "warning" as const;
  }
}
