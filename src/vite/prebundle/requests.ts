import path from "node:path";

import { logInternalDetail } from "../../shared/timing";
import type { CapturedRuntimeModule } from "../internal-types";
import { resolveNamespaceImportMembers } from "./direct-esm";
import { assignRegionLabels } from "./regions";
import type { RegionBundleRequest } from "./regions";
import { ATOM_REGION_LABEL, EAGER_REGION_LABEL, normalizePath } from "./shared";
import type {
  ParsedDependencyImport,
  ParsedMaterializedModule,
} from "./shared";
import type { PrebundleContext } from "./types";

function resolveCommonJsFacadeNamedExports(
  context: PrebundleContext,
  parsedTarget: ParsedMaterializedModule,
) {
  if (!parsedTarget.hasDefaultExport) {
    return [];
  }
  return [
    ...new Set(
      parsedTarget.dependencyImports
        .filter((dependencyImport) =>
          dependencyImport.namedExports.includes("__require"),
        )
        .flatMap(
          (dependencyImport) =>
            context.moduleByFilePath.get(
              normalizePath(dependencyImport.targetFilePath),
            )?.commonJsNamedExports ?? [],
        ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export async function collectBundleRequests(
  context: PrebundleContext,
  dynamicRootModuleIds: string[],
  directFilePaths: Set<string>,
  prebundleFilePaths: Set<string>,
) {
  const entryFilePaths = context.materialized.entries.map((entry) =>
    normalizePath(path.resolve(context.materialized.srcDir, entry)),
  );
  const dynamicRootModulesByFilePath = new Map<string, CapturedRuntimeModule>();
  for (const moduleId of dynamicRootModuleIds) {
    const module = context.moduleBySourceId.get(moduleId);
    if (module) {
      dynamicRootModulesByFilePath.set(normalizePath(module.filePath), module);
    }
  }
  const dynamicRootFilePaths = [...dynamicRootModulesByFilePath.keys()]
    .filter((filePath) => context.authoredFiles.has(filePath))
    .sort((left, right) => left.localeCompare(right));

  const regionLabelsByAuthoredFile = await assignRegionLabels({
    authoredFiles: context.authoredFiles,
    dynamicRootFilePaths,
    entryFilePaths,
    parseModule: context.parseModule,
  });

  const bundleRequests = new Map<string, RegionBundleRequest>();
  for (const filePath of context.materialized.authoredFiles) {
    const normalizedFilePath = normalizePath(filePath);
    const regionKey = regionLabelsByAuthoredFile.get(normalizedFilePath);
    if (!regionKey) {
      continue;
    }

    const parsed = await context.parseModule(normalizedFilePath);
    for (const dependencyImport of parsed.dependencyImports) {
      const targetModule = context.moduleByFilePath.get(
        normalizePath(dependencyImport.targetFilePath),
      );
      if (
        !targetModule ||
        !prebundleFilePaths.has(normalizePath(targetModule.filePath))
      ) {
        continue;
      }

      const requestKey = `${regionKey}\u0000${normalizePath(targetModule.filePath)}`;
      const existing = bundleRequests.get(requestKey);
      if (existing) {
        existing.needsDefault ||= dependencyImport.hasDefault;
        existing.needsExportAll ||= dependencyImport.hasNamespace;
        existing.needsSideEffectOnly ||= dependencyImport.isSideEffectOnly;
        for (const namedExport of dependencyImport.namedExports) {
          existing.usedNamedExports.add(namedExport);
        }
        continue;
      }

      const parsedTarget = await context.parseModule(targetModule.filePath);
      const commonJsFacadeNamedExports = resolveCommonJsFacadeNamedExports(
        context,
        parsedTarget,
      );
      bundleRequests.set(requestKey, {
        commonJsFacadeNamedExports,
        exportedNames: [
          ...new Set([
            ...parsedTarget.exportedNames,
            ...commonJsFacadeNamedExports,
          ]),
        ],
        hasDefaultExport: parsedTarget.hasDefaultExport,
        needsDefault: dependencyImport.hasDefault,
        needsExportAll: dependencyImport.hasNamespace,
        needsSideEffectOnly: dependencyImport.isSideEffectOnly,
        regionKey,
        sourceModuleIds: [...targetModule.sourceModuleIds],
        targetFilePath: normalizePath(targetModule.filePath),
        targetModule,
        usedNamedExports: new Set(dependencyImport.namedExports),
      });
    }
  }

  const entryRequestKeyByTargetFilePath = new Map<string, string>();
  for (const targetFilePath of entryFilePaths) {
    const targetModule = context.moduleByFilePath.get(targetFilePath);
    if (
      !targetModule ||
      context.authoredFiles.has(targetFilePath) ||
      !prebundleFilePaths.has(targetFilePath)
    ) {
      continue;
    }
    const requestKey = `${EAGER_REGION_LABEL}\u0000${targetFilePath}`;
    const parsedTarget = await context.parseModule(targetFilePath);
    const commonJsFacadeNamedExports = resolveCommonJsFacadeNamedExports(
      context,
      parsedTarget,
    );
    bundleRequests.set(requestKey, {
      commonJsFacadeNamedExports,
      exportedNames: [
        ...new Set([
          ...parsedTarget.exportedNames,
          ...commonJsFacadeNamedExports,
        ]),
      ],
      hasDefaultExport: parsedTarget.hasDefaultExport,
      needsDefault: parsedTarget.hasDefaultExport,
      needsExportAll: true,
      needsSideEffectOnly: false,
      regionKey: EAGER_REGION_LABEL,
      sourceModuleIds: [...targetModule.sourceModuleIds],
      targetFilePath,
      targetModule,
      usedNamedExports: new Set<string>(),
    });
    entryRequestKeyByTargetFilePath.set(targetFilePath, requestKey);
  }

  const dynamicRootRequestKeyByTargetFilePath = new Map<string, string>();
  for (const [targetFilePath, targetModule] of [
    ...dynamicRootModulesByFilePath.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    if (
      context.authoredFiles.has(targetFilePath) ||
      !prebundleFilePaths.has(targetFilePath)
    ) {
      continue;
    }
    const regionKey = `dynamic:${targetFilePath}`;
    const requestKey = `${regionKey}\u0000${targetFilePath}`;
    const parsedTarget = await context.parseModule(targetFilePath);
    const commonJsFacadeNamedExports = resolveCommonJsFacadeNamedExports(
      context,
      parsedTarget,
    );
    bundleRequests.set(requestKey, {
      commonJsFacadeNamedExports,
      exportedNames: [
        ...new Set([
          ...parsedTarget.exportedNames,
          ...commonJsFacadeNamedExports,
        ]),
      ],
      hasDefaultExport: parsedTarget.hasDefaultExport,
      needsDefault: parsedTarget.hasDefaultExport,
      needsExportAll: true,
      needsSideEffectOnly: false,
      regionKey,
      sourceModuleIds: [...targetModule.sourceModuleIds],
      targetFilePath,
      targetModule,
      usedNamedExports: new Set<string>(),
    });
    dynamicRootRequestKeyByTargetFilePath.set(targetFilePath, requestKey);
  }

  const atomRequestKeyByTargetFilePath = await collectAtomBundleRequests({
    bundleRequests,
    context,
    directFilePaths,
    prebundleFilePaths,
  });

  return {
    atomRequestKeyByTargetFilePath,
    bundleRequests,
    dynamicRootRequestKeyByTargetFilePath,
    entryRequestKeyByTargetFilePath,
    regionLabelsByAuthoredFile,
  };
}

/**
 * Add one bundle request per unsafe module that a direct module imports. The
 * atom is the esbuild closure of that single module, so an icon data file or a
 * CommonJS core is bundled on its own instead of dragging the ESM tree that
 * imports it into the same bundle.
 */
async function collectAtomBundleRequests(input: {
  bundleRequests: Map<string, RegionBundleRequest>;
  context: PrebundleContext;
  directFilePaths: Set<string>;
  prebundleFilePaths: Set<string>;
}) {
  const atomRequestKeyByTargetFilePath = new Map<string, string>();
  for (const filePath of [...input.directFilePaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const parsed = await input.context.parseModule(filePath);
    for (const dependencyImport of parsed.dependencyImports) {
      const targetFilePath = normalizePath(dependencyImport.targetFilePath);
      const targetModule = input.context.moduleByFilePath.get(targetFilePath);
      if (!targetModule || !input.prebundleFilePaths.has(targetFilePath)) {
        continue;
      }
      const requestKey = `${ATOM_REGION_LABEL}\u0000${targetFilePath}`;
      const existing = input.bundleRequests.get(requestKey);
      if (existing) {
        existing.needsDefault ||= dependencyImport.hasDefault;
        existing.needsExportAll ||= dependencyImport.hasNamespace;
        existing.needsSideEffectOnly ||= dependencyImport.isSideEffectOnly;
        for (const namedExport of dependencyImport.namedExports) {
          existing.usedNamedExports.add(namedExport);
        }
        continue;
      }
      const parsedTarget = await input.context.parseModule(targetFilePath);
      const commonJsFacadeNamedExports = resolveCommonJsFacadeNamedExports(
        input.context,
        parsedTarget,
      );
      input.bundleRequests.set(requestKey, {
        commonJsFacadeNamedExports,
        exportedNames: [
          ...new Set([
            ...parsedTarget.exportedNames,
            ...commonJsFacadeNamedExports,
          ]),
        ],
        hasDefaultExport: parsedTarget.hasDefaultExport,
        needsDefault: dependencyImport.hasDefault,
        needsExportAll: dependencyImport.hasNamespace,
        needsSideEffectOnly: dependencyImport.isSideEffectOnly,
        regionKey: ATOM_REGION_LABEL,
        sourceModuleIds: [...targetModule.sourceModuleIds],
        targetFilePath,
        targetModule,
        usedNamedExports: new Set(dependencyImport.namedExports),
      });
      atomRequestKeyByTargetFilePath.set(targetFilePath, requestKey);
    }
  }
  return atomRequestKeyByTargetFilePath;
}

/**
 * Route every materialized dependency module either to the native pipeline
 * (direct) or to an esbuild atom (prebundle).
 *
 * A module is unsafe on its own evidence only: a non-ESM format, a bare import
 * the native resolver cannot follow, a static edge into authored code, a
 * build-time define the materialized text still reads, or a fused multi-region
 * distribution file. Unsafety is never propagated to importers: a clean module
 * that imports an unsafe one stays direct and has that specifier rewritten to
 * the unsafe module's atom bundle, so one CJS leaf cannot poison the whole ESM
 * tree that reaches it.
 */
export async function classifyDependencyRouting(context: PrebundleContext) {
  const dependencyFilePaths = new Set(
    context.materialized.modules
      .map((module) => normalizePath(module.filePath))
      .filter((filePath) => !context.authoredFiles.has(filePath)),
  );
  const directFilePaths = new Set<string>();
  const prebundleFilePaths = new Set<string>();

  const sortedFilePaths = [...dependencyFilePaths].sort((left, right) =>
    left.localeCompare(right),
  );
  const unsafeFilePaths = new Set<string>();
  for (const filePath of sortedFilePaths) {
    const module = context.moduleByFilePath.get(filePath);
    const parsed = await context.parseModule(filePath);
    const isSelfClean =
      module !== undefined &&
      module.format === "esm" &&
      !parsed.hasDefineReferences &&
      !parsed.isFusedDistribution &&
      parsed.bareImportSpecifiers.length === 0 &&
      parsed.staticAuthoredImports.length === 0 &&
      parsed.dependencyFilePaths.every((targetFilePath) =>
        dependencyFilePaths.has(normalizePath(targetFilePath)),
      );
    if (!isSelfClean) {
      unsafeFilePaths.add(filePath);
      prebundleFilePaths.add(filePath);
    }
  }

  for (const filePath of sortedFilePaths) {
    if (unsafeFilePaths.has(filePath)) {
      continue;
    }
    const parsed = await context.parseModule(filePath);
    const hasOpaqueAtomEdge = parsed.dependencyImports.some(
      (dependencyImport) =>
        unsafeFilePaths.has(normalizePath(dependencyImport.targetFilePath)) &&
        !canBindAtomImport(context, dependencyImport),
    );
    (hasOpaqueAtomEdge ? prebundleFilePaths : directFilePaths).add(filePath);
  }

  logInternalDetail(
    "vite:dependency-routing",
    `direct=${directFilePaths.size} prebundle=${prebundleFilePaths.size} unsafe=${unsafeFilePaths.size} total=${dependencyFilePaths.size}`,
  );
  return { directFilePaths, prebundleFilePaths };
}

/**
 * True when a direct module's edge into an atom can be expressed as explicit
 * named bindings. Named and default imports always can. A namespace import or
 * an `export *` needs the atom's export list, which esbuild can enumerate for
 * an ESM target but not for a CommonJS one; there the namespace must resolve
 * to fixed member reads instead.
 */
function canBindAtomImport(
  context: PrebundleContext,
  dependencyImport: ParsedDependencyImport,
) {
  if (!dependencyImport.hasNamespace) {
    return true;
  }
  const targetModule = context.moduleByFilePath.get(
    normalizePath(dependencyImport.targetFilePath),
  );
  if (targetModule?.format !== "cjs" && targetModule?.format !== "mixed") {
    return true;
  }
  return resolveNamespaceImportMembers(dependencyImport) !== null;
}

export async function hasBarePackageEdges(context: PrebundleContext) {
  for (const module of context.materialized.modules) {
    const parsed = await context.parseModule(module.filePath);
    if (parsed.bareImportSpecifiers.length > 0) return true;
  }
  return false;
}
