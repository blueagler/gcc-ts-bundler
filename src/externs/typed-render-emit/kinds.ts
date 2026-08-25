import ts from "@typescript/typescript6";

import { resolveAliasedSymbol } from "../shared";
import { reserveSymbol } from "./reserve";
import {
  appendSignatureTags,
  appendTemplates,
  hasStatic,
  isNonPublic,
  isSignatureDeclaration,
  propertyAccess,
  propertyName,
  renderFunctionParameterNames,
  renderType,
  union,
} from "./type";
import type { ModuleSeed, RenderState } from "../typed-render";

export function emitClass(
  name: string,
  declarations: ts.ClassDeclaration[],
  state: RenderState,
  module: ModuleSeed,
) {
  const constructors = declarations.flatMap((declaration) =>
    declaration.members.filter(ts.isConstructorDeclaration),
  );
  const lines = ["/**", " * @constructor"];
  appendTemplates(
    lines,
    declarations.flatMap((item) => [...(item.typeParameters ?? [])]),
  );
  const heritage = declarations[0]?.heritageClauses ?? [];
  for (const clause of heritage) {
    for (const item of clause.types) {
      const type = renderType(
        state.checker.getTypeAtLocation(item),
        state,
        module,
      );
      if (type === "?") continue;
      lines.push(
        ` * @${clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} {${type.replace(/^!/, "")}}`,
      );
    }
  }
  const parameterNames = renderFunctionParameterNames(constructors);
  appendSignatureTags(lines, constructors, parameterNames, state, module, true);
  lines.push(" */", `${name} = function(${parameterNames.join(", ")}) {};`);
  state.lines.push(...lines);

  for (const declaration of declarations) {
    for (const member of declaration.members) {
      if (isNonPublic(member) || ts.isConstructorDeclaration(member)) continue;
      const memberName = propertyName(member.name);
      if (!memberName) continue;
      const owner = hasStatic(member) ? name : `${name}.prototype`;
      emitMember(owner, memberName, member, state, module);
    }
  }
}

export function emitInterface(
  name: string,
  declarations: ts.InterfaceDeclaration[],
  state: RenderState,
  module: ModuleSeed,
) {
  const lines = ["/**", " * @record"];
  appendTemplates(
    lines,
    declarations.flatMap((item) => [...(item.typeParameters ?? [])]),
  );
  for (const declaration of declarations) {
    for (const clause of declaration.heritageClauses ?? []) {
      for (const item of clause.types) {
        const type = renderType(
          state.checker.getTypeAtLocation(item),
          state,
          module,
        );
        if (type !== "?") lines.push(` * @extends {${type.replace(/^!/, "")}}`);
      }
    }
  }
  lines.push(" */", `${name} = function() {};`);
  state.lines.push(...lines);
  for (const declaration of declarations) {
    for (const member of declaration.members) {
      const memberName = propertyName(member.name);
      if (memberName)
        emitMember(`${name}.prototype`, memberName, member, state, module);
    }
  }
}

export function emitTypeAlias(
  name: string,
  declaration: ts.TypeAliasDeclaration | undefined,
  state: RenderState,
  module: ModuleSeed,
) {
  if (!declaration) return emitUnknown(name, state);
  const type = renderType(
    state.checker.getTypeFromTypeNode(declaration.type),
    state,
    module,
  );
  const lines = ["/**"];
  lines.push(` * @typedef {${type}}`, " */", `${name};`);
  state.lines.push(...lines);
}

export function emitEnum(
  name: string,
  declaration: ts.EnumDeclaration | undefined,
  state: RenderState,
) {
  if (!declaration) return emitUnknown(name, state);
  const values = declaration.members.map((member, index) => {
    const key = propertyName(member.name) ?? `member${index}`;
    const value =
      member.initializer &&
      (ts.isStringLiteralLike(member.initializer) ||
        ts.isNumericLiteral(member.initializer))
        ? member.initializer.getText()
        : String(index);
    return `${JSON.stringify(key)}: ${value}`;
  });
  const enumType = declaration.members.some(
    (member) =>
      member.initializer && ts.isStringLiteralLike(member.initializer),
  )
    ? "string"
    : "number";
  state.lines.push(
    `/** @enum {${enumType}} */`,
    `${name} = {${values.join(", ")}};`,
  );
}

export function emitFunction(
  name: string,
  symbol: ts.Symbol,
  state: RenderState,
  module: ModuleSeed,
) {
  const declarations = (symbol.declarations ?? []).filter(
    isSignatureDeclaration,
  );
  const lines = ["/**"];
  appendTemplates(
    lines,
    declarations.flatMap((item) => [
      ...("typeParameters" in item ? (item.typeParameters ?? []) : []),
    ]),
  );
  const parameterNames = renderFunctionParameterNames(declarations);
  appendSignatureTags(
    lines,
    declarations,
    parameterNames,
    state,
    module,
    false,
  );
  lines.push(" */", `${name} = function(${parameterNames.join(", ")}) {};`);
  state.lines.push(...lines);
}

export function emitNamespace(
  name: string,
  symbol: ts.Symbol,
  state: RenderState,
  module: ModuleSeed,
) {
  state.lines.push("/** @const */", `${name} = {};`);
  for (const exported of state.checker.getExportsOfModule(symbol)) {
    const child = resolveAliasedSymbol(exported, state.checker);
    if (!child) continue;
    const childName = reserveSymbol(child, module, state);
    state.lines.push(
      `${propertyAccess(name, exported.getName())} = ${childName};`,
    );
  }
}

export function emitValue(
  name: string,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  state: RenderState,
  module: ModuleSeed,
) {
  const type = renderType(
    state.checker.getTypeOfSymbolAtLocation(symbol, declaration),
    state,
    module,
  );
  state.lines.push(`/** @type {${type}} */`, `${name};`);
}

function emitMember(
  owner: string,
  name: string,
  member: ts.TypeElement | ts.ClassElement,
  state: RenderState,
  module: ModuleSeed,
) {
  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    const symbol = member.name
      ? state.checker.getSymbolAtLocation(member.name)
      : undefined;
    const declarations = (symbol?.declarations ?? [member]).filter(
      isSignatureDeclaration,
    );
    const lines = ["/**"];
    appendTemplates(
      lines,
      declarations.flatMap((item) => [
        ...("typeParameters" in item ? (item.typeParameters ?? []) : []),
      ]),
    );
    const parameterNames = renderFunctionParameterNames(declarations);
    appendSignatureTags(
      lines,
      declarations,
      parameterNames,
      state,
      module,
      false,
    );
    lines.push(
      " */",
      `${propertyAccess(owner, name)} = function(${parameterNames.join(", ")}) {};`,
    );
    state.lines.push(...lines);
    return;
  }
  if (
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    const type = renderType(
      state.checker.getTypeAtLocation(member),
      state,
      module,
    );
    state.lines.push(
      `/** @type {${type}} */`,
      `${propertyAccess(owner, name)};`,
    );
    return;
  }
  const type = renderType(
    state.checker.getTypeAtLocation(member),
    state,
    module,
  );
  const optional = "questionToken" in member && member.questionToken;
  state.lines.push(
    `/** @type {${optional ? union([type, "undefined"]) : type}} */`,
    `${propertyAccess(owner, name)};`,
  );
}

export function emitUnknown(name: string, state: RenderState) {
  state.lines.push("/** @type {?} */", `${name};`);
}
