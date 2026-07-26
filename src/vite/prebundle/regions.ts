import path from "node:path";

import { classifyModuleId, toRelativeImportSpecifier } from "../capture";
import type { CapturedRuntimeModule } from "../internal-types";
import type { EsbuildBuild } from "./esbuild";
import type { ParsedMaterializedModule } from "./shared";
import { EAGER_REGION_LABEL, normalizePath } from "./shared";

export interface RegionBundleRequest {
  exportedNames: string[];
  hasDefaultExport: boolean;
  needsDefault: boolean;
  needsExportAll: boolean;
  needsSideEffectOnly: boolean;
  regionKey: string;
  sourceModuleIds: string[];
  targetFilePath: string;
  targetModule: CapturedRuntimeModule;
  usedNamedExports: Set<string>;
}

export interface GroupedRegionBundleRequest {
  requestKey: string;
  requests: RegionBundleRequest[];
  sourceModuleIds: string[];
}

export interface WrittenRegionBundleRequest extends GroupedRegionBundleRequest {
  entryPoint: string;
}

export async function assignRegionLabels(input: {
  authoredFiles: Set<string>;
  dynamicRootFilePaths: string[];
  entryFilePaths: string[];
  parseModule: (filePath: string) => Promise<ParsedMaterializedModule>;
}) {
  const labelsByFile = new Map<string, Set<string>>();
  const traverse = async (roots: string[], label: string) => {
    const queue = [...roots];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const filePath = queue.pop();
      if (!filePath) {
        continue;
      }
      const normalizedFilePath = normalizePath(filePath);
      if (
        seen.has(normalizedFilePath) ||
        !input.authoredFiles.has(normalizedFilePath)
      ) {
        continue;
      }
      seen.add(normalizedFilePath);
      const labels = labelsByFile.get(normalizedFilePath) ?? new Set<string>();
      labels.add(label);
      labelsByFile.set(normalizedFilePath, labels);
      const parsed = await input.parseModule(normalizedFilePath);
      queue.push(...parsed.staticAuthoredImports);
    }
  };

  await traverse(input.entryFilePaths, EAGER_REGION_LABEL);
  for (const dynamicRootFilePath of input.dynamicRootFilePaths) {
    await traverse(
      [dynamicRootFilePath],
      `dynamic:${normalizePath(dynamicRootFilePath)}`,
    );
  }

  return new Map(
    [...labelsByFile.entries()].map(([filePath, labels]) => [
      filePath,
      [...labels].sort((left, right) => left.localeCompare(right)).join("|"),
    ]),
  );
}

