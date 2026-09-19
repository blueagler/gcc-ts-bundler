import { existsSync } from "node:fs";
import path from "node:path";

import ts from "@typescript/typescript6";

import {
  collectReachableTypeFiles,
  loadExternCompilerOptions,
  resolveModuleTypeEntry,
} from "./compiler";
import { createExternAnalysisContext, type TypeWorld } from "./context";
import { findPackageDir, resolveAliasedSymbol } from "./shared";
import { logInternalDetail } from "../shared/timing";
import { isValueIdentifier } from "../shared/typescript";
import {
  renderTypedBoundaryDeclaration,
  renderTypedExternalDeclarations,
} from "./typed-render";

export interface RenderedAmbientGlobals {
  globalNames: string[];
  text: string;
}

export type NodeAmbientGlobalsRenderer = (
  jsFiles: readonly string[],
) => Promise<RenderedAmbientGlobals | null>;

interface NodeAmbientDiscovery {
  resolved: {
    compilerOptions: ts.CompilerOptions;
    declarationEntry: string;
    resolutionRoot: string;
  };
  scannedFiles: string[];
  declarationFiles: ReadonlySet<string>;
  collect: ((files: readonly string[]) => Set<string>) | undefined;
  renders: Map<string, RenderedAmbientGlobals>;
}

/** Owns discovery and exact-set renders for one compile invocation. */
export function createNodeAmbientGlobalsRenderer(input: {
  jsFiles: readonly string[];
  packageRoot: string;
  projectRoot: string;
  typeWorld?: TypeWorld | undefined;
}): NodeAmbientGlobalsRenderer {
  const typeWorld = input.typeWorld;
  // Resolve lazily so unused contexts neither reject nor load declarations.
  let context: Promise<NodeAmbientDiscovery | null> | undefined;
  async function discover(): Promise<NodeAmbientDiscovery | null> {
    const resolved = await resolveNodeDeclarationRoot(input);
    if (!resolved) return null;
    logInternalDetail(
      "externs:node-ambient-resolution",
      `root=${resolved.resolutionRoot} entry=${resolved.declarationEntry}`,
    );
    const scannedFiles = typeWorld
      ? collectTypeWorldNodeDeclarationFiles(
          typeWorld,
          resolved.declarationEntry,
        )
      : await collectReachableTypeFiles({
          compilerOptions: resolved.compilerOptions,
          entryFiles: [resolved.declarationEntry],
          includeDependencies: true,
        });
    const declarationFiles = new Set(
      scannedFiles.map((file) => path.resolve(file)),
    );
    return {
      resolved,
      scannedFiles,
      declarationFiles,
      collect: typeWorld
        ? createReferencedAmbientGlobalsCollector(
            typeWorld.program,
            typeWorld.checker,
            input.jsFiles,
            declarationFiles,
          )
        : undefined,
      renders: new Map<string, RenderedAmbientGlobals>(),
    };
  }
  return async (
    jsFiles: readonly string[],
  ): Promise<RenderedAmbientGlobals | null> => {
    const discovered = await (context ??= discover());
    if (!discovered) return null;
    const { resolved, scannedFiles, declarationFiles, collect, renders } =
      discovered;
    // Without a supplied world, retain the original per-job script binding.
    // Combining these roots could let a sibling job change global resolution.
    const analysis =
      typeWorld ??
      createExternAnalysisContext({
        appEntryFiles: [...jsFiles],
        compilerOptions: resolved.compilerOptions,
        projectRoot: resolved.resolutionRoot,
        scannedFiles,
      });
    const globalNames = collect
      ? collect(jsFiles)
      : collectReferencedAmbientGlobals(
          analysis.program,
          analysis.checker,
          jsFiles,
          declarationFiles,
        );
    logInternalDetail(
      "externs:node-ambient-scan",
      `inputs=${jsFiles.length} declarations=${declarationFiles.size} globals=${[...globalNames].sort().join(",")}`,
    );
    // Only identical semantic sets in the same checker may share rendered text.
    const key = JSON.stringify([...globalNames].sort());
    const cached = typeWorld ? renders.get(key) : undefined;
    if (cached) return cached;
    const rendered = renderAmbientGlobals(
      analysis,
      resolved,
      declarationFiles,
      globalNames,
    );
    if (typeWorld) renders.set(key, rendered);
    return rendered;
  };
}

