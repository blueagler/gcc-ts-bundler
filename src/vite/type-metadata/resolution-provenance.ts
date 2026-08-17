import fs from "node:fs/promises";
import path from "node:path";

import type { RuntimeResolutionIdentity } from "./types";

export async function resolveRuntimeResolutionIdentity(input: {
  conditions: readonly string[];
  importerModuleId: string;
  resolvedModuleId: string;
  specifier: string;
}): Promise<RuntimeResolutionIdentity | null> {
  const packageIdentity = parsePackageSpecifier(input.specifier);
  const runtimePath = input.resolvedModuleId.replace(/[?#].*$/u, "");
  if (
    !packageIdentity ||
    input.resolvedModuleId.startsWith("\0") ||
    input.resolvedModuleId.startsWith("virtual:") ||
    !path.isAbsolute(runtimePath)
  ) {
    return null;
  }

  const packageJsonPath = await findNearestPackageJson(runtimePath);
  if (!packageJsonPath) {
    return null;
  }
  const packageRoot = path.dirname(packageJsonPath);

  return {
    conditions: [...new Set(input.conditions)].sort((left, right) =>
      left.localeCompare(right),
    ),
    importerModuleId: input.importerModuleId,
    packageJsonPath: path.normalize(packageJsonPath),
    packageName: packageIdentity.packageName,
    packageRoot: path.normalize(packageRoot),
    packageSubpath: packageIdentity.packageSubpath,
    resolutionMode: "import",
    runtimeModuleId: input.resolvedModuleId,
    runtimePath: path.normalize(runtimePath),
    specifier: input.specifier,
  };
}

export function runtimeResolutionKey(resolution: RuntimeResolutionIdentity) {
  return [
    resolution.importerModuleId,
    resolution.specifier,
    resolution.runtimeModuleId,
  ].join("\0");
}

function parsePackageSpecifier(specifier: string) {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    path.isAbsolute(specifier)
  ) {
    return null;
  }
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? "");
  const packagePartCount = packageName.startsWith("@") ? 2 : 1;
  const subpath = parts.slice(packagePartCount).join("/");
  return {
    packageName,
    packageSubpath: subpath.length > 0 ? subpath : ".",
  };
}

async function findNearestPackageJson(filePath: string) {
  let current = path.dirname(filePath);
  while (path.dirname(current) !== current) {
    const packageJsonPath = path.join(current, "package.json");
    try {
      await fs.access(packageJsonPath);
      return packageJsonPath;
    } catch {
      current = path.dirname(current);
    }
  }
  return null;
}
