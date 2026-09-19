import ts from "@typescript/typescript6";

import {
  countInternalWork,
  PROFILE_INTERNAL_TIMINGS,
} from "../../../../shared/timing";
import {
  classifyClosureIrDocEligibility,
  type ClosureIrDocEligibility,
} from "./doc-eligibility";

export interface ClosureIrFileFeatures {
  docEligibility: ClosureIrDocEligibility;
  hasDecorators: boolean;
  hasEnumDeclarations: boolean;
  needsSemanticPreflight: boolean;
  hasTopLevelDocs: boolean;
  hasTypeDeclarations: boolean;
  shouldAnalyze: boolean;
}

type AnnotationNode =
  | ts.FunctionDeclaration
  | ts.VariableDeclaration
  | ts.ClassDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

type InterfaceUseNode =
  | ts.ClassDeclaration
  | ts.ObjectLiteralExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression;

interface ClosureIrSyntaxIndex {
  annotationNodes: AnnotationNode[];
  docEligibility: ClosureIrDocEligibility & {
    hasTsCheckText: boolean;
    hasTopLevelDocs: boolean;
  };
  dynamicAccesses: ts.ElementAccessExpression[];
  enums: ts.EnumDeclaration[];
  hasDecorators: boolean;
  hasExplicitTypeSignals: boolean;
  interfaceUses: InterfaceUseNode[];
  objectLiterals: ts.ObjectLiteralExpression[];
  typeDeclarations: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[];
}

// Only immutable syntax is shared. Checker results remain local to each
// collection's Program/render context, even when a SourceFile is reused.
const syntaxIndexes = new WeakMap<ts.SourceFile, ClosureIrSyntaxIndex>();

export function getClosureIrSyntaxIndex(
  sourceFile: ts.SourceFile,
): ClosureIrSyntaxIndex {
  const cached = syntaxIndexes.get(sourceFile);
  if (cached) {
    return cached;
  }
  const index: ClosureIrSyntaxIndex = {
    annotationNodes: [],
    docEligibility: classifyClosureIrDocEligibility(sourceFile),
    dynamicAccesses: [],
    enums: [],
    hasDecorators: false,
    hasExplicitTypeSignals: false,
    interfaceUses: [],
    objectLiterals: [],
    typeDeclarations: [],
  };
  const mayHaveDecorators = sourceFile.text.includes("@");
  let visitedNodes = 0;
  let parent: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (PROFILE_INTERNAL_TIMINGS) visitedNodes += 1;
    if (
      !index.hasExplicitTypeSignals &&
      (ts.isEnumDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ("type" in node && !!node.type))
    ) {
      index.hasExplicitTypeSignals = true;
    }
    if (
      mayHaveDecorators &&
      !index.hasDecorators &&
      ts.canHaveDecorators(node) &&
      (ts.getDecorators(node)?.length ?? 0) > 0
    ) {
      index.hasDecorators = true;
    }
    if (parent === sourceFile) {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        index.typeDeclarations.push(node);
      } else if (ts.isEnumDeclaration(node)) {
        index.enums.push(node);
      }
    }
    // Each list is the original collector's pre-order subsequence. In
    // particular, nested declarations and literals must not be pruned.
    if (
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
      ((ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
        parent &&
        !ts.isClassDeclaration(parent) &&
        !ts.isClassExpression(parent) &&
        !ts.isObjectLiteralExpression(parent))
    ) {
      index.annotationNodes.push(node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      index.objectLiterals.push(node);
      index.interfaceUses.push(node);
    } else if (
      ts.isClassDeclaration(node) ||
      ((ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)) &&
        ts.isObjectLiteralExpression(node.expression))
    ) {
      index.interfaceUses.push(node);
    }
    if (ts.isElementAccessExpression(node)) {
      index.dynamicAccesses.push(node);
    }
    const previousParent = parent;
    parent = node;
    ts.forEachChild(node, visit);
    parent = previousParent;
  };
  visit(sourceFile);
  if (PROFILE_INTERNAL_TIMINGS) {
    countInternalWork("syntaxIndex.files", 1);
    countInternalWork("syntaxIndex.visitedNodes", visitedNodes);
    countInternalWork(
      "syntaxIndex.annotationCandidates",
      index.annotationNodes.length,
    );
    countInternalWork(
      "syntaxIndex.objectLiterals",
      index.objectLiterals.length,
    );
    countInternalWork("syntaxIndex.interfaceUses", index.interfaceUses.length);
    countInternalWork(
      "syntaxIndex.dynamicAccesses",
      index.dynamicAccesses.length,
    );
  }
  syntaxIndexes.set(sourceFile, index);
  return index;
}

export interface ClosureIrScanResult {
  analyzedFileCount: number;
  files: Array<{
    features: ClosureIrFileFeatures;
    sourceFile: ts.SourceFile;
  }>;
  hasEnumDeclarations: boolean;
  scannedFileCount: number;
}

export function scanClosureIrSourceFiles({
  fileNames,
  program,
}: {
  fileNames: string[];
  program: ts.Program;
}): ClosureIrScanResult {
  const inputFiles = new Set(fileNames);
  const files: ClosureIrScanResult["files"] = [];
  let analyzedFileCount = 0;
  let hasEnumDeclarations = false;

  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }

    const features = classifyClosureIrSourceFile(sourceFile);
    if (features.shouldAnalyze) {
      analyzedFileCount += 1;
    }
    if (features.hasEnumDeclarations) {
      hasEnumDeclarations = true;
    }

    files.push({ features, sourceFile });
  }

  return {
    analyzedFileCount,
    files,
    hasEnumDeclarations,
    scannedFileCount: files.length,
  };
}

export function classifyClosureIrSourceFile(
  sourceFile: ts.SourceFile,
): ClosureIrFileFeatures {
  const index = getClosureIrSyntaxIndex(sourceFile);
  const classified = index.docEligibility;
  const hasEnumDeclarations = index.enums.length > 0;
  const hasTypeDeclarations = index.typeDeclarations.length > 0;
  const hasExplicitTypeSignals = index.hasExplicitTypeSignals;
  const hasTypeDrivenClosureDocs =
    classified.isTypeScriptLike && hasExplicitTypeSignals;
  const hasDecorators = index.hasDecorators;
  const needsSemanticPreflight =
    classified.hasJsDocText ||
    classified.hasTsCheckText ||
    hasDecorators ||
    hasEnumDeclarations ||
    hasTypeDeclarations ||
    hasExplicitTypeSignals;
  const hasTopLevelDocs =
    classified.hasTopLevelDocs || hasTypeDrivenClosureDocs;

  return {
    docEligibility: {
      hasJsDocText: classified.hasJsDocText,
      isTypeScriptLike: classified.isTypeScriptLike,
    },
    hasDecorators,
    hasEnumDeclarations,
    needsSemanticPreflight,
    hasTopLevelDocs,
    hasTypeDeclarations,
    shouldAnalyze:
      hasDecorators ||
      hasEnumDeclarations ||
      hasTopLevelDocs ||
      hasTypeDeclarations,
  };
}
