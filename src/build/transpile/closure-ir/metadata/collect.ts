import ts from "typescript";

import { transpileDecoratedSource } from "../decorators";
import {
  buildClassMemberDoc,
  buildClassJsDoc,
  buildFunctionLikeDoc,
  buildFunctionJsDoc,
  buildFunctionObjectParamRecord,
  buildInterfaceDeclarationSnippet,
  buildObjectMemberDoc,
  buildTypeAliasDeclarationSnippet,
  buildVariableJsDoc,
  getClassMemberName,
  getObjectPropertyName,
  hasStaticModifier,
} from "./docs";
import { createClosureDocRenderContext } from "./type-render";
import { buildEnumDeclarationMetadata } from "./enums";
import type {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTypeDeclaration,
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
}): { diagnostics: ts.Diagnostic[]; file: ClosureIrFileMetadata } {
  const diagnostics: ts.Diagnostic[] = [];
  const renderContext = createClosureDocRenderContext(sourceFile);
  const explicitTypeDeclarations = features.hasTypeDeclarations
    ? collectTypeDeclarationsForSourceFile(sourceFile, checker, renderContext)
    : [];
  const topLevelDocs = features.hasTopLevelDocs
    ? collectClosureDocsForSourceFile(
        sourceFile,
        checker,
        features,
        renderContext,
      )
    : [];
  const typeDeclarations = [
    ...explicitTypeDeclarations,
    ...renderContext.typeDeclarations,
  ];
  const enumDeclarations = features.hasEnumDeclarations
    ? collectEnumDeclarationsForSourceFile(
        sourceFile,
        checker,
        unsafeEnumSymbols,
      )
    : [];
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
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations,
    },
  };
}

function collectTypeDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
) {
  const typeDeclarations: ClosureIrTypeDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      typeDeclarations.push(
        buildInterfaceDeclarationSnippet(statement, checker, renderContext),
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      typeDeclarations.push(
        buildTypeAliasDeclarationSnippet(statement, checker, renderContext),
      );
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
  const topLevelDocs: ClosureIrFileMetadata["topLevelDocs"] = [];
  const shouldAnnotateJs =
    !features.docEligibility.isTypeScriptLike &&
    features.docEligibility.hasJsDocText;
  const shouldAnnotateTypeScript = features.docEligibility.isTypeScriptLike;

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const objectParamRecord = buildFunctionObjectParamRecord(
          node,
          checker,
          renderContext,
        );
        const jsdoc = buildFunctionJsDoc(
          node,
          checker,
          renderContext,
          objectParamRecord?.typeName,
        );
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: node.name.text,
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
          topLevelDocs.push({
            jsdoc,
            kind: "variable",
            name: node.name.text,
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
              topLevelDocs.push({
                jsdoc: memberDoc,
                kind: objectDocKind(member),
                name: memberName,
                owner: node.name.text,
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
        topLevelDocs.push({
          jsdoc,
          kind: "class",
          name: className,
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
          topLevelDocs.push({
            jsdoc: memberDoc,
            kind: classDocKind(member),
            name: memberName,
            owner: className,
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
          topLevelDocs.push({
            jsdoc,
            kind: "method",
            name,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return topLevelDocs;
}

function objectDocKind(
  member: ts.ObjectLiteralElementLike,
): ClosureIrFileMetadata["topLevelDocs"][number]["kind"] {
  if (ts.isGetAccessorDeclaration(member)) return "objectGetter";
  if (ts.isSetAccessorDeclaration(member)) return "objectSetter";
  if (ts.isMethodDeclaration(member)) return "objectMethod";
  return "objectProperty";
}

function classDocKind(
  member: ts.ClassElement,
): ClosureIrFileMetadata["topLevelDocs"][number]["kind"] {
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
) {
  const enumDeclarations: ClosureIrEnumDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isEnumDeclaration(statement)) {
      continue;
    }

    const enumDeclaration = buildEnumDeclarationMetadata(
      statement,
      checker,
      unsafeEnumSymbols,
    );
    if (enumDeclaration) {
      enumDeclarations.push(enumDeclaration);
    }
  }

  return enumDeclarations;
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
