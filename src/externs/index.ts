import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { writeFileIfChanged } from "../shared/files";
import { assertNever, defineValues, requireChoice } from "../shared/validation";
import {
  collectReachableTypeFiles,
  loadExternCompilerOptions,
  resolveAnalysisEntryFiles,
  resolveModuleTypeEntries,
} from "./compiler";
import { accountBarriers, formatBarrierWarning } from "./barriers";
import { createExternAnalysisContext } from "./context";
import {
  renderBoundaryAwareExterns,
  renderRuntimeAwareExterns,
} from "./render";
import { renderTypedExternalDeclarations } from "./typed-render";
import type {
  ExternBarrierWarning,
  ExternModuleInput,
  ExternTypeDiagnostic,
  GeneratedRenameBarrierArtifact,
  GeneratedTypedExternArtifact,
} from "./types";

export type {
  ExternBarrierWarning,
  ExternModuleInput,
  ExternRuntimePlacement,
  ExternTypeDiagnostic,
  GeneratedExternArtifact,
  GeneratedExternExport,
  GeneratedExternModule,
  GeneratedRenameBarrierArtifact,
  GeneratedTypedExternArtifact,
} from "./types";
export {
  BARRIER_WARNING_THRESHOLD,
  accountBarriers,
  auditExternFiles,
  collectBarrierNames,
  collectBarrierPropertyNames,
  formatBarrierWarning,
} from "./barriers";

export const EXTERN_MODES = defineValues("boundary-aware", "runtime-aware");
export type GenerateExternsMode = (typeof EXTERN_MODES)[number];

export interface ExternsProtocolHelpers {
  keyExclusionListCallees?: readonly string[] | undefined;
  keyReadCallees?: readonly string[] | undefined;
}

export interface GenerateExternsOptions {
  appEntryFiles?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly (string | ExternModuleInput)[];
  outputFile?: string | undefined;
  projectRoot?: string | undefined;
  protocolHelpers?: ExternsProtocolHelpers | undefined;
  runtimeEntryFiles?: readonly string[] | undefined;
  srcDir?: string | undefined;
  tsConfigPath?: string | undefined;
  typedOutputFile?: string | undefined;
}

