import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

import { restArgumentTypes } from "../shared/rest-parameters.ts";

import { collectTypeAliases, resolvesToUnknown } from "./no-unknown-type-aliases.ts";

import type { TypeAliasTable } from "./no-unknown-type-aliases.ts";

const DEFAULT_ALLOWED_NAMES: readonly string[] = ["cause"];

type OptionRecord = Record<string, Options[number]>;
type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterIdentifier(parameter: Parameter): string | null {
  if (parameter.type === "TSParameterProperty") {
    return parameterIdentifier(parameter.parameter);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterIdentifier(parameter.left);
  }
  if (parameter.type === "RestElement") {
    return parameterIdentifier(parameter.argument);
  }
  return parameter.type === "Identifier" ? parameter.name : null;
}

function parameterName(
  parameter: Parameter,
  annotation: ESTree.TSTypeAnnotation,
  sourceText: string,
): string {
  // A destructured parameter has no name, so quote its pattern without the annotation.
  return (
    parameterIdentifier(parameter) ?? sourceText.slice(0, annotation.start - parameter.start).trim()
  );
}

function isOptionRecord(option: Options[number] | undefined): option is OptionRecord {
  return typeof option === "object" && option !== null && !Array.isArray(option);
}

/** The default exemption holds until an explicit `allowedNames` array replaces it, empty included. */
function allowedParameterNames(options: Readonly<Options>): ReadonlySet<string> {
  const option = options[0];
  const configured = isOptionRecord(option) ? option.allowedNames : undefined;
  return Array.isArray(configured)
    ? new Set(configured.filter((name): name is string => typeof name === "string"))
    : new Set(DEFAULT_ALLOWED_NAMES);
}

/** Disallow unknown inputs except the parameter names the configuration exempts. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow function parameters whose type resolves to unknown, except the names listed in `allowedNames`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` resolves to `unknown`, and an unconstrained type parameter such as `<Value>(value: Value)` is the same unparsed input with extra steps. Name the domain type this parameter accepts, and run the expected schema or parser at the I/O boundary before calling this function.",
      unknownRestParameter:
        "Rest parameter `{{parameter}}` accepts an `unknown` at every position, so each argument arrives unparsed no matter how many there are. Name the domain type of a single argument, and run the expected schema or parser at the I/O boundary before calling this function.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedNames: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowedNames: ["cause"] }],
  },
  createOnce(context) {
    let aliases: TypeAliasTable = new Map();

    const checkParameters = (node: ParameterOwner) => {
      const allowedNames = allowedParameterNames(context.options);
      const shadowedNames = lexicalTypeParameterNames(node, context.sourceCode.visitorKeys);
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        const isRest = parameter.type === "RestElement";
        const accepted = isRest
          ? restArgumentTypes(annotation.typeAnnotation)
          : [annotation.typeAnnotation];
        if (!accepted.some((type) => resolvesToUnknown(type, { aliases, shadowedNames }))) continue;
        const name = parameterName(parameter, annotation, context.sourceCode.getText(parameter));
        if (allowedNames.has(name)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: isRest ? "unknownRestParameter" : "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      Program(node) {
        aliases = collectTypeAliases(node);
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
