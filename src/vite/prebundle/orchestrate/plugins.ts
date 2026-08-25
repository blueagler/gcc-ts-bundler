import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin } from "esbuild";

import { normalizePath } from "../shared";

const AUTHORED_BOUNDARY_PREFIX = "gcc-authored:";

export function createSourceBoundaryPlugin(
  boundaryFiles: Set<string>,
  srcDir: string,
): Plugin | undefined {
  if (boundaryFiles.size === 0) return undefined;
  return {
    name: "gcc-ts-bundler-source-boundary",
    setup(build) {
      build.onResolve({ filter: /^(?:\.{1,2}\/|\/)/ }, (args) => {
        if (!args.importer) return undefined;
        const candidate = normalizePath(
          path.isAbsolute(args.path)
            ? args.path
            : path.resolve(path.dirname(args.importer), args.path),
        );
        if (!boundaryFiles.has(candidate)) return undefined;
        const relativePath = path
          .relative(srcDir, candidate)
          .replace(/\\/g, "/");
        return {
          external: true,
          path: `${AUTHORED_BOUNDARY_PREFIX}${encodeURIComponent(relativePath)}`,
        };
      });
    },
  };
}

export function rewriteAuthoredBoundarySpecifiers(input: {
  bundleOutputRoot: string;
  outputDir: string;
  outputFilePath: string;
  runtimeSrcDir: string;
  text: string;
}) {
  const relativeOutputPath = path.relative(
    input.bundleOutputRoot,
    input.outputFilePath,
  );
  const finalOutputPath = path.join(input.outputDir, relativeOutputPath);
  const rewritten = input.text.replace(
    /(["'])gcc-authored:([^"']+)\1/gu,
    (_match, quote: string, encodedPath: string) => {
      const targetPath = path.join(
        input.runtimeSrcDir,
        decodeURIComponent(encodedPath),
      );
      const relativeTarget = path
        .relative(path.dirname(finalOutputPath), targetPath)
        .replace(/\\/g, "/");
      const specifier = relativeTarget.startsWith(".")
        ? relativeTarget
        : `./${relativeTarget}`;
      return `${quote}${specifier}${quote}`;
    },
  );
  return rewritten
    .replace(
      /var __copyProps = \(to, from, except, desc\) =>/gu,
      "var __copyProps = (to, from, except = void 0, desc = void 0) =>",
    )
    .replace(/__getOwnPropNames\(from\)/gu, "__getOwnPropNames(from || {})");
}

export function createMaterializedDependencyResolverPlugin(
  sourceByMaterializedFile: Record<string, string> | undefined,
  boundaryFiles: Set<string>,
  srcDir: string,
): Plugin | undefined {
  if (!sourceByMaterializedFile) {
    return undefined;
  }
  const sourceByFile = new Map(
    Object.entries(sourceByMaterializedFile).map(([filePath, sourceFile]) => [
      normalizePath(filePath),
      normalizePath(sourceFile),
    ]),
  );
  if (sourceByFile.size === 0) {
    return undefined;
  }
  const materializedBySourceFile = new Map(
    [...sourceByFile].map(([materializedFile, sourceFile]) => [
      sourceFile,
      materializedFile,
    ]),
  );

  return {
    name: "gcc-ts-bundler-materialized-dependency-resolution",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isBarePackageSpecifier(args.path)) {
          return undefined;
        }
        const sourceFile = sourceByFile.get(normalizePath(args.importer));
        if (!sourceFile) {
          return undefined;
        }
        try {
          const resolvedSourceFile = normalizePath(
            createRequire(sourceFile).resolve(args.path),
          );
          // Keep a dependency already retained by Vite in the same esbuild
          // instance as the graph entry that imported it. Origin-context
          // resolution remains the fallback for true transitives such as
          // react-dom's scheduler under Bun's isolated store.
          const targetFilePath =
            materializedBySourceFile.get(resolvedSourceFile) ??
            resolvedSourceFile;
          // A bare edge that lands back on a module the native pipeline owns
          // must leave the bundle, or that module exists twice at runtime.
          return boundaryFiles.has(targetFilePath)
            ? {
                external: true,
                path: `${AUTHORED_BOUNDARY_PREFIX}${encodeURIComponent(
                  path.relative(srcDir, targetFilePath).replace(/\\/g, "/"),
                )}`,
              }
            : { path: targetFilePath };
        } catch {
          return undefined;
        }
      });
    },
  };
}

function isBarePackageSpecifier(specifier: string) {
  return (
    !specifier.startsWith(".") &&
    !path.isAbsolute(specifier) &&
    !specifier.includes(":")
  );
}
