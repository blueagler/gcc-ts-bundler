import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

import { writeFileIfChanged } from "../../shared/files";
import { assertNever } from "../../shared/validation";
import {
  collectReachableTypeFiles,
  isPlatformBuiltin,
  resolveModuleTypeEntries,
  resolveModuleTypeEntry,
} from "../compiler";
import { accountBarriers, formatBarrierWarning } from "../barriers";
import { createExternAnalysisContext } from "../context";
import {
  renderBoundaryAwareExterns,
  renderRuntimeAwareExterns,
} from "../render";
import { renderTypedExternalDeclarations } from "../typed-render";
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
    typeWorld: resolved.typeWorld,
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
    degradations: typed.degradations,
    globalSurfaces: typed.globalSurfaces,
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
    warnings: [
      ...resolved.warnings,
      ...formatUnresolvedDeclarationWarnings(
        resolved.unresolvedDeclarationDependencies,
      ),
      ...typed.warnings,
    ],
  };
}

async function resolveScannedFiles(options: ResolvedExternOptions) {
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions: options.compilerOptions,
    projectRoot: options.projectRoot,
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

async function renderTypedDeclarations(
  options: ResolvedExternOptions,
  analysis: ReturnType<typeof createExternAnalysisContext>,
) {
  const modules = await Promise.all(
    options.externalModules.map(async (module) => {
      const declaration = await resolveModuleTypeEntry({
        compilerOptions: options.compilerOptions,
        projectRoot: options.projectRoot,
        specifier: module.specifier,
        target: options.target,
      });
      if (!declaration.declarationEntry)
        throw new Error(
          `Unable to resolve declarations for external module ${module.specifier}.`,
        );
      return {
        ...declaration,
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
