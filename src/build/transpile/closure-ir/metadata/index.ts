import ts from "@typescript/typescript6";

import {
  collectClassOnlyInterfaceSymbolIds,
  collectClosureIrFileMetadata,
} from "./collect";
import {
  collectExternalDeclarationOrigins,
  collectExternalOwnedMemberAccesses,
} from "./external-ownership";
import { collectUnsafeEnumSymbols } from "./enums";
import { scanClosureIrSourceFiles, type ClosureIrScanResult } from "./scan";
import { countTypeMetadata } from "../types";
import type {
  ClosureTypeMetadataFile,
  NativeTypeAnalysisResult,
  TypeMetadataTarget,
} from "../types";

export type TypeMetadataCollectionResult = NativeTypeAnalysisResult;

export function scanTypeMetadataFiles({
  fileNames,
  program,
}: {
  fileNames: string[];
  program: ts.Program;
}) {
  return scanClosureIrSourceFiles({ fileNames, program });
}

export function collectTypeMetadataFiles({
  boundaryModuleFileNames = [],
  compilerOptions,
  externalSpecifiers = [],
  fileNames,
  program,
  scan,
  targets,
}: {
  boundaryModuleFileNames?: string[] | undefined;
  compilerOptions: ts.CompilerOptions;
  externalSpecifiers?: string[] | undefined;
  fileNames: string[];
  program: ts.Program;
  scan?: ClosureIrScanResult;
  targets?: TypeMetadataTarget[] | undefined;
}): TypeMetadataCollectionResult {
  const effectiveTargets: TypeMetadataTarget[] =
    targets ??
    fileNames.map((filePath) => ({
      emitFilePath: filePath,
      sourceFilePath: filePath,
    }));
  const sourceFileNames = [
    ...new Set(effectiveTargets.map((target) => target.sourceFilePath)),
  ];
  const effectiveScan = scan
    ? filterScanToSources(scan, new Set(sourceFileNames))
    : scanTypeMetadataFiles({ fileNames: sourceFileNames, program });
  const files = effectiveScan.files.map(({ features, sourceFile }) => ({
    features,
    sourceFile,
  }));
  const needsChecker =
    boundaryModuleFileNames.length > 0 ||
    externalSpecifiers.length > 0 ||
    files.some(
      ({ features }) =>
        features.hasEnumDeclarations ||
        features.hasTopLevelDocs ||
        features.hasTypeDeclarations,
    );
  const hasDecorators = files.some(({ features }) => features.hasDecorators);
  const ambientGlobals = collectAmbientGlobalNames(program);
  if (!needsChecker && !hasDecorators) {
    const collectedFiles = effectiveTargets.map((target) => ({
      ...createEmptyMetadataFile(target),
      ambientGlobals,
    }));
    return buildCollectionResult([], collectedFiles, effectiveScan);
  }

  const checker = program.getTypeChecker();
  const classOnlyInterfaceSymbolIds = files.some(
    ({ features }) => features.hasTypeDeclarations,
  )
    ? collectClassOnlyInterfaceSymbolIds(program, checker)
    : new Set<string>();
  const externalOrigins = collectExternalDeclarationOrigins({
    boundaryModuleFileNames,
    externalSpecifiers: new Set(externalSpecifiers),
    program,
  });
  const unsafeEnumSymbols = effectiveScan.hasEnumDeclarations
    ? collectUnsafeEnumSymbols(
        effectiveScan.files
          .filter(({ features }) => features.hasEnumDeclarations)
          .map(({ sourceFile }) => sourceFile),
        checker,
      )
    : new Set<ts.Symbol>();
  const diagnostics: ts.Diagnostic[] = [];
  const collectedBySourcePath = new Map<string, ClosureTypeMetadataFile>();

  for (const { features, sourceFile } of files) {
    const externalOwnedMemberAccesses = collectExternalOwnedMemberAccesses({
      checker,
      origins: externalOrigins,
      sourceFile,
    });
    if (!features.shouldAnalyze) {
      collectedBySourcePath.set(sourceFile.fileName, {
        ...createEmptyMetadataFile({
          emitFilePath: sourceFile.fileName,
          sourceFilePath: sourceFile.fileName,
        }),
        externalOwnedMemberAccesses,
      });
      continue;
    }

    const result = collectClosureIrFileMetadata({
      classOnlyInterfaceSymbolIds,
      compilerOptions,
      checker,
      features,
      sourceFile,
      unsafeEnumSymbols,
    });
    diagnostics.push(...result.diagnostics);
    collectedBySourcePath.set(sourceFile.fileName, {
      ...result.file,
      externalOwnedMemberAccesses,
    });
  }

  const collectedFiles = effectiveTargets.map((target) => {
    const source = collectedBySourcePath.get(target.sourceFilePath);
    if (!source) {
      return { ...createEmptyMetadataFile(target), ambientGlobals };
    }
    return {
      ...source,
      ambientGlobals,
      filePath: target.emitFilePath,
      runtimeModuleId: target.runtimeModuleId,
      sourceFilePath: target.sourceFilePath,
    };
  });
  return buildCollectionResult(diagnostics, collectedFiles, effectiveScan);
}

function createEmptyMetadataFile(
  target: TypeMetadataTarget,
): ClosureTypeMetadataFile {
  return {
    annotations: [],
    declarations: [],
    decoratedOutputText: undefined,
    diagnostics: [],
    enums: [],
    externalOwnedMemberAccesses: [],
    filePath: target.emitFilePath,
    runtimeModuleId: target.runtimeModuleId,
    sourceFilePath: target.sourceFilePath,
    symbols: [],
  };
}

