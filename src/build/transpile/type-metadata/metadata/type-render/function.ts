import ts from "@typescript/typescript6";

import { firstOrUndefined } from "../../../../../shared/arrays";
import {
  sanitizeClosureName,
  stripUndefinedFromClosureType,
} from "../../../../../shared/closure-type-strings";
import type { ClosureDocRenderContext } from "./context";
import {
  getTypeArguments,
  isReadonlyArrayType,
  recordUnresolvedType,
  referenceBuiltin,
  safeTypeToString,
} from "./context";
import { toClosureType } from "./core";

export type FunctionLikeDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructorTypeNode
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.FunctionTypeNode
  | ts.GetAccessorDeclaration
  | ts.JSDocFunctionType
  | ts.MethodDeclaration
  | ts.MethodSignature
  | ts.SetAccessorDeclaration;

export type SignatureParamInfo = {
  name: string;
  optional: boolean;
  rest: boolean;
  thisParam: boolean;
  type: string;
};

const FUNCTION_LIKE_GUARDS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isArrowFunction,
  ts.isCallSignatureDeclaration,
  ts.isConstructorDeclaration,
  ts.isConstructorTypeNode,
  ts.isConstructSignatureDeclaration,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isFunctionTypeNode,
  ts.isGetAccessorDeclaration,
  ts.isJSDocFunctionType,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isSetAccessorDeclaration,
];

/**
 * Construct signature -> `function(new:T, params)`.
 *
 * The `new:` target carries **no** `!`: a nullability modifier there stops
 * Closure recognising the annotation as a constructor type at all. A `*`
 * return also degrades the whole atom, because a constructor must return an
 * ObjectType.
 */
export function constructSignatureToClosureType(
  signature: ts.Signature,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
) {
  const instanceType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    context,
    new Set(seen),
  );
  const target = instanceType.replace(/^[!?]/u, "");
  if (target === "*" || target === "" || instanceType === "?") {
    recordUnresolvedType(
      context,
      "unsupported-type-atom",
      signature.getReturnType(),
      checker,
    );
    return "?";
  }
  const declaration = signature.declaration;
  const params = isFunctionLikeDeclaration(declaration)
    ? collectSignatureParamInfos({ checker, context, declaration })
        .filter((parameter) => !parameter.thisParam)
        .map(
          (parameter) =>
            `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`,
        )
    : [];
  return `function(new:${target}${params.length > 0 ? `, ${params.join(", ")}` : ""})`;
}

export function signatureToClosureFunctionType(
  signature: ts.Signature,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen = new Set<ts.Type>(),
) {
  const declaration = signature.declaration;
  if (!isFunctionLikeDeclaration(declaration)) {
    return `!${referenceBuiltin("Function", context)}`;
  }
  // Closure has no generic *function types* — only generic declarations carry
  // `@template`. A bare `T` inside a function-type annotation resolves to
  // nothing, so a signature that introduces its own type parameters renders
  // them as `?` rather than leaking an unbound name.
  const ownTypeParameters = new Set(
    (signature.getTypeParameters() ?? []).map((parameter) => {
      const rendered = safeTypeToString(parameter, checker, context);
      return rendered ? sanitizeClosureName(rendered) : "?";
    }),
  );
  const paramInfos = collectSignatureParamInfos({
    checker,
    context,
    declaration,
  });
  // A `this` parameter lives in the declaration's parameter list but never in
  // the signature's parameter list, so it has to be recognised here and moved
  // into Closure's dedicated leading `this:` slot. Dropping it (what we used
  // to do) silently changed the arity contract of every `this`-typed callback.
  const thisParam = paramInfos.find((parameter) => parameter.thisParam);
  const params = paramInfos
    .filter((parameter) => !parameter.thisParam)
    .map(
      (parameter) =>
        `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`,
    );
  if (thisParam && thisParam.type !== "?") {
    params.unshift(`this:${thisParam.type}`);
  }
  const returnType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    context,
    new Set(seen),
    "type" in declaration ? declaration.type : undefined,
  );
  const erase = (rendered: string) =>
    ownTypeParameters.size === 0
      ? rendered
      : eraseTypeParameterNames(rendered, ownTypeParameters);
  return `function(${params.map(erase).join(", ")}): ${erase(returnType)}`;
}

/** Replaces whole-word occurrences of unbound type-parameter names with `?`. */
function eraseTypeParameterNames(rendered: string, names: ReadonlySet<string>) {
  return rendered.replace(/[A-Za-z_$][\w$]*/gu, (token) =>
    names.has(token) ? "?" : token,
  );
}

export function collectSignatureParamInfos({
  checker,
  context,
  declaration,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  declaration: FunctionLikeDeclaration;
}) {
  const parameters = getDeclarationParameters(declaration);
  return parameters.map((parameter, index): SignatureParamInfo => {
    const thisParam = isThisParameter(parameter);
    const rest = !!parameter.dotDotDotToken;
    const optional = !!parameter.questionToken || !!parameter.initializer;
    const name = parameterNameForJsDoc(parameter, index);
    const type = renderParameterType(parameter, checker, context, rest);
    return {
      name,
      optional,
      rest,
      thisParam,
      type,
    };
  });
}

function renderParameterType(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  rest: boolean,
) {
  const type = checker.getTypeAtLocation(parameter);
  if (!rest) {
    return toClosureType(type, checker, context, new Set(), parameter.type);
  }
  const elementType = getArrayElementType(type, checker);
  return elementType ? toClosureType(elementType, checker, context) : "?";
}

function getArrayElementType(type: ts.Type, checker: ts.TypeChecker) {
  if (!checker.isArrayType(type) && !isReadonlyArrayType(type)) {
    return null;
  }
  return firstOrUndefined(getTypeArguments(type, checker)) ?? null;
}

function isThisParameter(parameter: ts.ParameterDeclaration) {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

function getDeclarationParameters(declaration: FunctionLikeDeclaration) {
  return "parameters" in declaration ? declaration.parameters : [];
}

function parameterNameForJsDoc(
  declaration: ts.ParameterDeclaration | undefined,
  index: number,
) {
  if (declaration && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return `__param${index}`;
}

function isFunctionLikeDeclaration(
  declaration: ts.Node | undefined,
): declaration is FunctionLikeDeclaration {
  return (
    declaration !== undefined &&
    FUNCTION_LIKE_GUARDS.some((isFunctionLike) => isFunctionLike(declaration))
  );
}
