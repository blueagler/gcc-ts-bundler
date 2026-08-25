import path from "node:path";
import { createHash } from "node:crypto";

import type { PluginContext, ViteBuildMetrics } from "../internal-types";

export type CapturedModuleResolution = Awaited<
  ReturnType<PluginContext["resolve"]>
>;
export type CapturedModuleResolutionCache = Map<
  string,
  Promise<CapturedModuleResolution>
>;

export function isDependencyModuleId(id: string) {
  return stripQuery(id).replace(/\\/g, "/").includes("/node_modules/");
}

export async function resolveCapturedSpecifier(
  this: PluginContext,
  input: {
    importerId: string;
    metrics?: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    specifier: string;
  },
) {
  const cacheKey = `${input.importerId}\u0000${input.specifier}`;
  let pendingResolution = input.resolutionCache.get(cacheKey);
  if (!pendingResolution) {
    // Bare package specifiers resolve identically for every importer in the
    // same directory, and most retained-graph edges are repeated package
    // imports (`svelte/internal/client` from dozens of modules).
    const directoryKey = isBarePackageSpecifier(input.specifier)
      ? `\u0001${path.dirname(stripQuery(input.importerId))}\u0000${input.specifier}`
      : null;
    if (directoryKey) {
      pendingResolution = input.resolutionCache.get(directoryKey);
    }
    if (!pendingResolution) {
      if (input.metrics) {
        input.metrics.retainedEdgeResolutionCount += 1;
      }
      pendingResolution = this.resolve(input.specifier, input.importerId, {
        skipSelf: true,
      });
      if (directoryKey) {
        input.resolutionCache.set(directoryKey, pendingResolution);
      }
    }
    input.resolutionCache.set(cacheKey, pendingResolution);
  }
  return await pendingResolution;
}

function isBarePackageSpecifier(specifier: string) {
  return (
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\u0000") &&
    !path.isAbsolute(specifier)
  );
}

export function isAuthoredModuleId(moduleId: string, projectRoot: string) {
  const cleanId = stripQuery(moduleId);
  if (cleanId.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  if (!path.isAbsolute(cleanId)) {
    return true;
  }
  return cleanId.startsWith(path.resolve(projectRoot) + path.sep);
}

export function classifyModuleId(moduleId: string, fallback = "app") {
  const cleanId = stripQuery(moduleId).replace(/\\/g, "/");
  const nodeModulesIndex = cleanId.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) {
    return fallback;
  }

  const packagePath = cleanId.slice(nodeModulesIndex + "/node_modules/".length);
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || fallback;
}

export function stripQuery(id: string) {
  return id.replace(/[?#].*$/u, "");
}

export function toMaterializedRelativePath(
  projectRoot: string,
  moduleId: string,
) {
  const cleanId = stripQuery(moduleId);
  const extension = path.extname(cleanId).replace(/^\./u, "");
  const queryHash =
    cleanId === moduleId
      ? ""
      : `__${hashText(toCanonicalModuleId(projectRoot, moduleId)).slice(0, 8)}`;

  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return path.posix.join(
      "__virtual__",
      `${sanitizeSegment(cleanId)}${queryHash}.js`,
    );
  }

  if (path.isAbsolute(cleanId) && cleanId.startsWith(projectRoot)) {
    const relative = path.relative(projectRoot, cleanId).replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`;
    }
    return `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`;
  }

  const nodeModulesIndex = cleanId.lastIndexOf(
    `${path.sep}node_modules${path.sep}`,
  );
  if (nodeModulesIndex >= 0) {
    const relative = cleanId
      .slice(nodeModulesIndex + `${path.sep}node_modules${path.sep}`.length)
      .replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return path.posix.join(
        "__deps__",
        `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`,
      );
    }
    return path.posix.join(
      "__deps__",
      `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`,
    );
  }

  return path.posix.join(
    "__modules__",
    `${sanitizeSegment(cleanId)}${queryHash}.js`,
  );
}

/**
 * Canonical, project-relative identity for a module id. Query-variant hash
 * suffixes in materialized file names must not encode the absolute project
 * location: those names flow into runtime module ids, chunk content, and the
 * manifest, so hashing the raw absolute id makes output bytes and chunk names
 * differ when the same project is built from two directories.
 */
function toCanonicalModuleId(projectRoot: string, moduleId: string) {
  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return moduleId;
  }
  const cleanId = stripQuery(moduleId);
  const query = moduleId.slice(cleanId.length);
  if (path.isAbsolute(cleanId) && cleanId.startsWith(projectRoot)) {
    return `${path.relative(projectRoot, cleanId).replace(/\\/g, "/")}${query}`;
  }
  const nodeModulesIndex = cleanId.lastIndexOf(
    `${path.sep}node_modules${path.sep}`,
  );
  if (nodeModulesIndex >= 0) {
    const relative = cleanId
      .slice(nodeModulesIndex + `${path.sep}node_modules${path.sep}`.length)
      .replace(/\\/g, "/");
    return `node_modules/${relative}${query}`;
  }
  // Outside the project root and not under node_modules: no stable relative
  // form exists, so the absolute id is the identity.
  return moduleId;
}

export function toRelativeImportSpecifier(fromFile: string, toFile: string) {
  const relativePath = path.relative(path.dirname(fromFile), toFile);
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function isSupportedExternalSpecifier(specifier: string) {
  return specifier.startsWith("node:");
}

function sanitizeSegment(value: string) {
  return value.replace(/[^\w./-]+/gu, "-").replace(/^-+/u, "");
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
