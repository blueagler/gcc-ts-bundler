import path from "path";
import ts from "@typescript/typescript6";

import { getTargetDescriptor, type TargetName } from "../../api/targets";
import { DECLARATION_EXTENSIONS, isTypeSourceFile } from "../shared";

export type ResolvedModuleTypeEntry = {
  ambientModuleName?: string | undefined;
  declarationEntry: string;
  globalSurface?: string | undefined;
};

export async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  resolutionCache,
  resolutionHost = ts.sys,
  specifier,
  target = "browser",
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  resolutionCache?: ts.ModuleResolutionCache | undefined;
  resolutionHost?: ts.ModuleResolutionHost | undefined;
  specifier: string;
  target?: TargetName | undefined;
}): Promise<ResolvedModuleTypeEntry> {
  const targetEntry = resolveTargetDeclarationEntry({
    compilerOptions,
    projectRoot,
    resolutionHost,
    specifier,
    target,
  });
  if (targetEntry) return targetEntry;
  const containingFile = path.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    resolutionHost,
    resolutionCache,
  ).resolvedModule;
  const resolvedFromTypescript =
    resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return { declarationEntry: resolvedFromTypescript };
  }

  // The legacy node resolver must not reuse results from a different strategy.
  const fallbackCache = ts.createModuleResolutionCache(
    projectRoot,
    (fileName) => fileName,
    compilerOptions,
  );
  const fallbackResolution = ts.nodeModuleNameResolver(
    specifier,
    containingFile,
    compilerOptions,
    resolutionHost,
    fallbackCache,
  ).resolvedModule;
  const resolvedFromFallback =
    fallbackResolution &&
    normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return { declarationEntry: resolvedFromFallback };
  }

  throw new Error(
    `Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`,
  );
}

function resolveTargetDeclarationEntry({
  compilerOptions,
  projectRoot,
  resolutionHost,
  specifier,
  target,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  resolutionHost: ts.ModuleResolutionHost;
  specifier: string;
  target: TargetName;
}): ResolvedModuleTypeEntry | null {
  const descriptor = getTargetDescriptor(target);
  const containingFile = path.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolveRoot = (root: string) => {
    if (root === "lib.webworker") {
      const candidate = path.join(
        path.dirname(ts.getDefaultLibFilePath(compilerOptions)),
        "lib.webworker.d.ts",
      );
      return resolutionHost.fileExists(candidate) ? candidate : undefined;
    }
    return ts.resolveTypeReferenceDirective(
      root.replace(/^@types\//u, ""),
      containingFile,
      compilerOptions,
      resolutionHost,
    ).resolvedTypeReferenceDirective?.resolvedFileName;
  };
  const root = descriptor.ambientDeclarationRoots.find((candidate) => {
    if (candidate === "@types/node") {
      return specifier.startsWith("node:") || isNodeBuiltin(specifier);
    }
    if (candidate === "bun-types") {
      return specifier === "bun" || specifier.startsWith("bun:");
    }
    return specifier === target;
  });
  if (!root) return null;
  const declarationEntry = resolveRoot(root);
  if (!declarationEntry) return null;
  if (root === "@types/node" || (root === "bun-types" && specifier !== "bun")) {
    return {
      ambientModuleName: specifier,
      declarationEntry: path.resolve(declarationEntry),
    };
  }
  return {
    declarationEntry: path.resolve(declarationEntry),
    globalSurface: target,
  };
}

export function isNodeBuiltin(specifier: string) {
  return /^(?:assert|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$)/u.test(
    specifier,
  );
}

export function isPlatformBuiltin(specifier: string) {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
    specifier === "bun-types" ||
    isNodeBuiltin(specifier)
  );
}

export function normalizeResolvedTypeFile(resolvedFileName: string) {
  const normalizedPath = path.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }

  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (ts.sys.fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

function withTypeExtension(filePath: string, nextExtension: string) {
  if (
    filePath.endsWith(".d.ts") ||
    filePath.endsWith(".d.mts") ||
    filePath.endsWith(".d.cts")
  ) {
    return filePath;
  }

  const extension = path.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`;
}