export interface GenerateExternsResult {
  /**
   * Non-fatal cost signals: artifacts that pin more than
   * `BARRIER_WARNING_THRESHOLD` property names program-wide.
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
}

type ResolvedExternOptions = {
  appEntryFiles: string[];
  compilerOptions: Awaited<ReturnType<typeof loadExternCompilerOptions>>;
  externalModules: ExternModuleInput[];
  includeDependencies: boolean;
  mode: GenerateExternsMode;
  modules: string[];
  outputFile: string | undefined;
  projectRoot: string;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
  runtimeEntryFiles: string[];
  srcDir: string;
  typedOutputFile: string | undefined;
};

export async function generateExterns(
  options: GenerateExternsOptions,
): Promise<GenerateExternsResult> {
  const resolved = await resolveExternOptions(options);
  const scannedFiles = await resolveScannedFiles(resolved);
  const analysis = createExternAnalysisContext({
    appEntryFiles: resolved.appEntryFiles,
    compilerOptions: resolved.compilerOptions,
    projectRoot: resolved.projectRoot,
    scannedFiles,
  });
  const barrierText = await renderBarriers(resolved, analysis);
  const typed = await renderTypedDeclarations(resolved, analysis);

  const barrierAccounting = accountBarriers({
    contributingFiles: scannedFiles,
    label: `rename barriers (mode: ${resolved.mode})`,
    text: barrierText,
  });
  const typedAccounting = accountBarriers({
    contributingFiles: scannedFiles,
    label: "typed declarations",
    text: typed.text,
  });
  // One number for what the caller actually pins, not one per file shape.
  const propertyNames = [
    ...new Set([
      ...barrierAccounting.propertyNames,
      ...typedAccounting.propertyNames,
    ]),
  ].sort();
  const barrierWarnings = [barrierAccounting, typedAccounting].flatMap(
    (accounting) => {
      const message = formatBarrierWarning(accounting);
      return message
        ? [
            {
              artifact: accounting.label,
              message,
              propertyCount: accounting.total,
            },
          ]
        : [];
    },
  );

  await Promise.all([
    writeArtifact(resolved.outputFile, barrierText),
    writeArtifact(resolved.typedOutputFile, typed.text),
  ]);

  const renameBarriers: GeneratedRenameBarrierArtifact = {
    outputFile: resolved.outputFile,
    propertyNames,
    text: barrierText,
  };
  const typedDeclarations: GeneratedTypedExternArtifact = {
    moduleExports: typed.moduleExports,
    outputFile: resolved.typedOutputFile,
    propertyNames: typedAccounting.propertyNames,
    text: typed.text,
  };
  return {
    barrierWarnings,
    diagnostics: typed.diagnostics,
    mode: resolved.mode,
    modules: resolved.modules,
    outputFile: resolved.outputFile,
    renameBarriers,
    scannedFiles,
    text: barrierText,
    typedDeclarations,
  };
}

async function resolveExternOptions(
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
      typeof module === "string"
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
  const outputFile =
    options.outputFile === undefined
      ? undefined
      : path.resolve(projectRoot, options.outputFile);
  return {
    appEntryFiles,
    compilerOptions: await loadExternCompilerOptions({
      projectRoot,
      tsConfigPath:
        options.tsConfigPath === undefined
          ? undefined
          : path.resolve(projectRoot, options.tsConfigPath),
    }),
    externalModules,
    // Every surviving mode derives barriers from evidence — app usage or
    // emitted runtime code — so following imported declarations sharpens the
    // set rather than inflating it.
    includeDependencies: options.includeDependencies ?? true,
    mode,
    modules,
    outputFile,
    projectRoot,
    protocolHelpers: {
      keyExclusionListCallees: [
        ...(options.protocolHelpers?.keyExclusionListCallees ?? []),
      ],
      keyReadCallees: [...(options.protocolHelpers?.keyReadCallees ?? [])],
    },
    runtimeEntryFiles,
    srcDir,
    typedOutputFile:
      options.typedOutputFile === undefined
        ? outputFile && externalModules.length > 0
          ? siblingTypedOutput(outputFile)
          : undefined
        : path.resolve(projectRoot, options.typedOutputFile),
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

async function resolveScannedFiles(options: ResolvedExternOptions) {
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions: options.compilerOptions,
    projectRoot: options.projectRoot,
    specifiers: options.modules,
    tolerateMissing: options.mode === "runtime-aware",
  });
  return typeEntryFiles.length === 0
    ? []
    : collectReachableTypeFiles({
        compilerOptions: options.compilerOptions,
        entryFiles: typeEntryFiles,
        includeDependencies: options.includeDependencies,
      });
}

async function renderTypedDeclarations(
  options: ResolvedExternOptions,
  analysis: ReturnType<typeof createExternAnalysisContext>,
) {
  const modules = await Promise.all(
    options.externalModules.map(async (module) => {
      const [declarationEntry] = await resolveModuleTypeEntries({
        compilerOptions: options.compilerOptions,
        projectRoot: options.projectRoot,
        specifiers: [module.specifier],
        tolerateMissing: false,
      });
      if (!declarationEntry)
        throw new Error(
          `Unable to resolve declarations for external module ${module.specifier}.`,
        );
      return {
        declarationEntry,
        selectedExports:
          module.exports === "used"
            ? collectUsedExports(analysis, module.specifier)
            : undefined,
        specifier: module.specifier,
      };
    }),
  );
  return renderTypedExternalDeclarations({
    checker: analysis.checker,
    modules,
    program: analysis.program,
  });
}

function collectUsedExports(
  analysis: ReturnType<typeof createExternAnalysisContext>,
  specifier: string,
) {
  const exports = new Set<string>();
  for (const filePath of analysis.appEntryFiles) {
    const sourceFile = analysis.program.getSourceFile(filePath);
    if (!sourceFile) continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier
      ) {
        const clause = node.importClause;
        if (clause?.name) exports.add("default");
        if (
          clause?.namedBindings &&
          ts.isNamespaceImport(clause.namedBindings)
        ) {
          exports.add("*");
        } else if (
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings)
        ) {
          for (const element of clause.namedBindings.elements) {
            exports.add((element.propertyName ?? element.name).text);
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression) &&
        node.moduleReference.expression.text === specifier
      ) {
        exports.add("export=");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return exports;
}

async function renderBarriers(
  options: ResolvedExternOptions,
  analysis: ReturnType<typeof createExternAnalysisContext>,
) {
  const compiledModules = options.modules.filter(
    (specifier) =>
      !options.externalModules.some((module) => module.specifier === specifier),
  );
  if (compiledModules.length === 0) {
    return ["/** @externs */", "// No proven rename barriers.", ""].join("\n");
  }
  switch (options.mode) {
    case "boundary-aware":
      return renderBoundaryAwareExterns({ analysis, modules: compiledModules });
    case "runtime-aware":
      return renderRuntimeAwareExterns({
        analysis,
        modules: compiledModules,
        protocolHelpers: options.protocolHelpers,
        runtimeEntryFiles: options.runtimeEntryFiles,
      });
    default:
      return assertNever(options.mode);
  }
}

async function writeArtifact(outputFile: string | undefined, text: string) {
  if (!outputFile) return;
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  await writeFileIfChanged(outputFile, text);
}

function siblingTypedOutput(outputFile: string) {
  return outputFile.endsWith(".js")
    ? `${outputFile.slice(0, -3)}.typed.externs.js`
    : `${outputFile}.typed.externs.js`;
}
