import ts from "@typescript/typescript6";

import { transpileDecoratedSource } from "../../decorators";
import { buildTypeDeclarationSnippet } from "../docs";
import {
  canonicalSymbolId,
  createClosureDocRenderContext,
} from "../type-render/index";
import { buildEnumDeclarationMetadata, isErasableConstEnum } from "../enums";
import { getClosureIrSyntaxIndex } from "../scan";
import type {
  ClosureEnumDeclaration,
  ClosureTypeDeclaration,
} from "../../types";

export function collectTypeDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
  classOnlyInterfaceSymbolIds: ReadonlySet<string>,
) {
  const typeDeclarations: ClosureTypeDeclaration[] = [];
  // One synthesised declaration per *merged symbol*, not per declaration site.
  // TypeScript lets a type be reopened (`declare interface Reopen` twice, an
  // interface merged with a namespace, a class merged with an interface), and
  // emitting a `function Name() {}` record per site produced duplicates that
  // Closure rejects outright with
  // JSC_BLOCK_SCOPED_DECL_MULTIPLY_DECLARED_ERROR. The checker already gives
  // us one symbol for all the sites, and `canonicalSymbolId` already reduces
  // that symbol to a stable identity, so the merge is decided by the same
  // identity the rest of the IR is keyed on rather than by name matching.
  const seenSymbolIds = new Set<string>();
  const isFirstDeclarationOfSymbol = (declaration: ts.NamedDeclaration) => {
    const symbol = declaration.name
      ? checker.getSymbolAtLocation(declaration.name)
      : undefined;
    if (!symbol) {
      return true;
    }
    const id = canonicalSymbolId(symbol);
    if (seenSymbolIds.has(id)) {
      return false;
    }
    seenSymbolIds.add(id);
    return true;
  };

  for (const statement of getClosureIrSyntaxIndex(sourceFile)
    .typeDeclarations) {
    if (isFirstDeclarationOfSymbol(statement)) {
      typeDeclarations.push(
        buildTypeDeclarationSnippet(
          statement,
          checker,
          renderContext,
          classOnlyInterfaceSymbolIds,
        ),
      );
    }
  }

  return typeDeclarations;
}

export function collectClassOnlyInterfaceSymbolIds(
  program: ts.Program,
  checker: ts.TypeChecker,
) {
  const implementedByAnnotatedClass = new Set<string>();
  const objectLiteralSatisfied = new Set<string>();

  const addInterfaceIdsFromType = (
    type: ts.Type | undefined,
    into: Set<string>,
  ) => {
    if (!type) {
      return;
    }
    try {
      if (type.isUnion()) {
        for (const part of type.types) {
          addInterfaceIdsFromType(part, into);
        }
        return;
      }
      const symbol = type.aliasSymbol ?? type.getSymbol();
      if (!symbol) {
        return;
      }
      const resolved =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      if (resolved.flags & ts.SymbolFlags.Interface) {
        into.add(canonicalSymbolId(resolved));
      }
    } catch {
      // Checker failure means we cannot prove class-only; keep @record.
    }
  };

  const isAnnotatedClass = (
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
  ) =>
    Boolean(node.name) &&
    !sourceFile.isDeclarationFile &&
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) === 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sourceFile)) {
      continue;
    }
    for (const node of getClosureIrSyntaxIndex(sourceFile).interfaceUses) {
      if (ts.isClassDeclaration(node) && isAnnotatedClass(node, sourceFile)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
            continue;
          }
          for (const typeNode of clause.types) {
            try {
              addInterfaceIdsFromType(
                checker.getTypeAtLocation(typeNode),
                implementedByAnnotatedClass,
              );
            } catch {
              // keep @record
            }
          }
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        try {
          addInterfaceIdsFromType(
            checker.getContextualType(node),
            objectLiteralSatisfied,
          );
        } catch {
          // keep @record
        }
      }

      if (
        (ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isSatisfiesExpression(node)) &&
        ts.isObjectLiteralExpression(node.expression)
      ) {
        try {
          addInterfaceIdsFromType(
            checker.getTypeFromTypeNode(node.type),
            objectLiteralSatisfied,
          );
        } catch {
          // keep @record
        }
      }
    }
  }

  const classOnly = new Set<string>();
  for (const id of implementedByAnnotatedClass) {
    if (!objectLiteralSatisfied.has(id)) {
      classOnly.add(id);
    }
  }
  return classOnly;
}

export function collectEnumDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
  compilerOptions: ts.CompilerOptions,
) {
  const enumDeclarations: ClosureEnumDeclaration[] = [];

  for (const statement of getClosureIrSyntaxIndex(sourceFile).enums) {
    if (isErasableConstEnum(statement, compilerOptions)) {
      continue;
    }

    const enumDeclaration = buildEnumDeclarationMetadata(
      statement,
      checker,
      unsafeEnumSymbols,
      compilerOptions,
    );
    if (enumDeclaration) {
      enumDeclarations.push(enumDeclaration);
    }
  }

  return enumDeclarations;
}

export function collectDecoratedOutputText({
  compilerOptions,
  diagnostics,
  fileName,
  sourceText,
}: {
  compilerOptions: ts.CompilerOptions;
  diagnostics: ts.Diagnostic[];
  fileName: string;
  sourceText: string;
}) {
  const transpiled = transpileDecoratedSource({
    compilerOptions,
    fileName,
    sourceText,
  });
  diagnostics.push(
    ...(transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
  );
  return transpiled.outputText;
}