function renderAmbientGlobals(
  analysis: Pick<TypeWorld, "checker" | "program">,
  resolved: { declarationEntry: string; resolutionRoot: string },
  declarationFiles: ReadonlySet<string>,
  globalNames: Set<string>,
): RenderedAmbientGlobals {
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
      const declarations = renderTypedBoundaryDeclaration(exported, name);
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

function collectTypeWorldNodeDeclarationFiles(
  typeWorld: TypeWorld,
  declarationEntry: string,
) {
  const nodePackageDir = findPackageDir(declarationEntry);
  if (!nodePackageDir) {
    return [path.resolve(declarationEntry)];
  }
  return typeWorld.program
    .getSourceFiles()
    .map((sourceFile) => path.resolve(sourceFile.fileName))
    .filter(
      (filePath) =>
        filePath === nodePackageDir ||
        filePath.startsWith(`${nodePackageDir}${path.sep}`),
    );
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
    collectAmbientGlobalNames(sourceFile, checker, declarationFiles, names);
  }
  return names;
}

function createReferencedAmbientGlobalsCollector(
  program: ts.Program,
  checker: ts.TypeChecker,
  jsFiles: readonly string[],
  declarationFiles: ReadonlySet<string>,
) {
  const emittedFiles = [...new Set(jsFiles)].filter(
    (filePath) => !program.getSourceFile(path.resolve(filePath)),
  );
  // Bind emitted inputs without loading another declaration/type world. Each
  // Closure module has its own lexical scope; a sibling's local `process`
  // must not hide a genuine Node global in this one.
  const emittedProgram = emittedFiles.length
    ? ts.createProgram(emittedFiles, {
        allowJs: true,
        moduleDetection: ts.ModuleDetectionKind.Force,
        noLib: true,
        noResolve: true,
        target: ts.ScriptTarget.Latest,
      })
    : undefined;
  const emittedChecker = emittedProgram?.getTypeChecker();
  // Only the declaration world's location-independent candidates are reusable.
  // Emitted lexical bindings remain owned by their checker and reference site.
  const nodeCandidates = new Map<string, ts.Symbol | null>();
  const namesByFile = new Map<string, ReadonlySet<string>>();
  function collectFile(filePath: string) {
    const cached = namesByFile.get(filePath);
    if (cached) return cached;
    const names = new Set<string>();
    const sourceFile = program.getSourceFile(path.resolve(filePath));
    if (sourceFile) {
      collectAmbientGlobalNames(sourceFile, checker, declarationFiles, names);
      namesByFile.set(filePath, names);
      return names;
    }
    const parsed = emittedProgram?.getSourceFile(path.resolve(filePath));
    if (!parsed || !emittedChecker) {
      throw new Error(
        `Unable to analyze Closure input for Node globals: ${filePath}`,
      );
    }
    const closureModule = parsed.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isPropertyAccessExpression(statement.expression.expression) &&
        ts.isIdentifier(statement.expression.expression.expression) &&
        statement.expression.expression.expression.text === "goog" &&
        statement.expression.expression.name.text === "module",
    );
    visit(parsed, (node) => {
      if (!ts.isIdentifier(node) || !isValueIdentifier(node)) return;
      // `exports` is an implicit local in goog.module, not Node's CJS global.
      if (closureModule && node.text === "exports") return;
      let symbol = nodeCandidates.get(node.text);
      if (symbol === undefined) {
        const candidate = resolveAliasedSymbol(
          checker.resolveName(
            node.text,
            undefined,
            ts.SymbolFlags.Value,
            false,
          ),
          checker,
        );
        symbol = isDeclaredInFiles(candidate, declarationFiles)
          ? candidate
          : null;
        nodeCandidates.set(node.text, symbol);
      }
      if (!symbol) return;
      const local = emittedChecker.resolveName(
        node.text,
        node,
        ts.SymbolFlags.Value,
        false,
      );
      // Synthetic symbols without declarations do not establish lexical bindings.
      if (local?.declarations?.length) return;
      names.add(symbol.getName());
    });
    namesByFile.set(filePath, names);
    return names;
  }
  return (files: readonly string[]) => {
    const names = new Set<string>();
    for (const filePath of files) {
      for (const name of collectFile(filePath)) names.add(name);
    }
    return names;
  };
}

function collectAmbientGlobalNames(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declarationFiles: ReadonlySet<string>,
  names: Set<string>,
) {
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || !isValueIdentifier(node)) return;
    const symbol = resolveAliasedSymbol(
      checker.resolveName(node.text, node, ts.SymbolFlags.Value, false),
      checker,
    );
    if (isDeclaredInFiles(symbol, declarationFiles)) {
      names.add(symbol.getName());
    }
  });
}

function isDeclaredInFiles(
  symbol: ts.Symbol | null | undefined,
  declarationFiles: ReadonlySet<string>,
): symbol is ts.Symbol {
  return (
    symbol?.declarations?.some((declaration) =>
      declarationFiles.has(path.resolve(declaration.getSourceFile().fileName)),
    ) ?? false
  );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
