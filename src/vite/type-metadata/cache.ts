import { createHash } from "node:crypto";
import path from "node:path";

import ts from "@typescript/typescript6";

import { DEFAULT_BUILD_OPTIONS } from "../../api/types";
import type {
  ClosureAnnotation,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
  ClosureTypeSymbol,
  TypeMetadataCounts,
  TypeMetadataDiagnostic as ClosureTypeMetadataDiagnostic,
} from "../../build/transpile/type-metadata";
import type { NativeFileStateEntry } from "../../native/load";
import {
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
} from "../../shared/cache-store";
import { hashFileInput } from "../../shared/files";
import {
  arrayOf,
  defineValues,
  isBoolean,
  isNumber,
  isObjectOf,
  isRecord,
  isString,
  isStringArray,
  isUnknownArray,
  oneOf,
  optional,
} from "../../shared/validation";
import type { MaterializedGraph } from "../internal-types";
import type { GccTsBundlerVitePluginOptions } from "../types";
import {
  VITE_TYPE_METADATA_VERSION,
  type TypeMetadataDiagnostic,
  type ViteTypeMetadataDiagnostic,
  type ViteTypeMetadataSelectionDiagnostic,
  type ViteTypeMetadataSidecar,
  type ViteTypeScriptDiagnostic,
} from "./types";

// Envelope shape of a persisted sidecar entry. `VITE_TYPE_METADATA_VERSION`
// already travels inside the entry's key, so this only tracks the envelope.
// v1: `{ dependencyStates, sidecar }`.
const VITE_TYPE_METADATA_SIDECAR_CACHE_VERSION = 1;

export function hashTypeMetadataValue<Value>(value: Value) {
  return createHash("sha256")
    .update(String(VITE_TYPE_METADATA_VERSION))
    .update("\0")
    .update(stableJson(value))
    .digest("hex");
}

/**
 * In-memory identity of the graphs `collectViteTypeMetadata` consumes.
 * On-disk invalidation is separate: the collector stores `collectFileStates`
 * of the previous sidecar's `dependencies` (program sources, tsconfig,
 * overlay `.d.ts` files) and re-checks them with `matchFileStates` on the
 * next call. That is what keeps a type-only edit or a declaration-overlay
 * rewrite from returning a stale sidecar when the graph object itself is
 * unchanged.
 */
export function hashTypeMetadataSidecarKey(input: {
  materialized: MaterializedGraph;
  projectRoot: string;
  sourceGraph: MaterializedGraph;
}) {
  return hashTypeMetadataValue({
    materialized: snapshotMaterializedGraph(input.materialized),
    projectRoot: input.projectRoot,
    sourceGraph: snapshotMaterializedGraph(input.sourceGraph),
  });
}

function snapshotMaterializedGraph(graph: MaterializedGraph) {
  return {
    authoredFiles: graph.authoredFiles,
    dependencySourceFileByMaterializedFile:
      graph.dependencySourceFileByMaterializedFile,
    entries: graph.entries,
    modules: graph.modules.map((module) => ({
      commonJsNamedExports: module.commonJsNamedExports,
      filePath: module.filePath,
      format: module.format,
      id: module.id,
      renderedLength: module.renderedLength,
      relativePath: module.relativePath,
      sourceModuleIds: module.sourceModuleIds,
      typeMetadata: module.typeMetadata,
    })),
    prunedEmptyModuleIds: graph.prunedEmptyModuleIds,
    retainedEmptyModuleIds: graph.retainedEmptyModuleIds,
    runtimeEntries: graph.runtimeEntries,
    runtimeResolutions: graph.runtimeResolutions,
    srcDir: graph.srcDir,
  };
}

