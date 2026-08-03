import { existsSync } from "node:fs";
import path from "node:path";

import ts from "@typescript/typescript6";

import {
  collectReachableTypeFiles,
  loadExternCompilerOptions,
  resolveModuleTypeEntry,
} from "./compiler";
import { createExternAnalysisContext } from "./context";
import { logInternalDetail } from "../shared/timing";
import { resolveAliasedSymbol } from "./shared";
import {
  renderTypedBoundaryDeclaration,
  renderTypedExternalDeclarations,
} from "./typed-render";

export interface RenderedAmbientGlobals {
  globalNames: string[];
  text: string;
}

export async function renderNodeAmbientGlobals(input: {
  jsFiles: readonly string[];
  packageRoot: string;
  projectRoot: string;
}): Promise<RenderedAmbientGlobals | null> {
  const resolved = await resolveNodeDeclarationRoot(input);
  if (!resolved) return null;

  logInternalDetail(
    "externs:node-ambient-resolution",
    `root=${resolved.resolutionRoot} entry=${resolved.declarationEntry}`,
  );
  const scannedFiles = await collectReachableTypeFiles({
    compilerOptions: resolved.compilerOptions,
    entryFiles: [resolved.declarationEntry],
    includeDependencies: true,
  });
  const analysis = createExternAnalysisContext({
    appEntryFiles: [...input.jsFiles],
    compilerOptions: resolved.compilerOptions,
    projectRoot: resolved.resolutionRoot,
    scannedFiles,
  });
  const declarationFiles = new Set(
    scannedFiles.map((file) => path.resolve(file)),
  );
  const globalNames = collectReferencedAmbientGlobals(
    analysis.program,
    analysis.checker,
    input.jsFiles,
    declarationFiles,
  );
  logInternalDetail(
    "externs:node-ambient-scan",
    `inputs=${input.jsFiles.length} declarations=${declarationFiles.size} globals=${[...globalNames].sort().join(",")}`,
  );
  if (globalNames.size === 0) {
    return { globalNames: [], text: "" };
  }

  const rendered = renderTypedExternalDeclarations({
    checker: analysis.checker,
    modules: [
      {
        declarationEntry: resolved.declarationEntry,
        globalDeclarationFiles: declarationFiles,
        globalSurface: "node",
        selectedExports: globalNames,
        specifier: "node:globals",
      },
    ],
    program: analysis.program,
    projectRoot: resolved.resolutionRoot,
  });
  const surface = rendered.globalSurfaces.find(
    (candidate) => candidate.name === "node",
  );
  const exportedByName = new Map(
    (surface?.exports ?? []).map((item) => [item.exportName, item]),
  );
  const missing = [...globalNames].filter((name) => !exportedByName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Unable to derive referenced Node globals from @types/node: ${missing.join(", ")}`,
    );
  }

  const boundaryLines = [...globalNames]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((name) => {
      const exported = exportedByName.get(name);
      if (!exported) return [];
      const declarations = renderTypedBoundaryDeclaration(
        rendered.text,
        exported.qualifiedName,
        name,
      );
      if (declarations.length === 0) {
        throw new Error(
          `Unable to materialize referenced Node global declaration: ${name}`,
        );
      }
      return declarations;
    });
  return {
    globalNames: [...globalNames].sort((left, right) =>
      left.localeCompare(right),
    ),
    text: `${rendered.text}\n// Exact Node ambient global boundaries.\n${boundaryLines.join("\n")}\n`,
  };
}

async function resolveNodeDeclarationRoot(input: {
  packageRoot: string;
  projectRoot: string;
}) {
  const resolutionRoots = [
    ...new Set([
      path.resolve(input.projectRoot),
      path.resolve(input.packageRoot),
    ]),
  ];
  const failures: unknown[] = [];
  for (const resolutionRoot of resolutionRoots) {
    const compilerOptions = await loadExternCompilerOptions({
      projectRoot: resolutionRoot,
      target: "node",
      tsConfigPath: undefined,
    });
    try {
      const declaration = await resolveModuleTypeEntry({
        compilerOptions,
        projectRoot: resolutionRoot,
        specifier: "node:process",
        target: "node",
      });
      return {
        compilerOptions,
        declarationEntry: declaration.declarationEntry,
        resolutionRoot,
      };
    } catch (error) {
      failures.push(error);
      logInternalDetail(
        "externs:node-ambient-resolution-failure",
        `root=${resolutionRoot} error=${String(error)}`,
      );
    }
  }
  const installedRoots = resolutionRoots.filter((resolutionRoot) =>
    existsSync(
      path.join(
        resolutionRoot,
        "node_modules",
        "@types",
        "node",
        "package.json",
      ),
    ),
  );
  if (installedRoots.length > 0) {
    throw new AggregateError(
      failures,
      `Unable to resolve installed @types/node from ${installedRoots.join(", ")}`,
    );
  }
  // A consumer that does not install @types/node can still build code that
  // references no Node globals; Closure remains the fail-closed backstop.
  return null;
}

function collectReferencedAmbientGlobals(
  program: ts.Program,
  checker: ts.TypeChecker,
  jsFiles: readonly string[],
  declarationFiles: ReadonlySet<string>,
) {
  const names = new Set<string>();
  for (const filePath of jsFiles) {
    const sourceFile = program.getSourceFile(path.resolve(filePath));
    if (!sourceFile) {
      throw new Error(
        `Unable to analyze Closure input for Node globals: ${filePath}`,
      );
    }
    visit(sourceFile, (node) => {
      if (!ts.isIdentifier(node) || !isValueIdentifier(node)) return;
      const symbol = resolveAliasedSymbol(
        checker.getSymbolAtLocation(node),
        checker,
      );
      if (
        symbol?.declarations?.some((declaration) =>
          declarationFiles.has(
            path.resolve(declaration.getSourceFile().fileName),
          ),
        )
      ) {
        names.add(symbol.getName());
      }
    });
  }
  return names;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function isValueIdentifier(node: ts.Identifier) {
  const parent = node.parent;
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isLabeledStatement(parent)
  );
}