function buildCollectionResult(
  diagnostics: ts.Diagnostic[],
  files: ClosureTypeMetadataFile[],
  scan: ClosureIrScanResult,
): TypeMetadataCollectionResult {
  const extractedCounts = countTypeMetadata(files);
  return {
    diagnostics,
    extractedCounts,
    files,
    scan,
    typeMetadataDiagnostics: files.flatMap((file) => file.diagnostics),
  };
}

function filterScanToSources(
  scan: ClosureIrScanResult,
  sourceFileNames: ReadonlySet<string>,
): ClosureIrScanResult {
  const files = scan.files.filter(({ sourceFile }) =>
    sourceFileNames.has(sourceFile.fileName),
  );
  return {
    analyzedFileCount: files.filter(({ features }) => features.shouldAnalyze)
      .length,
    files,
    hasEnumDeclarations: files.some(
      ({ features }) => features.hasEnumDeclarations,
    ),
    scannedFileCount: files.length,
  };
}

/**
 * Globals introduced by ambient declaration files.
 *
 * An ambient `.d.ts` that nothing imports never enters the module graph — it
 * is picked up by the TypeScript *program*, not by an import edge — so the
 * native side cannot see it. Its declarations describe the environment the
 * bundle runs in, which per the boundary model makes them externs. Routing
 * them through the metadata channel is the only place both facts are known.
 *
 * General by construction: every ambient declaration in a non-module `.d.ts`,
 * no name list. Files with imports/exports are modules, whose declarations are
 * module-scoped rather than global.
 */
function collectAmbientGlobalNames(program: ts.Program): string[] {
  const names = new Set<string>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes("/node_modules/")) {
      continue;
    }
    // A *declaration* file that is a module describes the shape of an import:
    // `export declare const x` in `foo.d.ts` is a property of `foo`, not a
    // global, so its top-level declarations are module-scoped. It can still
    // augment global scope, but only through an explicit `declare global`
    // block — which is exactly why `declare global` requires a module.
    //
    // A `declare` in an ordinary `.ts` source is the opposite: it emits no
    // runtime binding, so a reference to it can only resolve from the
    // environment. Those are externs whether or not the file is a module.
    const moduleScoped =
      sourceFile.isDeclarationFile &&
      sourceFile.statements.some(
        (statement) =>
          ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement) ||
          ts.isExportAssignment(statement),
      );
    collectAmbientStatements(sourceFile.statements, names, moduleScoped, false);
  }
  return [...names].sort();
}

/**
 * Ambient value declarations that land in the global scope.
 *
 * `declare global { … }` augments the global scope and its members are
 * globals, so it recurses. `declare module "x" { … }` declares the shape of a
 * *module* — its members are reached by importing it and must never be pinned
 * as globals, so it is skipped. That distinction is the whole reason this walks
 * statements instead of asking the checker for global symbols.
 */
/**
 * Does this namespace contribute anything with a runtime representation?
 *
 * A type-only namespace (`declare namespace N { interface I {} }`) is never
 * read as a value, so declaring it would pin a name for nothing.
 */
function moduleDeclarationHasValues(statement: ts.ModuleDeclaration): boolean {
  const body = statement.body;
  if (!body) {
    return false;
  }
  if (ts.isModuleDeclaration(body)) {
    // `declare namespace A.B` parses as nested declarations.
    return moduleDeclarationHasValues(body);
  }
  if (!ts.isModuleBlock(body)) {
    return false;
  }
  return body.statements.some((inner) => {
    if (ts.isModuleDeclaration(inner)) {
      return moduleDeclarationHasValues(inner);
    }
    return (
      ts.isVariableStatement(inner) ||
      ts.isFunctionDeclaration(inner) ||
      ts.isClassDeclaration(inner) ||
      ts.isEnumDeclaration(inner)
    );
  });
}

function collectAmbientStatements(
  statements: ts.NodeArray<ts.Statement> | ts.Statement[],
  names: Set<string>,
  moduleScoped: boolean,
  /** Inside `declare global` the `declare` modifier is implicit. */
  implicitlyDeclared: boolean,
) {
  for (const statement of statements) {
    if (ts.isModuleDeclaration(statement)) {
      if (statement.name.kind === ts.SyntaxKind.StringLiteral) {
        // `declare module "x"`: an import target, reached by importing it.
        // Its members are never global.
        continue;
      }
      if (statement.name.text === "global") {
        if (statement.body && ts.isModuleBlock(statement.body)) {
          // Inside `declare global` everything is global, module or not.
          collectAmbientStatements(
            statement.body.statements,
            names,
            false,
            true,
          );
        }
        continue;
      }
      // `declare namespace X { … }` emits no runtime object, so any value read
      // through `X` must come from the environment. Only the root identifier
      // needs declaring: everything below it is a property of that object.
      // `declare namespace A.B.C` nests, so the outermost name is the root.
      const declared =
        implicitlyDeclared ||
        (ts.canHaveModifiers(statement)
          ? (ts.getModifiers(statement) ?? [])
          : []
        ).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
      if (declared && moduleDeclarationHasValues(statement)) {
        names.add(statement.name.text);
      }
      continue;
    }
    if (moduleScoped) {
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? [])
      : [];
    const declared =
      implicitlyDeclared ||
      modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      );
    if (!declared) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
}
