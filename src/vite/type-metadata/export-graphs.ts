import path from "node:path";

import ts from "typescript";

import { canonicalSymbolId } from "../../build/transpile/closure-ir/metadata/type-render";
import { hashTypeMetadataValue } from "./cache";
import type {
  DeclarationExportFact,
  JoinedExportTypeFact,
  RuntimeExportFact,
  RuntimeExportTarget,
  TypeMetadataDiagnostic,
} from "./types";

export function collectDeclarationExportGraph(
  program: ts.Program,
  entryFilePath: string,
): DeclarationExportFact[] {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryFilePath);
  const moduleSymbol = sourceFile
    ? checker.getSymbolAtLocation(sourceFile)
    : undefined;
  if (!moduleSymbol) {
    return [];
  }

  const exports = checker.getExportsOfModule(moduleSymbol).flatMap((symbol) => {
    const exportName = normalizeDeclarationExportName(symbol.getName());
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (!declaration) {
      return [];
    }
    const fact = {
      declarationFilePath: path.normalize(declaration.getSourceFile().fileName),
      declarationId: hashTypeMetadataValue({
        filePath: path.normalize(declaration.getSourceFile().fileName),
        flags: target.flags,
        start: declaration.getStart(),
      }),
      declarationName: target.getName(),
      declarationStart: declaration.getStart(),
      exportName,
      hasRuntimeValue: (target.flags & ts.SymbolFlags.Value) !== 0,
      isTypeOnly: (target.flags & ts.SymbolFlags.Value) === 0,
      symbolId: canonicalSymbolId(target),
    } satisfies DeclarationExportFact;
    return exportName === "default" && symbol.getName() === "export="
      ? [fact, { ...fact, exportName: "__cjsExports" }]
      : [fact];
  });
  for (const statement of sourceFile?.statements ?? []) {
    if (!ts.isExportAssignment(statement) || !statement.isExportEquals) {
      continue;
    }
    const symbol = checker.getSymbolAtLocation(statement.expression);
    const declaration =
      symbol?.valueDeclaration ?? symbol?.declarations?.[0] ?? statement;
    const fact = {
      declarationFilePath: path.normalize(declaration.getSourceFile().fileName),
      declarationId: hashTypeMetadataValue({
        filePath: path.normalize(declaration.getSourceFile().fileName),
        flags: symbol?.flags ?? 0,
        start: declaration.getStart(),
      }),
      declarationName: symbol?.getName() ?? "export=",
      declarationStart: declaration.getStart(),
      exportName: "default",
      hasRuntimeValue: true,
      isTypeOnly: false,
      symbolId: symbol
        ? canonicalSymbolId(symbol)
        : hashTypeMetadataValue({
            filePath: path.normalize(declaration.getSourceFile().fileName),
            kind: "export=",
            start: declaration.getStart(),
          }),
    } satisfies DeclarationExportFact;
    exports.push(fact, { ...fact, exportName: "__cjsExports" });
  }

  return dedupeBy(
    exports,
    (fact) => `${fact.exportName}\0${fact.declarationId}`,
  ).sort((left, right) =>
    `${left.exportName}\0${left.declarationId}`.localeCompare(
      `${right.exportName}\0${right.declarationId}`,
    ),
  );
}

export function parseRuntimeExportGraph(
  moduleId: string,
  sourceText: string,
): RuntimeExportFact[] {
  const sourceFile = ts.createSourceFile(
    moduleId,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const facts: RuntimeExportFact[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      facts.push({
        exportName: "default",
        kind: "local",
        localName: ts.isIdentifier(statement.expression)
          ? statement.expression.text
          : undefined,
      });
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }
      const targetSpecifier =
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (!statement.exportClause) {
        if (targetSpecifier) {
          facts.push({ kind: "star", targetSpecifier });
        }
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        if (targetSpecifier) {
          facts.push({
            exportName: statement.exportClause.name.text,
            importedName: "*",
            kind: "reexport",
            targetSpecifier,
          });
        }
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const exportName = element.name.text;
        const importedName = (element.propertyName ?? element.name).text;
        facts.push(
          targetSpecifier
            ? { exportName, importedName, kind: "reexport", targetSpecifier }
            : { exportName, kind: "local", localName: importedName },
        );
      }
      continue;
    }
    if (hasExportModifier(statement)) {
      if (
        (ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement)) &&
        statement.name
      ) {
        facts.push({
          exportName: hasDefaultModifier(statement)
            ? "default"
            : statement.name.text,
          kind: "local",
          localName: statement.name.text,
        });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of collectBindingNames(declaration.name)) {
            facts.push({ exportName: name, kind: "local", localName: name });
          }
        }
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement)) {
      continue;
    }
    collectCommonJsExportFacts(statement.expression, facts);
  }

  return dedupeBy(facts, (fact) => JSON.stringify(fact));
}

