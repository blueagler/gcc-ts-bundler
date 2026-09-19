import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

import { runWithConcurrency } from "../../shared/concurrency";
import { writeFileIfChanged } from "../../shared/files";
import { assertNever } from "../../shared/validation";
import {
  collectReachableTypeFiles,
  isPlatformBuiltin,
  resolveModuleTypeEntries,
  resolveModuleTypeEntry,
} from "../compiler";
import { accountBarriers, formatBarrierWarning } from "../barriers";
import {
  createExternAnalysisContext,
  type ExternAnalysisContext,
} from "../context";
import { applyPropertyPolicy } from "../property-policy";
import {
  renderBoundaryAwareExterns,
  renderRuntimeAwareExterns,
} from "../render";
import { renderTypedExternalDeclarations } from "../typed-render";
import type { ModuleSeed } from "../typed-render";
import type {
  GeneratedRenameBarrierArtifact,
  GeneratedTypedExternArtifact,
} from "../types";
import {
  resolveExternOptions,
  type GenerateExternsOptions,
  type GenerateExternsResult,
  type ResolvedExternOptions,
} from "./options";
import { collectUsedExportsByModule } from "./used-exports";

export async function generateExterns(
  options: GenerateExternsOptions,
): Promise<GenerateExternsResult> {
  const resolved = await resolveExternOptions(options);
  const resolutionCache = ts.createModuleResolutionCache(
    resolved.projectRoot,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    resolved.compilerOptions,
  );
  const scannedFiles = await resolveScannedFiles(resolved, resolutionCache);
  const typedSeeds = await resolveTypedModuleSeeds(resolved, resolutionCache);
  const analysis = createExternAnalysisContext({
    appEntryFiles: resolved.appEntryFiles,
    compilerOptions: resolved.compilerOptions,
    declarationRoots: typedSeeds.map((seed) => seed.declarationEntry),
    projectRoot: resolved.projectRoot,
    scannedFiles,
    typeWorld: resolved.typeWorld,
  });
  const barrierText = await renderBarriers(resolved, analysis);
  const typed = renderTypedDeclarations(resolved, analysis, typedSeeds);

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

  const artifacts = [
    { outputFile: resolved.outputFile, text: barrierText },
    { outputFile: resolved.typedOutputFile, text: typed.text },
  ];
  const fragmentsDir = resolved.typedModuleFragmentsDir;
  const moduleFragments =
    fragmentsDir === undefined
      ? undefined
      : typed.moduleFragments?.map(({ modules, text }, index) => {
          const outputFile = path.join(
            fragmentsDir,
            `fragment-${index}.externs.js`,
          );
          if (
            outputFile === resolved.outputFile ||
            outputFile === resolved.typedOutputFile
          ) {
            throw new Error(
              `typedModuleFragmentsDir fragments must resolve to distinct artifact paths: ${outputFile}.`,
            );
          }
          artifacts.push({ outputFile, text });
          return { outputFile, modules };
        });
  await runWithConcurrency(artifacts, 2, ({ outputFile, text }) =>
    writeArtifact(outputFile, text),
  );

  const renameBarriers: GeneratedRenameBarrierArtifact = {
    outputFile: resolved.outputFile,
    propertyNames,
    text: barrierText,
  };
  const typedDeclarations: GeneratedTypedExternArtifact = {
    degradations: typed.degradations,
    globalSurfaces: typed.globalSurfaces,
    moduleExports: typed.moduleExports,
    moduleFragments,
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
    warnings: [
      ...resolved.warnings,
      ...formatUnresolvedDeclarationWarnings(
        resolved.unresolvedDeclarationDependencies,
      ),
      ...typed.warnings,
    ],
  };
}

async function resolveScannedFiles(
  options: ResolvedExternOptions,
  resolutionCache: ts.ModuleResolutionCache,
) {
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions: options.compilerOptions,
    projectRoot: options.projectRoot,
    resolutionCache,
    specifiers: options.modules.filter(
      (specifier) => !isPlatformBuiltin(specifier),
    ),
    target: options.target,
    tolerateMissing: options.mode === "runtime-aware",
  });
  return typeEntryFiles.length === 0
    ? []
    : collectReachableTypeFiles({
        compilerOptions: options.compilerOptions,
        entryFiles: typeEntryFiles,
        includeDependencies: options.includeDependencies,
        onUnresolved: (specifier) => {
          options.unresolvedDeclarationDependencies.set(
            specifier,
            (options.unresolvedDeclarationDependencies.get(specifier) ?? 0) + 1,
          );
        },
      });
}

/** A resolved external module plus the export-selection policy to apply once
 * the analysis program exists. */
interface TypedModuleSeed extends Omit<ModuleSeed, "selectedExports"> {
  usedExportsOnly: boolean;
}

/**
 * Declaration entries must be known before the analysis program exists: they
 * are program roots, without which the checker has no module symbol for an
 * external specifier and every typed surface renders empty.
 */
async function resolveTypedModuleSeeds(
  options: ResolvedExternOptions,
  resolutionCache: ts.ModuleResolutionCache,
): Promise<TypedModuleSeed[]> {
  return Promise.all(
    options.externalModules.map(async (module) => {
      const declaration = await resolveModuleTypeEntry({
        compilerOptions: options.compilerOptions,
        projectRoot: options.projectRoot,
        resolutionCache,
        specifier: module.specifier,
        target: options.target,
      });
      if (!declaration.declarationEntry)
        throw new Error(
          `Unable to resolve declarations for external module ${module.specifier}.`,
        );
      return {
        ...declaration,
        declarationEntry: declaration.declarationEntry,
        specifier: module.specifier,
        usedExportsOnly: module.exports === "used",
      };
    }),
  );
}

function renderTypedDeclarations(
  options: ResolvedExternOptions,
  analysis: ExternAnalysisContext,
  seeds: readonly TypedModuleSeed[],
) {
  const usedExports = collectUsedExportsByModule(
    analysis,
    seeds.filter((seed) => seed.usedExportsOnly),
  );
  const modules = seeds.map(({ usedExportsOnly, ...seed }) => ({
    ...seed,
    selectedExports: usedExportsOnly
      ? usedExports.get(seed.specifier)
      : undefined,
  }));
  return renderTypedExternalDeclarations({
    checker: analysis.checker,
    maxSymbolDepth: options.maxSymbolDepth,
    moduleFragments: options.typedModuleFragmentsDir !== undefined,
    modules,
    program: analysis.program,
    projectRoot: options.projectRoot,
  });
}

function formatUnresolvedDeclarationWarnings(
  unresolved: ReadonlyMap<string, number>,
) {
  if (unresolved.size === 0) return [];
  const references = [...unresolved.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return [
    `Unresolved declaration dependencies: ${references} references across ${unresolved.size} specifiers (${[
      ...unresolved,
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([specifier, count]) => `${JSON.stringify(specifier)} ×${count}`)
      .join(", ")}).`,
  ];
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
    applyPropertyPolicy(new Set(), options.propertyPolicy);
    return ["/** @externs */", "// No proven rename barriers.", ""].join("\n");
  }
  switch (options.mode) {
    case "boundary-aware":
      return renderBoundaryAwareExterns({
        analysis,
        modules: compiledModules,
        propertyPolicy: options.propertyPolicy,
      });
    case "runtime-aware":
      return renderRuntimeAwareExterns({
        analysis,
        modules: compiledModules,
        propertyPolicy: options.propertyPolicy,
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