function stableJson<Value>(value: Value): string {
  if (isUnknownArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const TYPE_METADATA_CACHE_SUBDIR = "vite-type-metadata";

export function resolveViteTypeMetadataCacheRoot(input: {
  captureRoot: string;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  const cacheMode =
    input.options.compiler?.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode;
  if (cacheMode === "persistent") {
    return path.join(
      getProjectCacheDir(
        path.resolve(
          input.options.compiler?.cache?.dir ?? getDefaultPersistentCacheRoot(),
        ),
        input.projectRoot,
      ),
      TYPE_METADATA_CACHE_SUBDIR,
    );
  }

  return path.join(input.captureRoot, TYPE_METADATA_CACHE_SUBDIR);
}

export async function hashTypeMetadataSidecarDiskKey(input: {
  projectRoot: string;
  sidecarKey: string;
}) {
  const tsconfigPath = ts.findConfigFile(
    input.projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  let tsconfigIdentity = "";
  if (tsconfigPath !== undefined) {
    try {
      tsconfigIdentity = await hashFileInput(tsconfigPath);
    } catch {
      tsconfigIdentity = "";
    }
  }
  return hashTypeMetadataValue({
    sidecarKey: input.sidecarKey,
    tsconfigIdentity,
    tsconfigPath: tsconfigPath ?? "",
  });
}

export async function readCachedViteTypeMetadataSidecar(input: {
  cacheRoot: string;
  key: string;
}): Promise<CachedViteTypeMetadataSidecar | undefined> {
  const cached = await readJsonIfExists(
    path.join(input.cacheRoot, `${input.key}.json`),
    isCachedViteTypeMetadataSidecar,
  );
  if (
    cached === null ||
    cached.version !== VITE_TYPE_METADATA_SIDECAR_CACHE_VERSION
  ) {
    return undefined;
  }
  return cached;
}

export async function writeCachedViteTypeMetadataSidecar(input: {
  cacheRoot: string;
  dependencyStates: NativeFileStateEntry[];
  key: string;
  sidecar: ViteTypeMetadataSidecar;
}) {
  await writeJson(path.join(input.cacheRoot, `${input.key}.json`), {
    dependencyStates: input.dependencyStates,
    sidecar: input.sidecar,
    version: VITE_TYPE_METADATA_SIDECAR_CACHE_VERSION,
  } satisfies CachedViteTypeMetadataSidecar);
}

interface CachedViteTypeMetadataSidecar {
  dependencyStates: NativeFileStateEntry[];
  sidecar: ViteTypeMetadataSidecar;
  version: number;
}

const isNativeFileStateEntry = isObjectOf<NativeFileStateEntry>({
  exists: isBoolean,
  filePath: isString,
  mtimeMs: isNumber,
  size: isNumber,
});

const isTypeMetadataCounts = isObjectOf<TypeMetadataCounts>({
  annotationCount: isNumber,
  enumDeclarationCount: isNumber,
  memberAnnotationCount: isNumber,
  typeDeclarationCount: isNumber,
  unresolvedTypeReferenceCount: isNumber,
});

const isClosureTypeReference = isObjectOf<{
  symbolId: string;
  token: string;
}>({
  symbolId: isString,
  token: isString,
});

const isBindingAnnotationTarget = isObjectOf<{
  bindingName: string;
  kind: "binding";
}>({
  bindingName: isString,
  kind: oneOf(defineValues("binding")),
});

const isMemberAnnotationTarget = isObjectOf<{
  kind: "member";
  memberKind: "constructor" | "field" | "getter" | "method" | "setter";
  memberName: string;
  ownerBindingName: string;
  static: boolean;
}>({
  kind: oneOf(defineValues("member")),
  memberKind: oneOf(
    defineValues("constructor", "field", "getter", "method", "setter"),
  ),
  memberName: isString,
  ownerBindingName: isString,
  static: isBoolean,
});

function isClosureAnnotationTarget<Value>(
  value: Value,
): value is Value & ClosureAnnotation["target"] {
  return isBindingAnnotationTarget(value) || isMemberAnnotationTarget(value);
}

const isClosureAnnotation = isObjectOf<ClosureAnnotation>({
  references: arrayOf(isClosureTypeReference),
  target: isClosureAnnotationTarget,
  template: isString,
  typeBearing: isBoolean,
});

const isClosureTypeDeclaration = isObjectOf<ClosureTypeDeclaration>({
  declaredSymbolId: isString,
  id: isString,
  references: arrayOf(isClosureTypeReference),
  template: isString,
});

function isEnumMemberValue<Value>(
  value: Value,
): value is Value & (boolean | number | string) {
  return isBoolean(value) || isNumber(value) || isString(value);
}

const isClosureEnumMember = isObjectOf<{
  name: string;
  value: boolean | number | string;
}>({
  name: isString,
  value: isEnumMemberValue,
});

const isClosureEnumDeclaration = isObjectOf<{
  bindingName: string;
  exported: boolean;
  members: Array<{
    name: string;
    value: boolean | number | string;
  }>;
  symbolId: string;
  valueType: "boolean" | "number" | "string";
}>({
  bindingName: isString,
  exported: isBoolean,
  members: arrayOf(isClosureEnumMember),
  symbolId: isString,
  valueType: oneOf(defineValues("boolean", "number", "string")),
});

const isClosureTypeSymbol = isObjectOf<ClosureTypeSymbol>({
  builtinName: optional(isString),
  declarationFilePath: optional(isString),
  diagnosticName: isString,
  id: isString,
  kind: oneOf(defineValues("builtin", "declared", "runtime")),
  localName: optional(isString),
});

const isClosureTypeMetadataDiagnostic =
  isObjectOf<ClosureTypeMetadataDiagnostic>({
    declarationFilePath: optional(isString),
    phase: oneOf(defineValues("analysis")),
    reason: oneOf(
      defineValues(
        "ambient-nominal-without-binding",
        "symbol-rendering-failed",
        "type-reference-depth-exceeded",
        "unsupported-type-atom",
      ),
    ),
    sourceFilePath: isString,
    symbolId: optional(isString),
    symbolName: optional(isString),
    target: optional(isString),
  });

const isClosureTypeMetadataFile = isObjectOf<ClosureTypeMetadataFile>({
  ambientGlobals: optional(isStringArray),
  annotations: arrayOf(isClosureAnnotation),
  declarations: arrayOf(isClosureTypeDeclaration),
  decoratedOutputText: optional(isString),
  diagnostics: arrayOf(isClosureTypeMetadataDiagnostic),
  enums: arrayOf(isClosureEnumDeclaration),
  externalGlobalMemberAccesses: optional(arrayOf(isNumber)),
  externalOwnedMemberAccesses: optional(arrayOf(isNumber)),
  filePath: isString,
  runtimeModuleId: optional(isString),
  sourceFilePath: isString,
  symbols: arrayOf(isClosureTypeSymbol),
});

const isOverlayTypeMetadataDiagnostic = isObjectOf<TypeMetadataDiagnostic>({
  detail: optional(isString),
  exportName: optional(isString),
  reason: oneOf(
    defineValues(
      "ambiguous-runtime-export",
      "declaration-resolution-escaped-package",
      "declaration-runtime-export-mismatch",
      "declaration-unresolved",
      "runtime-reexport-unresolved",
    ),
  ),
  runtimeModuleId: isString,
});

const isSelectionDiagnostic = isObjectOf<ViteTypeMetadataSelectionDiagnostic>({
  detail: optional(isString),
  exportName: optional(isString),
  phase: oneOf(defineValues("selection")),
  reason: oneOf(
    defineValues(
      "analysis-config-invalid",
      "analysis-config-unavailable",
      "declaration-export-metadata-unavailable",
      "fused-export-unproven",
      "query-module-omitted",
      "runtime-resolution-unavailable",
      "source-file-unreadable",
      "source-runtime-binding-mismatch",
      "virtual-module-omitted",
    ),
  ),
  runtimeModuleId: optional(isString),
  sourceFilePath: optional(isString),
});

const isTypeScriptDiagnostic = isObjectOf<ViteTypeScriptDiagnostic>({
  category: oneOf(defineValues("error", "message", "suggestion", "warning")),
  code: isNumber,
  filePath: optional(isString),
  length: optional(isNumber),
  message: isString,
  phase: oneOf(defineValues("typescript")),
  start: optional(isNumber),
});

function isViteTypeMetadataDiagnostic<Value>(
  value: Value,
): value is Value & ViteTypeMetadataDiagnostic {
  return (
    isClosureTypeMetadataDiagnostic(value) ||
    isOverlayTypeMetadataDiagnostic(value) ||
    isSelectionDiagnostic(value) ||
    isTypeScriptDiagnostic(value)
  );
}

const isViteTypeMetadataSidecar = isObjectOf<ViteTypeMetadataSidecar>({
  dependencies: isStringArray,
  diagnostics: arrayOf(isViteTypeMetadataDiagnostic),
  extractedCounts: isTypeMetadataCounts,
  files: arrayOf(isClosureTypeMetadataFile),
});

const isCachedViteTypeMetadataSidecar =
  isObjectOf<CachedViteTypeMetadataSidecar>({
    dependencyStates: arrayOf(isNativeFileStateEntry),
    sidecar: isViteTypeMetadataSidecar,
    version: isNumber,
  });