export function resolveRuntimeExportGraph(input: {
  entryModuleId: string;
  modules: ReadonlyMap<string, string>;
  resolveModuleId?: (
    importerModuleId: string,
    specifier: string,
  ) => string | null;
}): {
  diagnostics: TypeMetadataDiagnostic[];
  exports: Map<string, RuntimeExportTarget>;
} {
  const parsed = new Map<string, RuntimeExportFact[]>();
  const diagnostics: TypeMetadataDiagnostic[] = [];
  const resolveModuleId =
    input.resolveModuleId ??
    ((importer, specifier) =>
      specifier.startsWith(".")
        ? path.normalize(path.resolve(path.dirname(importer), specifier))
        : null);
  const factsFor = (moduleId: string) => {
    const cached = parsed.get(moduleId);
    if (cached) {
      return cached;
    }
    const sourceText = input.modules.get(moduleId);
    const facts = sourceText
      ? parseRuntimeExportGraph(moduleId, sourceText)
      : [];
    parsed.set(moduleId, facts);
    return facts;
  };

  const namesFor = (moduleId: string, seen: Set<string>): Set<string> => {
    if (seen.has(moduleId)) {
      return new Set();
    }
    const nextSeen = new Set(seen).add(moduleId);
    const names = new Set(
      factsFor(moduleId).flatMap((fact) =>
        fact.exportName === undefined ? [] : [fact.exportName],
      ),
    );
    for (const fact of factsFor(moduleId)) {
      if (fact.kind !== "star" || !fact.targetSpecifier) {
        continue;
      }
      const target = resolveModuleId(moduleId, fact.targetSpecifier);
      if (!target) {
        continue;
      }
      for (const name of namesFor(target, nextSeen)) {
        if (name !== "default") {
          names.add(name);
        }
      }
    }
    return names;
  };

  const resolve = (
    moduleId: string,
    exportName: string,
    seen: Set<string>,
  ): RuntimeExportTarget | null => {
    const visitKey = `${moduleId}\0${exportName}`;
    if (seen.has(visitKey)) {
      return null;
    }
    const nextSeen = new Set(seen).add(visitKey);
    const direct = factsFor(moduleId).filter(
      (fact) => fact.exportName === exportName && fact.kind !== "star",
    );
    const targets = direct.flatMap((fact): RuntimeExportTarget[] => {
      if (fact.kind === "local" || fact.kind === "cjs") {
        return [
          {
            exportName,
            kind: fact.kind,
            localName: fact.localName,
            moduleId,
          },
        ];
      }
      if (!fact.targetSpecifier || !fact.importedName) {
        return [];
      }
      const targetModuleId = resolveModuleId(moduleId, fact.targetSpecifier);
      if (!targetModuleId || fact.importedName === "*") {
        return [];
      }
      const target = resolve(targetModuleId, fact.importedName, nextSeen);
      return target ? [{ ...target, exportName }] : [];
    });
    if (targets.length === 1) {
      return targets[0] ?? null;
    }
    if (targets.length > 1 && !allSameTarget(targets)) {
      diagnostics.push({
        exportName,
        reason: "ambiguous-runtime-export",
        runtimeModuleId: input.entryModuleId,
      });
      return null;
    }
    if (targets[0]) {
      return targets[0];
    }

    const starTargets = factsFor(moduleId).flatMap((fact) => {
      if (
        fact.kind !== "star" ||
        !fact.targetSpecifier ||
        exportName === "default"
      ) {
        return [];
      }
      const targetModuleId = resolveModuleId(moduleId, fact.targetSpecifier);
      const target = targetModuleId
        ? resolve(targetModuleId, exportName, nextSeen)
        : null;
      return target ? [target] : [];
    });
    if (starTargets.length === 1) {
      return starTargets[0] ?? null;
    }
    if (starTargets.length > 1 && !allSameTarget(starTargets)) {
      diagnostics.push({
        exportName,
        reason: "ambiguous-runtime-export",
        runtimeModuleId: input.entryModuleId,
      });
      return null;
    }
    return starTargets[0] ?? null;
  };

  const exports = new Map<string, RuntimeExportTarget>();
  for (const exportName of [
    ...namesFor(input.entryModuleId, new Set()),
  ].sort()) {
    const target = resolve(input.entryModuleId, exportName, new Set());
    if (target) {
      exports.set(exportName, target);
    }
  }
  return { diagnostics, exports };
}

