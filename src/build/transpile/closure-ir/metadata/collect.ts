import ts from "@typescript/typescript6";

import { transpileDecoratedSource } from "../decorators";
import {
  buildClassMemberDoc,
  buildClassJsDoc,
  buildFunctionLikeDoc,
  buildFunctionJsDoc,
  buildInterfaceDeclarationSnippet,
  buildObjectMemberDoc,
  buildTypeAliasDeclarationSnippet,
  buildVariableJsDoc,
  getClassMemberName,
  getObjectPropertyName,
  hasStaticModifier,
} from "./docs";
import {
  canonicalSymbolId,
  createClosureDocRenderContext,
  referencesForTemplate,
} from "./type-render";
import { buildEnumDeclarationMetadata, isErasableConstEnum } from "./enums";
import type {
  ClosureAnnotation,
  ClosureEnumDeclaration,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
} from "../types";
import type { ClosureIrFileFeatures } from "./scan";

export function collectClosureIrFileMetadata({
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols,
}: {
  compilerOptions: ts.CompilerOptions;
  checker: ts.TypeChecker;
  features: ClosureIrFileFeatures;
  sourceFile: ts.SourceFile;
  unsafeEnumSymbols: Set<ts.Symbol>;
}): { diagnostics: ts.Diagnostic[]; file: ClosureTypeMetadataFile } {
  const diagnostics: ts.Diagnostic[] = [];
  const renderContext = createClosureDocRenderContext(sourceFile);
  const explicitTypeDeclarations = features.hasTypeDeclarations
    ? collectTypeDeclarationsForSourceFile(sourceFile, checker, renderContext)
    : [];
  const annotations = features.hasTopLevelDocs
    ? collectClosureDocsForSourceFile(
        sourceFile,
        checker,
        features,
        renderContext,
      )
    : [];
  const declarations = [
    ...explicitTypeDeclarations,
    ...renderContext.typeDeclarations,
  ];
  const { enumDeclarations, erasedConstEnums } = features.hasEnumDeclarations
    ? collectEnumDeclarationsForSourceFile(
        sourceFile,
        checker,
        unsafeEnumSymbols,
        compilerOptions,
      )
    : { enumDeclarations: [], erasedConstEnums: [] };
  for (const enumDeclaration of enumDeclarations) {
    if (!renderContext.symbolsById.has(enumDeclaration.symbolId)) {
      renderContext.symbolsById.set(enumDeclaration.symbolId, {
        diagnosticName: enumDeclaration.bindingName,
        id: enumDeclaration.symbolId,
        kind: "runtime",
        localName: enumDeclaration.bindingName,
      });
    }
  }
  const decoratedOutputText = features.hasDecorators
    ? collectDecoratedOutputText({
        compilerOptions,
        diagnostics,
        fileName: sourceFile.fileName,
        sourceText: sourceFile.getFullText(),
      })
    : undefined;

  return {
    diagnostics,
    file: {
      annotations,
      declarations,
      decoratedOutputText,
      diagnostics: renderContext.diagnostics,
      enums: enumDeclarations,
      erasedConstEnums,
      filePath: sourceFile.fileName,
      sourceFilePath: sourceFile.fileName,
      symbols: [...renderContext.symbolsById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
  };
}

function collectTypeDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
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

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      if (isFirstDeclarationOfSymbol(statement)) {
        typeDeclarations.push(
          buildInterfaceDeclarationSnippet(statement, checker, renderContext),
        );
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (isFirstDeclarationOfSymbol(statement)) {
        typeDeclarations.push(
          buildTypeAliasDeclarationSnippet(statement, checker, renderContext),
        );
      }
    }
  }

  return typeDeclarations;
}

function collectClosureDocsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  features: ClosureIrFileFeatures,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
) {
  const annotations: ClosureAnnotation[] = [];
  const pushAnnotation = (
    template: string,
    target: ClosureAnnotation["target"],
  ) => {
    annotations.push({
      references: referencesForTemplate(template, renderContext),
      target,
      template,
      typeBearing: hasTypeBearingTag(template),
    });
  };
  const shouldAnnotateJs =
    !features.docEligibility.isTypeScriptLike &&
    features.docEligibility.hasJsDocText;
  const shouldAnnotateTypeScript = features.docEligibility.isTypeScriptLike;

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const jsdoc = buildFunctionJsDoc(node, checker, renderContext);
        if (jsdoc) {
          pushAnnotation(jsdoc, {
            bindingName: node.name.text,
            kind: "binding",
          });
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const jsdoc = buildVariableJsDoc({
          checker,
          context: renderContext,
          initializer: node.initializer,
          typeNode: node.type,
        });
        if (jsdoc) {
          pushAnnotation(jsdoc, {
            bindingName: node.name.text,
            kind: "binding",
          });
        }
        if (
          node.initializer &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          for (const member of node.initializer.properties) {
            const memberName = getObjectPropertyName(member);
            if (!memberName) {
              continue;
            }
            const memberDoc = buildObjectMemberDoc({
              checker,
              context: renderContext,
              member,
            });
            if (memberDoc) {
              pushAnnotation(memberDoc, {
                kind: "member",
                memberKind: objectMemberKind(member),
                memberName,
                ownerBindingName: node.name.text,
                static: false,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const jsdoc = buildClassJsDoc(node, checker, renderContext);
      if (jsdoc) {
        pushAnnotation(jsdoc, {
          bindingName: className,
          kind: "binding",
        });
      }

      for (const member of node.members) {
        const memberName = getClassMemberName(member);
        if (!memberName) {
          continue;
        }
        const memberDoc = buildClassMemberDoc({
          checker,
          context: renderContext,
          member,
        });
        if (memberDoc) {
          pushAnnotation(memberDoc, {
            kind: "member",
            memberKind: classMemberKind(member),
            memberName,
            ownerBindingName: className,
            static: hasStaticModifier(member),
          });
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      !ts.isClassDeclaration(node.parent) &&
      !ts.isClassExpression(node.parent) &&
      !ts.isObjectLiteralExpression(node.parent) &&
      shouldAnnotateTypeScript
    ) {
      const name =
        "name" in node && node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : null;
      if (name) {
        const jsdoc = buildFunctionLikeDoc(node, checker, renderContext);
        if (jsdoc) {
          pushAnnotation(jsdoc, { bindingName: name, kind: "binding" });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return annotations;
}

function objectMemberKind(
  member: ts.ObjectLiteralElementLike,
): Extract<ClosureAnnotation["target"], { kind: "member" }>["memberKind"] {
  if (ts.isGetAccessorDeclaration(member)) return "getter";
  if (ts.isSetAccessorDeclaration(member)) return "setter";
  if (ts.isMethodDeclaration(member)) return "method";
  return "field";
}

function classMemberKind(
  member: ts.ClassElement,
): Extract<ClosureAnnotation["target"], { kind: "member" }>["memberKind"] {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  if (ts.isGetAccessorDeclaration(member)) return "getter";
  if (ts.isSetAccessorDeclaration(member)) return "setter";
  if (ts.isPropertyDeclaration(member)) return "field";
  return "method";
}

function collectEnumDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
  compilerOptions: ts.CompilerOptions,
) {
  const enumDeclarations: ClosureEnumDeclaration[] = [];
  const erasedConstEnums: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isEnumDeclaration(statement)) {
      continue;
    }

    if (isErasableConstEnum(statement, compilerOptions)) {
      // Name only: there is nothing to emit. The declaration is dropped from
      // the module and every read was already inlined from the TypeScript AST.
      erasedConstEnums.push(statement.name.text);
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

  return { enumDeclarations, erasedConstEnums };
}

function collectDecoratedOutputText({
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

function hasTypeBearingTag(template: string) {
  return /@(constructor|enum|extends|implements|param|return|template|this|type|typedef)\b/u.test(
    template,
  );
}
