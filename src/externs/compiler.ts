import fs from "fs";
import path from "path";
import ts from "typescript";

import { loadCompilerOptions } from "../build/transpile/compiler-options";
import { hasErrorCode } from "../shared/validation";
import {
  DECLARATION_EXTENSIONS,
  findPackageDir,
  isRecoverableExternConfigError,
  isTypeSourceFile,
  isTypescriptLibFile,
  uniqueStrings,
} from "./shared";

export async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath,
}: {
  projectRoot: string;
  tsConfigPath: string | undefined;
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  } satisfies ts.CompilerOptions;
  const resolvedConfigPath =
    tsConfigPath ?? path.join(projectRoot, "tsconfig.json");
  try {
    await fs.promises.access(resolvedConfigPath, fs.constants.R_OK);
    try {
      return await loadCompilerOptions(resolvedConfigPath, {
        allowJs: true,
        rootDir: projectRoot,
      });
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  return fallbackOptions;
}

export async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  specifiers,
  tolerateMissing,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  specifiers: string[];
  tolerateMissing: boolean;
}) {
  const resolvedEntries: string[] = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(
        await resolveModuleTypeEntry({
          compilerOptions,
          projectRoot,
          specifier,
        }),
      );
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueStrings(resolvedEntries);
}

export function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir,
}: {
  entryFiles: string[];
  projectRoot: string;
  srcDir: string;
}) {
  return entryFiles.map((entry) => {
    if (path.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path.resolve(srcDir, entry);
    if (ts.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path.resolve(projectRoot, entry);
  });
}

export async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies,
}: {
  compilerOptions: ts.CompilerOptions;
  entryFiles: string[];
  includeDependencies: boolean;
}) {
  const rootPackageDirs = new Set(
    entryFiles
      .map((filePath) => findPackageDir(filePath))
      .filter((packageDir): packageDir is string => packageDir !== null),
  );
  const queue = [...entryFiles];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const nextFile = queue.shift();
    if (!nextFile) {
      continue;
    }
    const resolvedFile = path.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);

    const sourceText = await fs.promises.readFile(resolvedFile, "utf8");
    const sourceFile = ts.createSourceFile(
      resolvedFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = ts.resolveModuleName(
        specifier,
        resolvedFile,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolvedModule) {
        continue;
      }

      const normalizedDependency = normalizeResolvedTypeFile(
        resolvedModule.resolvedFileName,
      );
      if (!normalizedDependency || isTypescriptLibFile(normalizedDependency)) {
        continue;
      }

      if (!includeDependencies) {
        const dependencyPackageDir = findPackageDir(normalizedDependency);
        if (
          dependencyPackageDir &&
          !rootPackageDirs.has(dependencyPackageDir)
        ) {
          continue;
        }
      }

      queue.push(normalizedDependency);
    }
  }

  return [...seen].sort((left, right) => left.localeCompare(right));
}

async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  specifier,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  specifier: string;
}) {
  const containingFile = path.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  const resolvedFromTypescript =
    resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }

  const require = ts.createModuleResolutionCache(
    projectRoot,
    (fileName) => fileName,
    compilerOptions,
  );
  const fallbackResolution = ts.nodeModuleNameResolver(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
    require,
  ).resolvedModule;
  const resolvedFromFallback =
    fallbackResolution &&
    normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }

  throw new Error(
    `Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`,
  );
}

function normalizeResolvedTypeFile(resolvedFileName: string) {
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

function collectReferencedSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) {
      specifiers.add(value);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}
