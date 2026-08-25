import path from "path";
import ts from "@typescript/typescript6";

import type { DiagnosticsPreflight } from "../../../../api/types";
import { collectFileContentSnapshot } from "../../../../shared/file-state";
import { logInternalDetail } from "../../../../shared/timing";
import type { BuildTypeMetadataSidecar } from "../../../types";
import { collectFileStates } from "../../../../native/load";
import type { NativeEmittedTypeMetadata } from "../../../../native/load";
import type {
  ClosureTypeMetadataFile,
  TypeMetadataCounts,
} from "../../type-metadata";

export function analysisFromSidecar(
  sidecar: BuildTypeMetadataSidecar,
  srcDir: string,
  workspaceDir: string,
) {
  const diagnostics: ts.Diagnostic[] = [];
  const preflightDiagnostics: ts.Diagnostic[] = [];
  return {
    dependencies: sidecar.dependencies,
    diagnostics,
    extractedCounts: sidecar.extractedCounts,
    files: sidecar.files.map((file) =>
      toNativeTypeMetadataFile({
        // Spelled out rather than rest-spread: these keys reach the native addon,
        // and only a literal written against the boundary type keeps its property
        // names through the self-build's renaming.
        ambientGlobals: file.ambientGlobals,
        annotations: file.annotations,
        declarations: file.declarations,
        decoratedOutputText: file.decoratedOutputText,
        diagnostics: file.diagnostics,
        enums: file.enums,
        externalGlobalMemberAccesses: file.externalGlobalMemberAccesses,
        externalOwnedMemberAccesses: file.externalOwnedMemberAccesses,
        filePath: remapMetadataFilePath(file.filePath, srcDir, workspaceDir),
        sourceFilePath: file.sourceFilePath,
        symbols: file.symbols,
      }),
    ),
    preflightDiagnostics,
    typeMetadataDiagnostics: sidecar.diagnostics,
  };
}

function remapMetadataFilePath(
  filePath: string,
  srcDir: string,
  workspaceDir: string,
) {
  const relativePath = path.relative(srcDir, filePath);
  return relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
    ? path.join(workspaceDir, "src", relativePath)
    : filePath;
}

export async function collectExistingContentSnapshot(filePaths: string[]) {
  const existing = collectFileStates(filePaths)
    .filter((state) => state.exists)
    .map((state) => state.filePath);
  return collectFileContentSnapshot(existing);
}

export function logTypeMetadataCounts(
  label: string,
  counts: TypeMetadataCounts,
  diagnostics: number,
) {
  logInternalDetail(
    label,
    `annotations=${counts.annotationCount} members=${counts.memberAnnotationCount} declarations=${counts.typeDeclarationCount} enums=${counts.enumDeclarationCount} unresolved=${counts.unresolvedTypeReferenceCount} diagnostics=${diagnostics}`,
  );
}

export function logDeliveredTypeMetadata(
  metadata: NativeEmittedTypeMetadata[],
) {
  const counts: TypeMetadataCounts = {
    annotationCount: 0,
    enumDeclarationCount: 0,
    memberAnnotationCount: 0,
    typeDeclarationCount: 0,
    unresolvedTypeReferenceCount: 0,
  };
  let diagnostics = 0;
  for (const file of metadata) {
    counts.annotationCount += file.counts.annotationCount;
    counts.enumDeclarationCount += file.counts.enumDeclarationCount;
    counts.memberAnnotationCount += file.counts.memberAnnotationCount;
    counts.typeDeclarationCount += file.counts.typeDeclarationCount;
    counts.unresolvedTypeReferenceCount +=
      file.counts.unresolvedTypeReferenceCount;
    diagnostics += file.diagnostics.length;
  }
  logTypeMetadataCounts(
    "native-emit:type-metadata-delivered",
    counts,
    diagnostics,
  );
}

export async function getMissingInputDiagnostics({
  externFileNames,
  fileNames,
  preflight,
  tsConfigPath,
}: {
  externFileNames: string[];
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
}): Promise<ts.Diagnostic[]> {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([
    tsConfigPath,
    ...fileNames,
    ...externFileNames,
  ]);
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

export function toNativeTypeMetadataFile(
  file: ClosureTypeMetadataFile,
): ClosureTypeMetadataFile {
  // Spelled out rather than rest-spread: these keys reach the native addon,
  // and only a literal written against the boundary type keeps its property
  // names through the self-build's renaming.
  return {
    ambientGlobals: file.ambientGlobals,
    annotations: file.annotations,
    declarations: file.declarations,
    decoratedOutputText: file.decoratedOutputText,
    diagnostics: file.diagnostics,
    enums: file.enums,
    externalGlobalMemberAccesses: file.externalGlobalMemberAccesses,
    externalOwnedMemberAccesses: file.externalOwnedMemberAccesses,
    filePath: file.filePath,
    sourceFilePath: file.sourceFilePath,
    symbols: file.symbols,
  };
}
