import path from "node:path";

import {
  getCapturedModuleAnalysis,
  isAuthoredModuleId,
  stripQuery,
  toMaterializedRelativePath,
} from "../capture";
import { runtimeResolutionKey } from "../type-metadata/provenance";
import type { RuntimeResolutionIdentity } from "../type-metadata/types";
import type {
  CapturedModule,
  CapturedRuntimeModule,
  MaterializedGraph,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

export function classifyEmptyCapturedModules(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    cssModuleIdsWithOwnership?: Iterable<string> | undefined;
    dynamicRootModuleIds: string[];
    entryModuleIds: string[];
    metrics?: ViteBuildMetrics | undefined;
    moduleIds: string[];
  },
) {
  const entryModuleIds = new Set(input.entryModuleIds);
  const dynamicRootModuleIds = new Set(input.dynamicRootModuleIds);
  const cssOwnedModuleIds = new Set(input.cssModuleIdsWithOwnership ?? []);
  const retainedEmptyModuleIds: string[] = [];
  const prunedEmptyModuleIds = new Set<string>();

  for (const moduleId of input.moduleIds) {
    const record = input.capturedModules.get(moduleId);
    if (!record) {
      this.error(
        `gccTsBundler() could not capture transformed code for ${moduleId}.`,
      );
    }

    if (!getCapturedModuleAnalysis(record, input.metrics).isEffectivelyEmpty) {
      continue;
    }
    retainedEmptyModuleIds.push(moduleId);

    if (
      entryModuleIds.has(moduleId) ||
      dynamicRootModuleIds.has(moduleId) ||
      cssOwnedModuleIds.has(moduleId)
    ) {
      continue;
    }
    prunedEmptyModuleIds.add(moduleId);
  }

  return {
    materializedModuleIds: input.moduleIds.filter(
      (moduleId) => !prunedEmptyModuleIds.has(moduleId),
    ),
    prunedEmptyModuleIds: [...prunedEmptyModuleIds],
    retainedEmptyModuleIds,
  };
}

export function assembleMaterializedModuleRecords(input: {
  capturedModules: Map<string, CapturedModule>;
  materializedModuleIds: string[];
  projectRoot: string;
  srcDir: string;
}) {
  const filePathByModuleId = new Map<string, string>();
  const modules: CapturedRuntimeModule[] = [];
  const authoredFiles: string[] = [];
  const dependencySourceFileByMaterializedFile: Record<string, string> = {};
  for (const moduleId of input.materializedModuleIds) {
    const relativePath = toMaterializedRelativePath(
      input.projectRoot,
      moduleId,
    );
    const filePath = path.join(input.srcDir, relativePath);
    filePathByModuleId.set(moduleId, filePath);
    const record = input.capturedModules.get(moduleId);
    const runtimeModule: CapturedRuntimeModule = {
      filePath,
      format: record?.format ?? record?.rawAnalysis?.moduleFormat ?? "unknown",
      id: moduleId,
      relativePath,
      sourceModuleIds: [moduleId],
    };
    if (record?.normalizedAnalysis?.commonJsNamedExports.length) {
      runtimeModule.commonJsNamedExports =
        record.normalizedAnalysis.commonJsNamedExports;
    }
    if (record?.renderedLength !== undefined) {
      runtimeModule.renderedLength = record.renderedLength;
    }
    modules.push(runtimeModule);
    if (isAuthoredModuleId(moduleId, input.projectRoot)) {
      authoredFiles.push(filePath);
    } else {
      const sourceFile = stripQuery(moduleId);
      if (path.isAbsolute(sourceFile)) {
        dependencySourceFileByMaterializedFile[path.normalize(filePath)] =
          path.normalize(sourceFile);
      }
    }
  }

  return {
    authoredFiles,
    dependencySourceFileByMaterializedFile,
    filePathByModuleId,
    modules,
  };
}

export function assembleMaterializedGraph(
  this: PluginContext,
  input: {
    authoredFiles: string[];
    dependencySourceFileByMaterializedFile: Record<string, string>;
    entryModuleIds: string[];
    filePathByModuleId: Map<string, string>;
    materializedModuleIds: string[];
    modules: CapturedRuntimeModule[];
    prunedEmptyModuleIds: string[];
    retainedEmptyModuleIds: string[];
    runtimeResolutions: RuntimeResolutionIdentity[];
    srcDir: string;
  },
): MaterializedGraph {
  const materializedSpecifier = (moduleId: string, role: string) => {
    const filePath = input.filePathByModuleId.get(moduleId);
    if (!filePath) {
      this.error(`Missing captured ${role} module ${moduleId}.`);
    }
    return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
  };

  return {
    authoredFiles: input.authoredFiles.sort((left, right) =>
      left.localeCompare(right),
    ),
    dependencySourceFileByMaterializedFile:
      input.dependencySourceFileByMaterializedFile,
    entries: input.entryModuleIds.map((moduleId) =>
      materializedSpecifier(moduleId, "entry"),
    ),
    modules: input.modules,
    prunedEmptyModuleIds: [...input.prunedEmptyModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    retainedEmptyModuleIds: input.retainedEmptyModuleIds.sort((left, right) =>
      left.localeCompare(right),
    ),
    runtimeEntries: input.materializedModuleIds
      .map((moduleId) => materializedSpecifier(moduleId, "runtime"))
      .sort((left, right) => left.localeCompare(right)),
    runtimeResolutions: [...input.runtimeResolutions].sort((left, right) =>
      runtimeResolutionKey(left).localeCompare(runtimeResolutionKey(right)),
    ),
    srcDir: input.srcDir,
  };
}
