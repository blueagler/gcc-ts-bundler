import type { Definition, ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * Strips wrappers that leave the referenced value unchanged. Oxc represents `Reflect?.get(...)` as
 * a `ChainExpression` around the call whose member access carries `optional: true`, so the chain
 * wrapper has to come off before the member shape is inspected.
 */
function unwrapReference(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalBinding(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  name: string,
): boolean {
  if (expression.type !== "Identifier" || expression.name !== name) return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}

function isPropertyNamed(member: ESTree.MemberExpression, name: string): boolean {
  const property = member.property;
  return member.computed
    ? property.type === "Literal" && property.value === name
    : property.type === "Identifier" && property.name === name;
}

function isGlobalReflect(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const target = unwrapReference(expression);
  if (isGlobalBinding(sourceCode, target, "Reflect")) return true;
  if (target.type !== "MemberExpression") return false;
  return (
    isGlobalBinding(sourceCode, unwrapReference(target.object), "globalThis") &&
    isPropertyNamed(target, "Reflect")
  );
}

function isReflectMemberCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  const target = unwrapReference(callee);
  if (target.type !== "MemberExpression") return false;
  return isGlobalReflect(sourceCode, target.object) && isPropertyNamed(target, methodName);
}

function bindsPropertyNamed(
  pattern: ESTree.BindingPattern,
  bindingName: string,
  propertyName: string,
): boolean {
  if (pattern.type !== "ObjectPattern") return false;
  return pattern.properties.some((property) => {
    if (property.type !== "Property") return false;
    const value = property.value;
    if (value.type !== "Identifier" || value.name !== bindingName) return false;
    const key = property.key;
    return property.computed
      ? key.type === "Literal" && key.value === propertyName
      : key.type === "Identifier" && key.name === propertyName;
  });
}

function bindsGlobalReflectMethod(
  sourceCode: SourceCode,
  definition: Definition,
  bindingName: string,
  methodName: string,
): boolean {
  if (definition.type !== "Variable") return false;
  const declarator = definition.node;
  if (declarator.type !== "VariableDeclarator") return false;
  const initializer = declarator.init;
  if (initializer === null || !isGlobalReflect(sourceCode, initializer)) return false;
  return bindsPropertyNamed(declarator.id, bindingName, methodName);
}

/** Detects `const { get } = Reflect`, the same call with the member access moved. */
function isDestructuredReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  const target = unwrapReference(callee);
  if (target.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, target);
  if (variable === null) return false;
  return variable.defs.some((definition) =>
    bindsGlobalReflectMethod(sourceCode, definition, variable.name, methodName),
  );
}

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  return (
    isReflectMemberCall(sourceCode, callee, methodName) ||
    isDestructuredReflectMethodCall(sourceCode, callee, methodName)
  );
}
