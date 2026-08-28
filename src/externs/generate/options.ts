import path from "node:path";

import { defineValues, isString, requireChoice } from "../../shared/validation";
import {
  loadExternCompilerOptions,
  resolveAnalysisEntryFiles,
} from "../compiler";
import type { TypeWorld } from "../context";
import { resolvePropertyPolicy, type PropertyPolicy } from "../property-policy";
import type { TargetName } from "../../api/targets";
import type {
  ExternBarrierWarning,
  ExternModuleInput,
  ExternTypeDiagnostic,
  GeneratedRenameBarrierArtifact,
  GeneratedTypedExternArtifact,
} from "../types";

export type { PropertyPolicy } from "../property-policy";

export const EXTERN_MODES = defineValues("boundary-aware", "runtime-aware");
export type GenerateExternsMode = (typeof EXTERN_MODES)[number];

export interface ExternsProtocolHelpers {
  keyExclusionListCallees?: readonly string[] | undefined;
  keyReadCallees?: readonly string[] | undefined;
}

export interface GenerateExternsOptions {
  appEntryFiles?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  /**
   * Bounds how far past a seed export a referenced type is still spelled out.
   * Omitted means unbounded, which is required wherever the emitted surface is
   * a published contract (the self-build asserts its public API externs carry
   * no degradations). Set it for modules that Closure never compiles: their
   * type detail only feeds optimization, and the unbounded closure of a single
   * export can reach an entire dependency's type graph.
   */
  maxSymbolDepth?: number | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly (string | ExternModuleInput)[];
  outputFile?: string | undefined;
  projectRoot?: string | undefined;
  /**
   * Structural `Object.prototype.*` pins the caller asserts are renameable.
   * Each name must match a generated barrier line or generation fails closed.
   * Names beginning with `__gcc` are rejected: the runtime bridge depends on
   * them. Typed owner-qualified pins are not filtered.
   */
  propertyPolicy?: PropertyPolicy | undefined;
  protocolHelpers?: ExternsProtocolHelpers | undefined;
  runtimeEntryFiles?: readonly string[] | undefined;
  srcDir?: string | undefined;
  target?: TargetName | undefined;
  tsConfigPath?: string | undefined;
  typeWorld?: TypeWorld | undefined;
  typedOutputFile?: string | undefined;
}

export interface GenerateExternsResult {
  /**
   * Non-fatal cost signals: artifacts that pin more than
   * 200 property names program-wide.
   */
  barrierWarnings: readonly ExternBarrierWarning[];
  diagnostics: readonly ExternTypeDiagnostic[];
  mode: GenerateExternsMode;
  modules: readonly string[];
  outputFile: string | undefined;
  /**
   * `propertyNames` is the union across *both* artifacts: the flat barrier
   * file and the typed declarations, which pin names just as globally through
   * `Owner.prototype.P` and `{"P": …}` record keys.
   */
  renameBarriers: GeneratedRenameBarrierArtifact;
  scannedFiles: readonly string[];
  text: string;
  typedDeclarations: GeneratedTypedExternArtifact;
  warnings: readonly string[];
}

export type ResolvedExternOptions = {
  appEntryFiles: string[];
  compilerOptions: Awaited<ReturnType<typeof loadExternCompilerOptions>>;
  externalModules: ExternModuleInput[];
  includeDependencies: boolean;
  mode: GenerateExternsMode;
  modules: string[];
  outputFile: string | undefined;
  projectRoot: string;
  propertyPolicy: PropertyPolicy | undefined;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
  runtimeEntryFiles: string[];
  srcDir: string;
  maxSymbolDepth: number | undefined;
  target: TargetName;
  typedOutputFile: string | undefined;
  unresolvedDeclarationDependencies: Map<string, number>;
  warnings: string[];
  typeWorld: TypeWorld | undefined;
};

export async function resolveExternOptions(
  options: GenerateExternsOptions,
): Promise<ResolvedExternOptions> {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }
  const mode = requireChoice(
    options.mode ?? "boundary-aware",
    EXTERN_MODES,
    "mode",
  );
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? ".");
  const moduleInputs = options.modules.map(
    (module): ExternModuleInput =>
      isString(module)
        ? { runtime: "compiled", specifier: module }
        : {
            ...module,
            runtimeEntryFiles: [...(module.runtimeEntryFiles ?? [])],
          },
  );
  const modules = moduleInputs.map((module) => module.specifier);
  const appEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: [...(options.appEntryFiles ?? [])],
    projectRoot,
    srcDir,
  });
  const runtimeEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: [
      ...(options.runtimeEntryFiles ?? []),
      ...moduleInputs
        .filter((module) => module.runtime === "compiled")
        .flatMap((module) => module.runtimeEntryFiles ?? []),
    ],
    projectRoot,
    srcDir,
  });
  const externalModules = moduleInputs.filter(
    (module) => module.runtime === "external",
  );
  validateModeInputs(
    mode,
    appEntryFiles,
    runtimeEntryFiles,
    externalModules.length > 0,
  );
  const propertyPolicy = resolvePropertyPolicy(options.propertyPolicy);
  const outputFile =
    options.outputFile === undefined
      ? undefined
      : path.resolve(projectRoot, options.outputFile);
  return {
    appEntryFiles,
    compilerOptions:
      options.typeWorld?.compilerOptions ??
      (await loadExternCompilerOptions({
        projectRoot,
        target: options.target ?? "browser",
        tsConfigPath:
          options.tsConfigPath === undefined
            ? undefined
            : path.resolve(projectRoot, options.tsConfigPath),
      })),
    externalModules,
    // Package-local by default. Following imported declarations is opt-in;
    // platform specifiers are never crawled either way.
    includeDependencies: options.includeDependencies ?? false,
    maxSymbolDepth: options.maxSymbolDepth,
    mode,
    modules,
    outputFile,
    projectRoot,
    propertyPolicy,
    protocolHelpers: {
      keyExclusionListCallees: [
        ...(options.protocolHelpers?.keyExclusionListCallees ?? []),
      ],
      keyReadCallees: [...(options.protocolHelpers?.keyReadCallees ?? [])],
    },
    runtimeEntryFiles,
    srcDir,
    target: options.target ?? "browser",
    unresolvedDeclarationDependencies: new Map(),
    warnings: [],
    typedOutputFile:
      options.typedOutputFile === undefined
        ? outputFile && externalModules.length > 0
          ? siblingTypedOutput(outputFile)
          : undefined
        : path.resolve(projectRoot, options.typedOutputFile),
    typeWorld: options.typeWorld,
  };
}

function validateModeInputs(
  mode: GenerateExternsMode,
  appEntryFiles: readonly string[],
  runtimeEntryFiles: readonly string[],
  hasExternalModules: boolean,
) {
  if (
    mode === "boundary-aware" &&
    appEntryFiles.length === 0 &&
    !hasExternalModules
  ) {
    throw new Error(
      "generateExterns in boundary-aware mode requires appEntryFiles.",
    );
  }
  if (
    mode === "runtime-aware" &&
    runtimeEntryFiles.length === 0 &&
    !hasExternalModules
  ) {
    throw new Error(
      "generateExterns in runtime-aware mode requires runtimeEntryFiles.",
    );
  }
}

function siblingTypedOutput(outputFile: string) {
  return outputFile.endsWith(".js")
    ? `${outputFile.slice(0, -3)}.typed.externs.js`
    : `${outputFile}.typed.externs.js`;
}
