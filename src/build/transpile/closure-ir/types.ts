import type ts from "@typescript/typescript6";

import type { ClosureIrScanResult } from "./metadata/scan";

export interface ClosureTypeMetadataFile {
  /** Environment globals from ambient `.d.ts` files; routed to externs. */
  ambientGlobals?: string[] | undefined;
  annotations: ClosureAnnotation[];
  declarations: ClosureTypeDeclaration[];
  decoratedOutputText: string | undefined;
  diagnostics: TypeMetadataDiagnostic[];
  enums: ClosureEnumDeclaration[];
  /** Const enums TypeScript erases; the declaration is dropped, nothing emitted. */
  erasedConstEnums?: string[] | undefined;
  filePath: string;
  runtimeModuleId?: string | undefined;
  sourceFilePath: string;
  symbols: ClosureTypeSymbol[];
}

export interface ClosureAnnotation {
  references: ClosureTypeReference[];
  target:
    | { bindingName: string; kind: "binding" }
    | {
        kind: "member";
        memberKind: "constructor" | "field" | "getter" | "method" | "setter";
        memberName: string;
        ownerBindingName: string;
        static: boolean;
      };
  template: string;
  typeBearing: boolean;
}

export interface ClosureTypeReference {
  symbolId: string;
  token: string;
}

export interface ClosureTypeSymbol {
  builtinName?: string | undefined;
  declarationFilePath?: string | undefined;
  declarationId?: string | undefined;
  declarationStart?: number | undefined;
  diagnosticName: string;
  id: string;
  kind: "builtin" | "declared" | "runtime";
  localName?: string | undefined;
}

export interface ClosureTypeDeclaration {
  declaredSymbolId: string;
  exported: boolean;
  id: string;
  references: ClosureTypeReference[];
  template: string;
}

export interface ClosureEnumDeclaration {
  bindingName: string;
  exported: boolean;
  members: Array<{
    name: string;
    value: boolean | number | string;
  }>;
  symbolId: string;
  valueType: "boolean" | "number" | "string";
}

export interface TypeMetadataDiagnostic {
  declarationFilePath?: string | undefined;
  phase: "analysis";
  reason:
    | "ambient-nominal-without-binding"
    | "type-reference-depth-exceeded"
    | "unsupported-type-atom";
  sourceFilePath: string;
  symbolId?: string | undefined;
  symbolName?: string | undefined;
  target?: string | undefined;
}

export interface TypeMetadataCounts {
  annotationCount: number;
  enumDeclarationCount: number;
  memberAnnotationCount: number;
  /**
   * Explicit `interface`/`type` declarations lowered to `@record`/`@typedef`.
   * Structural shapes are never synthesized, so this only ever counts
   * declarations the source actually wrote.
   */
  typeDeclarationCount: number;
  unresolvedTypeReferenceCount: number;
}

export interface TypeMetadataTarget {
  emitFilePath: string;
  runtimeModuleId?: string | undefined;
  sourceFilePath: string;
}

export function countTypeMetadata(
  files: readonly ClosureTypeMetadataFile[],
): TypeMetadataCounts {
  return files.reduce<TypeMetadataCounts>(
    (counts, file) => {
      counts.annotationCount += file.annotations.filter(
        (annotation) =>
          annotation.target.kind === "binding" && annotation.typeBearing,
      ).length;
      counts.memberAnnotationCount += file.annotations.filter(
        (annotation) =>
          annotation.target.kind === "member" && annotation.typeBearing,
      ).length;
      counts.typeDeclarationCount += file.declarations.length;
      counts.enumDeclarationCount += file.enums.length;
      counts.unresolvedTypeReferenceCount += file.diagnostics.length;
      return counts;
    },
    {
      annotationCount: 0,
      enumDeclarationCount: 0,
      memberAnnotationCount: 0,
      typeDeclarationCount: 0,
      unresolvedTypeReferenceCount: 0,
    },
  );
}

export interface NativeTypeAnalysisResult {
  diagnostics: ts.Diagnostic[];
  extractedCounts: TypeMetadataCounts;
  files: ClosureTypeMetadataFile[];
  scan: ClosureIrScanResult;
  typeMetadataDiagnostics: TypeMetadataDiagnostic[];
}
