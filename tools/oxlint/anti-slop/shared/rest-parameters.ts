import type { ESTree } from "@oxlint/plugins";

const arrayTypeNames = new Set(["Array", "ReadonlyArray"]);

/**
 * The type each argument of a rest parameter takes. `...values: unknown[]` accepts an `unknown` at
 * every position, so the array that collects the arguments is not itself a contract for any of them,
 * and a rule that judges parameter types has to look through it.
 */
export function restArgumentTypes(type: ESTree.TSType): readonly ESTree.TSType[] {
  if (type.type === "TSParenthesizedType") return restArgumentTypes(type.typeAnnotation);
  if (type.type === "TSTypeOperator") {
    return type.operator === "readonly" ? restArgumentTypes(type.typeAnnotation) : [type];
  }
  if (type.type === "TSArrayType") return [type.elementType];
  if (type.type === "TSTupleType") return type.elementTypes.flatMap(tupleArgumentTypes);
  if (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    arrayTypeNames.has(type.typeName.name)
  ) {
    const element = type.typeArguments?.params.at(0);
    return element === undefined ? [type] : [element];
  }
  return [type];
}

/** A tuple names its positions individually, so each member is one argument unless it is a rest. */
function tupleArgumentTypes(member: ESTree.TSTupleElement): readonly ESTree.TSType[] {
  if (member.type === "TSNamedTupleMember") return tupleArgumentTypes(member.elementType);
  if (member.type === "TSOptionalType") return tupleArgumentTypes(member.typeAnnotation);
  if (member.type === "TSRestType") return restArgumentTypes(member.typeAnnotation);
  return [member];
}
