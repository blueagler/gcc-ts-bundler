import type {
  ClosureTypeMetadataFile,
  TypeMetadataCounts,
  TypeMetadataDiagnostic as ClosureTypeMetadataDiagnostic,
} from "../../build/transpile/closure-ir";

export const VITE_TYPE_METADATA_VERSION = 3 as const;

export type ResolutionMode = "import" | "require";

export interface RuntimeResolutionIdentity {
  importerModuleId: string;
  conditions: string[];
  format: "cjs" | "esm";
  packageJsonPath?: string | undefined;
  packageName?: string | undefined;
  packageRoot?: string | undefined;
  packageSubpath?: string | undefined;
  runtimeModuleId: string;
  resolutionMode: ResolutionMode;
  runtimePath: string;
  selectedRuntimeTarget?: string | undefined;
  specifier: string;
}

export interface DeclarationOverlayIdentity {
  declarationEntryPath: string;
  declarationPackageRoot?: string | undefined;
  declarationSubpath: string;
  resolutionMode: ResolutionMode;
  runtimeModuleId: string;
}

export interface TypeMetadataDiagnostic {
  detail?: string | undefined;
  exportName?: string | undefined;
  reason:
    | "ambiguous-runtime-export"
    | "declaration-resolution-escaped-package"
    | "declaration-runtime-export-mismatch"
    | "declaration-unresolved"
    | "runtime-reexport-unresolved";
  runtimeModuleId: string;
}

export interface DeclarationExportFact {
  declarationFilePath: string;
  declarationId: string;
  declarationName: string;
  declarationStart: number;
  exportName: string;
  hasRuntimeValue: boolean;
  isTypeOnly: boolean;
  symbolId: string;
}

export interface RuntimeExportTarget {
  exportName: string;
  kind: "cjs" | "local";
  localName?: string | undefined;
  moduleId: string;
}

export interface RuntimeExportFact {
  exportName?: string | undefined;
  importedName?: string | undefined;
  kind: "cjs" | "local" | "reexport" | "star";
  localName?: string | undefined;
  targetSpecifier?: string | undefined;
}

export interface JoinedExportTypeFact {
  declaration: DeclarationExportFact;
  exportName: string;
  runtime: RuntimeExportTarget;
  runtimeModuleId: string;
}

export interface PrebundleExportFacade {
  facadeId: string;
  originExportName: string;
  originModuleId: string;
  outputExportName: string;
  outputLocalName?: string | undefined;
}

export interface PrebundleBindingMap {
  exports: PrebundleExportFacade[];
  outputModuleId: string;
}

export interface SourceToRuntimeMapping {
  materializedFilePath: string;
  runtimeModuleId: string;
  sourceModuleId: string;
}

export interface RuntimeModuleTypeProvenance {
  cacheKey: string;
  exportFacades: PrebundleExportFacade[];
  kind: "fused" | "one-to-one";
  sourceMappings: SourceToRuntimeMapping[];
}

export interface DeclarationOverlayResult {
  cacheFiles: string[];
  diagnostics: TypeMetadataDiagnostic[];
  exports: DeclarationExportFact[];
  identity?: DeclarationOverlayIdentity;
}

export interface ViteTypeMetadataSelectionDiagnostic {
  detail?: string | undefined;
  exportName?: string | undefined;
  phase: "selection";
  reason:
    | "analysis-config-invalid"
    | "analysis-config-unavailable"
    | "declaration-export-metadata-unavailable"
    | "fused-export-unproven"
    | "query-module-omitted"
    | "runtime-resolution-unavailable"
    | "source-file-unreadable"
    | "source-runtime-binding-mismatch"
    | "virtual-module-omitted";
  runtimeModuleId?: string | undefined;
  sourceFilePath?: string | undefined;
}

export interface ViteTypeScriptDiagnostic {
  category: "error" | "message" | "suggestion" | "warning";
  code: number;
  filePath?: string | undefined;
  length?: number | undefined;
  message: string;
  phase: "typescript";
  start?: number | undefined;
}

export type ViteTypeMetadataDiagnostic =
  | ClosureTypeMetadataDiagnostic
  | TypeMetadataDiagnostic
  | ViteTypeMetadataSelectionDiagnostic
  | ViteTypeScriptDiagnostic;

export interface ViteTypeMetadataAttachment {
  declarationId?: string | undefined;
  exportName?: string | undefined;
  facadeId?: string | undefined;
  kind: "declaration-overlay" | "source";
  originExportName?: string | undefined;
  originRuntimeModuleId?: string | undefined;
  outputBindingName?: string | undefined;
  runtimeModuleId: string;
  sourceFilePath: string;
}

export interface ViteTypeMetadataProvenance {
  attachments: ViteTypeMetadataAttachment[];
  moduleCacheKeys: Array<{ cacheKey: string; runtimeModuleId: string }>;
  resolutions: RuntimeResolutionIdentity[];
}

export interface ViteTypeMetadataSidecar {
  cacheKey: string;
  dependencies: string[];
  diagnostics: ViteTypeMetadataDiagnostic[];
  extractedCounts: TypeMetadataCounts;
  files: ClosureTypeMetadataFile[];
  provenance: ViteTypeMetadataProvenance;
  version: typeof VITE_TYPE_METADATA_VERSION;
}
