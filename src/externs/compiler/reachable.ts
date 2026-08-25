import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import {
  findPackageDir,
  isTypeSourceFile,
  isTypescriptLibFile,
} from "../shared";
import { isPlatformBuiltin, normalizeResolvedTypeFile } from "./target";

export async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies,
  onUnresolved,
}: {
  compilerOptions: ts.CompilerOptions;
  entryFiles: string[];
  includeDependencies: boolean;
  onUnresolved?: ((specifier: string, fromFile: string) => void) | undefined;
}) {
  const rootPackageDirs = new Set(
    entryFiles
      .map((filePath) => findPackageDir(filePath))
      .filter((packageDir): packageDir is string => packageDir !== null),
  );
  const allowPlatformTypePackages = entryFiles.some((filePath) =>
    isPlatformTypesPackageFile(filePath),
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
    if (
      !allowPlatformTypePackages &&
      isPlatformTypesPackageFile(resolvedFile)
    ) {
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
      if (isPlatformBuiltin(specifier)) {
        continue;
      }
      const resolvedModule = ts.resolveModuleName(
        specifier,
        resolvedFile,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolvedModule) {
        onUnresolved?.(specifier, resolvedFile);
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

      if (
        !allowPlatformTypePackages &&
        isPlatformTypesPackageFile(normalizedDependency)
      ) {
        continue;
      }

      queue.push(normalizedDependency);
    }

    // Declaration packages built from triple-slash directives
    // (`@types/jquery` is nothing but `/// <reference path=...>` lines)
    // reference no modules at all, so the import walk above never leaves
    // their entry file.
    for (const reference of sourceFile.referencedFiles) {
      const referencedFile = path.resolve(
        path.dirname(resolvedFile),
        reference.fileName,
      );
      if (
        !allowPlatformTypePackages &&
        isPlatformTypesPackageFile(referencedFile)
      ) {
        continue;
      }
      queue.push(referencedFile);
    }
    for (const reference of sourceFile.typeReferenceDirectives) {
      if (reference.fileName === "node" || reference.fileName === "bun") {
        continue;
      }
      const resolved = ts.resolveTypeReferenceDirective(
        reference.fileName,
        resolvedFile,
        compilerOptions,
        ts.sys,
      ).resolvedTypeReferenceDirective;
      const resolvedFileName = resolved?.resolvedFileName;
      if (!resolvedFileName || isTypescriptLibFile(resolvedFileName)) {
        continue;
      }
      if (!includeDependencies) {
        const referencePackageDir = findPackageDir(resolvedFileName);
        if (referencePackageDir && !rootPackageDirs.has(referencePackageDir)) {
          continue;
        }
      }
      if (
        !allowPlatformTypePackages &&
        isPlatformTypesPackageFile(resolvedFileName)
      ) {
        continue;
      }
      queue.push(resolvedFileName);
    }
  }

  return [...seen].sort((left, right) => left.localeCompare(right));
}

function isPlatformTypesPackageFile(filePath: string) {
  const normalized = path.resolve(filePath);
  return (
    normalized.includes(
      `${path.sep}node_modules${path.sep}@types${path.sep}node${path.sep}`,
    ) ||
    normalized.endsWith(
      `${path.sep}node_modules${path.sep}@types${path.sep}node`,
    ) ||
    normalized.includes(
      `${path.sep}node_modules${path.sep}bun-types${path.sep}`,
    ) ||
    normalized.endsWith(`${path.sep}node_modules${path.sep}bun-types`)
  );
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