export function joinDeclarationAndRuntimeExports(input: {
  declarationExports: readonly DeclarationExportFact[];
  runtimeExports: ReadonlyMap<string, RuntimeExportTarget>;
  runtimeModuleId: string;
}): {
  diagnostics: TypeMetadataDiagnostic[];
  facts: JoinedExportTypeFact[];
} {
  const diagnostics: TypeMetadataDiagnostic[] = [];
  const facts: JoinedExportTypeFact[] = [];
  for (const declaration of input.declarationExports) {
    if (declaration.isTypeOnly || !declaration.hasRuntimeValue) {
      continue;
    }
    const runtime = input.runtimeExports.get(declaration.exportName);
    if (!runtime) {
      diagnostics.push({
        exportName: declaration.exportName,
        reason: "declaration-runtime-export-mismatch",
        runtimeModuleId: input.runtimeModuleId,
      });
      continue;
    }
    facts.push({
      declaration,
      exportName: declaration.exportName,
      runtime,
      runtimeModuleId: input.runtimeModuleId,
    });
  }
  return { diagnostics, facts };
}

function collectCommonJsExportFacts(
  expression: ts.Expression,
  facts: RuntimeExportFact[],
) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return;
  }
  const exportName = commonJsExportName(expression.left);
  if (exportName === null) {
    return;
  }
  const localName = ts.isIdentifier(expression.right)
    ? expression.right.text
    : undefined;
  if (
    exportName === "default" &&
    ts.isObjectLiteralExpression(expression.right)
  ) {
    for (const property of expression.right.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        facts.push({
          exportName: property.name.text,
          kind: "cjs",
          localName: property.name.text,
        });
      } else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) ||
          ts.isStringLiteralLike(property.name))
      ) {
        facts.push({
          exportName: property.name.text,
          kind: "cjs",
          localName: ts.isIdentifier(property.initializer)
            ? property.initializer.text
            : undefined,
        });
      }
    }
  }
  facts.push({ exportName, kind: "cjs", localName });
  if (exportName === "default") {
    facts.push({ exportName: "__cjsExports", kind: "cjs", localName });
  }
}

function commonJsExportName(expression: ts.Expression): string | null {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "module" &&
    expression.name.text === "exports"
  ) {
    return "default";
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "exports"
  ) {
    return expression.name.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "module" &&
    expression.expression.name.text === "exports"
  ) {
    return expression.name.text;
  }
  return null;
}

function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : collectBindingNames(element.name),
  );
}

function hasExportModifier(node: ts.Node) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function hasDefaultModifier(node: ts.Node) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function normalizeDeclarationExportName(name: string) {
  return name === "export=" ? "default" : name;
}

function allSameTarget(targets: readonly RuntimeExportTarget[]) {
  const first = targets[0];
  return targets.every(
    (target) =>
      target.moduleId === first?.moduleId &&
      target.localName === first.localName &&
      target.kind === first.kind,
  );
}

function dedupeBy<T>(values: readonly T[], keyOf: (value: T) => string) {
  return [...new Map(values.map((value) => [keyOf(value), value])).values()];
}