export async function renderBundleEntrySource(input: {
  entryPoint: string;
  requests: RegionBundleRequest[];
  resolveDeepExport?: (
    targetFilePath: string,
    exportName: string,
  ) => Promise<{ imported: string; targetFilePath: string } | null>;
}) {
  const lines: string[] = [];

  for (const request of input.requests) {
    const importPath = toRelativeImportSpecifier(
      input.entryPoint,
      request.targetFilePath,
    );
    if (
      request.needsSideEffectOnly &&
      !request.needsDefault &&
      !request.needsExportAll &&
      request.usedNamedExports.size === 0
    ) {
      lines.push(`import ${JSON.stringify(importPath)};`);
    }

    if (request.needsExportAll) {
      lines.push(`export * from ${JSON.stringify(importPath)};`);
    }

    const exportSpecifiers = new Set<string>();
    if (
      request.hasDefaultExport &&
      (request.needsDefault || request.needsExportAll)
    ) {
      exportSpecifiers.add("default");
    }
    for (const namedExport of request.usedNamedExports) {
      exportSpecifiers.add(namedExport);
    }

    // Resolve names through pure barrel modules to their defining modules so
    // esbuild splitting can place per-region code into per-region bundles.
    const passthroughSpecifiers: string[] = [];
    const deepSpecifiersByTarget = new Map<string, string[]>();
    for (const exportName of [...exportSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const resolved = input.resolveDeepExport
        ? await input.resolveDeepExport(request.targetFilePath, exportName)
        : null;
      if (!resolved) {
        passthroughSpecifiers.push(exportName);
        continue;
      }
      const deepImportPath = toRelativeImportSpecifier(
        input.entryPoint,
        resolved.targetFilePath,
      );
      const specifier =
        resolved.imported === exportName
          ? exportName
          : `${resolved.imported} as ${exportName}`;
      const bucket = deepSpecifiersByTarget.get(deepImportPath);
      if (bucket) {
        bucket.push(specifier);
      } else {
        deepSpecifiersByTarget.set(deepImportPath, [specifier]);
      }
    }

    if (passthroughSpecifiers.length > 0) {
      lines.push(
        `export { ${passthroughSpecifiers.join(", ")} } from ${JSON.stringify(importPath)};`,
      );
    }
    for (const [deepImportPath, specifiers] of [
      ...deepSpecifiersByTarget.entries(),
    ].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(
        `export { ${specifiers.join(", ")} } from ${JSON.stringify(deepImportPath)};`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function groupBundleRequests(requests: RegionBundleRequest[]) {
  const groupedRequests: GroupedRegionBundleRequest[] = [];
  const requestGroupKeyByTarget = new Map<string, string>();

  const requestsByRegionAndPackage = new Map<string, RegionBundleRequest[]>();
  for (const request of requests) {
    const packageKey =
      request.sourceModuleIds[0] !== undefined
        ? classifyModuleId(request.sourceModuleIds[0], "bundle")
        : "bundle";
    const bucketKey = `${request.regionKey}\u0000${packageKey}`;
    const bucket = requestsByRegionAndPackage.get(bucketKey);
    if (bucket) {
      bucket.push(request);
    } else {
      requestsByRegionAndPackage.set(bucketKey, [request]);
    }
  }

  for (const [bucketKey, bucketRequests] of [
    ...requestsByRegionAndPackage.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    if (
      bucketRequests.length === 1 ||
      !canCombineBundleRequests(bucketRequests)
    ) {
      for (const request of bucketRequests.sort((left, right) =>
        left.targetFilePath.localeCompare(right.targetFilePath),
      )) {
        const requestKey = `${request.regionKey}\u0000${request.targetFilePath}`;
        groupedRequests.push({
          requestKey,
          requests: [request],
          sourceModuleIds: [...request.sourceModuleIds],
        });
        requestGroupKeyByTarget.set(requestKey, requestKey);
      }
      continue;
    }

    const groupedRequestKey = `${bucketKey}\u0000bundle`;
    const groupedRequest = {
      requestKey: groupedRequestKey,
      requests: bucketRequests.sort((left, right) =>
        left.targetFilePath.localeCompare(right.targetFilePath),
      ),
      sourceModuleIds: [
        ...new Set(
          bucketRequests.flatMap((request) => request.sourceModuleIds),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    } satisfies GroupedRegionBundleRequest;
    groupedRequests.push(groupedRequest);
    for (const request of bucketRequests) {
      requestGroupKeyByTarget.set(
        `${request.regionKey}\u0000${request.targetFilePath}`,
        groupedRequestKey,
      );
    }
  }

  return { groupedRequests, requestGroupKeyByTarget };
}

export function canCombineBundleRequests(requests: RegionBundleRequest[]) {
  const exportedNames = new Set<string>();
  let exportedDefaultCount = 0;

  for (const request of requests) {
    const willExportDefault =
      request.hasDefaultExport &&
      (request.needsDefault || request.needsExportAll);
    if (willExportDefault) {
      exportedDefaultCount += 1;
      if (exportedDefaultCount > 1) {
        return false;
      }
    }

    const namesToExport = request.needsExportAll
      ? request.exportedNames
      : [...request.usedNamedExports];
    for (const exportedName of namesToExport) {
      if (exportedName === "default") {
        continue;
      }
      if (exportedNames.has(exportedName)) {
        return false;
      }
      exportedNames.add(exportedName);
    }
  }

  return true;
}

export function resolveEntryOutputsByRequest(input: {
  bundleSrcDir: string;
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  outputSrcDir: string;
  writtenRequests: WrittenRegionBundleRequest[];
}) {
  const requestKeyByEntryPoint = new Map(
    input.writtenRequests.map((request) => [
      normalizePath(request.entryPoint),
      request.requestKey,
    ]),
  );
  const outputByRequestKey = new Map<string, string>();
  for (const [outputPath, metadata] of Object.entries(input.metafile.outputs)) {
    if (!metadata.entryPoint) {
      continue;
    }
    const requestKey = requestKeyByEntryPoint.get(
      normalizePath(path.resolve(input.bundleSrcDir, metadata.entryPoint)),
    );
    if (!requestKey) {
      continue;
    }
    outputByRequestKey.set(
      requestKey,
      normalizePath(path.resolve(input.outputSrcDir, outputPath)),
    );
  }
  return outputByRequestKey;
}

export function sanitizeEntryName(request: GroupedRegionBundleRequest) {
  if (request.requests.length === 1) {
    const sourceId =
      request.requests[0]?.sourceModuleIds[0] ??
      request.requests[0]?.targetFilePath;
    return path
      .basename(sourceId ?? "bundle")
      .replace(/\.[^/.]+$/u, "")
      .replace(/[^\w.-]+/gu, "-");
  }

  return classifyModuleId(
    request.sourceModuleIds[0] ?? "bundle",
    "bundle",
  ).replace(/[^\w.-]+/gu, "-");
}

export function sanitizeRegionKey(regionKey: string) {
  if (regionKey === EAGER_REGION_LABEL) {
    return "eager";
  }
  return regionKey
    .split("|")
    .map((segment) => {
      if (segment.startsWith("dynamic:")) {
        return path
          .basename(segment.slice("dynamic:".length))
          .replace(/\.[^/.]+$/u, "");
      }
      return segment;
    })
    .join("__")
    .replace(/[^\w.-]+/gu, "-");
}

export function isPureLazyRegionKey(regionKey: string | undefined) {
  if (!regionKey) {
    return false;
  }
  return !regionKey.split("|").includes(EAGER_REGION_LABEL);
}
