import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

import { collectTypeAliases, resolvesToUnknown } from "./no-unknown-type-aliases.ts";

import type { TypeAliasTable, UnknownResolutionScope } from "./no-unknown-type-aliases.ts";

const AWAITED_WRAPPERS = new Set(["Promise", "PromiseLike"]);

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function awaitedValueType(reference: ESTree.TSTypeReference): ESTree.TSType | null {
  if (reference.typeName.type !== "Identifier") return null;
  if (!AWAITED_WRAPPERS.has(reference.typeName.name)) return null;
  return reference.typeArguments?.params[0] ?? null;
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract resolves to unknown, including `Promise<unknown>`.",
    },
    messages: {
      unknownReturn:
        "This function hands `unknown` back to its caller, and returning an unconstrained type parameter such as `<Value>(): Value` moves the same gap to the call site. Parse the value at the boundary that produces it, and return the named domain type that parsing establishes.",
    },
  },
  createOnce(context) {
    let aliases: TypeAliasTable = new Map();

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      const scope: UnknownResolutionScope = {
        aliases,
        // A type parameter named `Promise` is not the awaitable wrapper, so it is not unwrapped.
        shadowedNames: lexicalTypeParameterNames(node, context.sourceCode.visitorKeys),
        unwrapReference: awaitedValueType,
      };
      if (!resolvesToUnknown(annotation.typeAnnotation, scope)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        aliases = collectTypeAliases(node);
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
