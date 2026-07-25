import path from "path";
import ts from "typescript";

import { resolveGraph } from "../../native/load";
import { loadCompilerOptions } from "../transpile/compiler-options";
import type { PackageAlias } from "../types";
import { uniqueSortedStrings } from "../../shared/files";
import { createBundleRequire } from "../../shared/bundle-location";

const require = createBundleRequire();

export interface TsxRuntimeSupport {
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  sourceFiles: string[];
  trackedFiles: string[];
}

export async function collectTsxRuntimeSupport({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<TsxRuntimeSupport> {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return emptyTsxRuntimeSupport();
  }

  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return emptyTsxRuntimeSupport();
  }

  const resolvedEntry = require.resolve(runtimeSpecifier, {
    paths: [workspaceDir],
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(
    resolvedEntry,
    workspaceDir,
  );
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: path.join(workspaceDir, "src"),
    workspaceDir,
  });

  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases,
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles,
    trackedFiles: graph.trackedFiles,
  };
}

export function mergePackageAliases(aliases: PackageAlias[]) {
  const merged = new Map<string, PackageAlias>();
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\0${alias.subpath}`, alias);
  }

  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\0${left.subpath}`;
    const rightKey = `${right.packageName}\0${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function mergeTsxRuntimeTrackedFiles(
  baseTrackedFiles: string[],
  runtimeTrackedFiles: string[],
) {
  return uniqueSortedStrings([...baseTrackedFiles, ...runtimeTrackedFiles]);
}

export function mergeRuntimePackageJsonFiles(
  packageJsonFiles: string[],
  runtimePackageJsonFiles: string[],
) {
  return uniqueSortedStrings([...packageJsonFiles, ...runtimePackageJsonFiles]);
}

function emptyTsxRuntimeSupport(): TsxRuntimeSupport {
  return {
    packageAliases: [],
    packageJsonFiles: [],
    sourceFiles: [],
    trackedFiles: [],
  };
}

function getJsxRuntimeSpecifier(compilerOptions: ts.CompilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case ts.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}

function toWorkspaceNodeModulesPath(
  resolvedPath: string,
  workspaceDir: string,
) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }

  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path.join(workspaceDir, relativeNodeModulesPath);
}

function toRuntimePackageAlias(
  specifier: string,
  targetPath: string,
): PackageAlias {
  const segments = specifier.split("/");
  const [firstSegment, secondSegment] = segments;
  if (firstSegment === undefined) {
    throw new Error(`Invalid runtime package specifier: ${specifier}`);
  }

  const scoped = specifier.startsWith("@");
  if (scoped && secondSegment === undefined) {
    throw new Error(`Invalid scoped runtime package specifier: ${specifier}`);
  }

  const packageName = scoped
    ? `${firstSegment}/${secondSegment}`
    : firstSegment;
  const subpathSegments = segments.slice(scoped ? 2 : 1);

  return {
    packageName,
    subpath:
      subpathSegments.length > 0 ? `./${subpathSegments.join("/")}` : ".",
    targetPath,
  };
}
