import fs from "fs";
import ts from "@typescript/typescript6";

import { getScriptKindForFile, isAssignmentOperator } from "../shared";
import {
  collectConstructedKeyFragments,
  collectConstructedKeyPrefix,
} from "./constructed-keys";
import { collectLiteralIndexedKeyReaders } from "./indexed-keys";
import { createKeyNameReader, isAssignmentTarget } from "./key-reader";
import { collectEnumeratedKeyNames } from "./literal-keys";
import {
  collectClassMemberDefinitions,
  collectKnownConstructorBindings,
  collectObjectLiteralDefinitions,
  collectProtocolHelperMembers,
  collectProvenFieldHelperNames,
  collectRuntimeAssignmentMembers,
  collectRuntimeCallMembers,
} from "./members";
import {
  addMember,
  createEmptyRuntimeHazards,
  type RuntimeProtocolHelpers,
  type RuntimeRenameHazards,
} from "./types";

export async function analyzeRuntimeUsage(
  runtimeEntryFiles: string[],
  protocolHelpers: RuntimeProtocolHelpers,
) {
  const hazards = createEmptyRuntimeHazards();

  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts.createSourceFile(
      runtimeEntryFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKindForFile(runtimeEntryFile),
    );
    collectFileHazards(sourceFile, hazards, protocolHelpers);
  }

  return hazards;
}

function collectFileHazards(
  sourceFile: ts.SourceFile,
  hazards: RuntimeRenameHazards,
  protocolHelpers: RuntimeProtocolHelpers,
) {
  const knownConstructors = collectKnownConstructorBindings(sourceFile);
  const provenFieldHelpers = collectProvenFieldHelperNames(sourceFile);
  const readKeyName = createKeyNameReader(sourceFile);
  collectLiteralIndexedKeyReaders(sourceFile, hazards);
  collectEnumeratedKeyNames(sourceFile, hazards);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      addMember(hazards.dotAccessed, node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      // Position matters here and only here: an `obj[…]` argument is a
      // property key by construction, so a literal piece of it is evidence
      // even though the whole key is not statically known.
      collectConstructedKeyFragments(node.argumentExpression, hazards);
      if (!isAssignmentTarget(node)) {
        addMember(
          hazards.stringLiteralRead,
          readKeyName(node.argumentExpression),
        );
      }
    } else if (ts.isTemplateExpression(node)) {
      collectConstructedKeyPrefix(node, hazards);
    } else if (ts.isBinaryExpression(node)) {
      if (isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, hazards);
      } else if (node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        addMember(hazards.stringLiteralRead, readKeyName(node.left));
      }
    } else if (ts.isCallExpression(node)) {
      collectProtocolHelperMembers(node, hazards, protocolHelpers);
      collectRuntimeCallMembers(
        node,
        knownConstructors,
        provenFieldHelpers,
        hazards,
      );
    } else if (ts.isClassLike(node)) {
      collectClassMemberDefinitions(node, hazards);
    } else if (ts.isObjectLiteralExpression(node)) {
      collectObjectLiteralDefinitions(node, hazards);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}
