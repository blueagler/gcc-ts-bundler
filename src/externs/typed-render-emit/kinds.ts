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
import { diagnostic } from "../typed-render/shared";
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
  appendClassHeritageTags(
    lines,
    declarations[0]?.heritageClauses ?? [],
    state,
    module,
  );
  const parameterNames = renderFunctionParameterNames(constructors);
  appendSignatureTags(lines, constructors, parameterNames, state, module, true);
  lines.push(" */", `${name} = function(${parameterNames.join(", ")}) {};`);
  state.lines.push(...lines);
  emitClassMembers(name, declarations, state, module);
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
  appendInterfaceExtendsTags(lines, declarations, state, module);
  lines.push(" */", `${name} = function() {};`);
  state.lines.push(...lines);
  emitInterfaceMembers(name, declarations, state, module);
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

export function emitNamespaceMembers(
  name: string,
  symbol: ts.Symbol,
  state: RenderState,
  module: ModuleSeed,
) {
  for (const exported of state.checker.getExportsOfModule(symbol)) {
    // Merged namespaces share the export table with their class or enum.
    // Those primary declarations already emitted their own static members.
    if (
      exported.flags & (ts.SymbolFlags.Prototype | ts.SymbolFlags.EnumMember) ||
      exported.declarations?.some((declaration) =>
        ts.isClassDeclaration(declaration.parent),
      )
    )
      continue;
    const child = resolveAliasedSymbol(exported, state.checker);
    if (!child) continue;
    const childName = reserveSymbol(child, module, state);
    if (childName === undefined) continue;
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

function appendClassHeritageTags(
  lines: string[],
  heritage: readonly ts.HeritageClause[],
  state: RenderState,
  module: ModuleSeed,
) {
  for (const clause of heritage) {
    appendHeritageClauseTags(lines, clause, state, module);
  }
}

function appendHeritageClauseTags(
  lines: string[],
  clause: ts.HeritageClause,
  state: RenderState,
  module: ModuleSeed,
) {
  for (const item of clause.types) {
    appendHeritageTypeTag(lines, clause.token, item, state, module);
  }
}

function appendHeritageTypeTag(
  lines: string[],
  token: ts.SyntaxKind,
  item: ts.ExpressionWithTypeArguments,
  state: RenderState,
  module: ModuleSeed,
) {
  const type = renderType(state.checker.getTypeAtLocation(item), state, module);
  if (type === "?") return;
  const tag = token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
  lines.push(` * @${tag} {${type.replace(/^!/, "")}}`);
}

function emitClassMembers(
  name: string,
  declarations: readonly ts.ClassDeclaration[],
  state: RenderState,
  module: ModuleSeed,
) {
  const superclasses = superclassTypes(declarations, state);
  for (const declaration of declarations) {
    emitClassDeclarationMembers(name, declaration, superclasses, state, module);
  }
}

function emitClassDeclarationMembers(
  name: string,
  declaration: ts.ClassDeclaration,
  superclasses: readonly ts.Type[],
  state: RenderState,
  module: ModuleSeed,
) {
  for (const member of declaration.members) {
    emitClassMember(name, member, superclasses, state, module);
  }
}

function emitClassMember(
  name: string,
  member: ts.ClassElement,
  superclasses: readonly ts.Type[],
  state: RenderState,
  module: ModuleSeed,
) {
  if (isNonPublic(member) || ts.isConstructorDeclaration(member)) return;
  const memberName = propertyName(member.name);
  if (!memberName) return;
  const isStatic = hasStatic(member);
  const owner = isStatic ? name : `${name}.prototype`;
  const inherited = isStatic
    ? undefined
    : inheritedProperty(superclasses, memberName, state);
  emitMember(owner, memberName, member, state, module, inherited);
}

function appendInterfaceExtendsTags(
  lines: string[],
  declarations: readonly ts.InterfaceDeclaration[],
  state: RenderState,
  module: ModuleSeed,
) {
  // Declaration merging contributes the same base once per declaration, and a
  // repeated `@extends` on one block is a Closure parse error even though a
  // record may extend several distinct bases. First-seen order is the emitted
  // order, so deduping cannot reorder a block that had no repetition.
  const bases = new Set<string>();
  for (const declaration of declarations) {
    appendInterfaceDeclarationExtends(lines, declaration, bases, state, module);
  }
}

function appendInterfaceDeclarationExtends(
  lines: string[],
  declaration: ts.InterfaceDeclaration,
  bases: Set<string>,
  state: RenderState,
  module: ModuleSeed,
) {
  for (const clause of declaration.heritageClauses ?? []) {
    appendInterfaceClauseExtends(lines, clause, bases, state, module);
  }
}

function appendInterfaceClauseExtends(
  lines: string[],
  clause: ts.HeritageClause,
  bases: Set<string>,
  state: RenderState,
  module: ModuleSeed,
) {
  for (const item of clause.types) {
    appendFirstSeenExtendsTag(lines, item, bases, state, module);
  }
}

function appendFirstSeenExtendsTag(
  lines: string[],
  item: ts.ExpressionWithTypeArguments,
  bases: Set<string>,
  state: RenderState,
  module: ModuleSeed,
) {
  const type = renderType(state.checker.getTypeAtLocation(item), state, module);
  if (type === "?") return;
  const base = type.replace(/^!/, "");
  if (bases.has(base)) return;
  bases.add(base);
  lines.push(` * @extends {${base}}`);
}

function emitInterfaceMembers(
  name: string,
  declarations: readonly ts.InterfaceDeclaration[],
  state: RenderState,
  module: ModuleSeed,
) {
  for (const declaration of declarations) {
    emitInterfaceDeclarationMembers(name, declaration, state, module);
  }
}

function emitInterfaceDeclarationMembers(
  name: string,
  declaration: ts.InterfaceDeclaration,
  state: RenderState,
  module: ModuleSeed,
) {
  for (const member of declaration.members) {
    emitInterfaceMember(name, member, state, module);
  }
}

function emitInterfaceMember(
  name: string,
  member: ts.TypeElement,
  state: RenderState,
  module: ModuleSeed,
) {
  const memberName = propertyName(member.name);
  if (!memberName) return;
  emitMember(`${name}.prototype`, memberName, member, state, module);
}

type MemberRendering =
  | { kind: "method"; parameterNames: string[]; tags: string[] }
  | { kind: "property"; type: string };

function renderMemberTags(
  member: ts.TypeElement | ts.ClassElement,
  state: RenderState,
  module: ModuleSeed,
): MemberRendering {
  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    return renderMethodMember(member, state, module);
  }
  return renderPropertyMember(member, state, module);
}

function renderMethodMember(
  member: ts.MethodSignature | ts.MethodDeclaration,
  state: RenderState,
  module: ModuleSeed,
): MemberRendering {
  const symbol = member.name
    ? state.checker.getSymbolAtLocation(member.name)
    : undefined;
  const declarations = (symbol?.declarations ?? [member]).filter(
    isSignatureDeclaration,
  );
  const tags: string[] = [];
  appendTemplates(
    tags,
    declarations.flatMap((item) => [
      ...("typeParameters" in item ? (item.typeParameters ?? []) : []),
    ]),
  );
  const parameterNames = renderFunctionParameterNames(declarations);
  appendSignatureTags(tags, declarations, parameterNames, state, module, false);
  return { kind: "method", parameterNames, tags };
}

function renderPropertyMember(
  member: ts.TypeElement | ts.ClassElement,
  state: RenderState,
  module: ModuleSeed,
): MemberRendering {
  if (
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return {
      kind: "property",
      type: renderType(state.checker.getTypeAtLocation(member), state, module),
    };
  }
  const type = renderType(
    state.checker.getTypeAtLocation(member),
    state,
    module,
  );
  const optional = "questionToken" in member && member.questionToken;
  return {
    kind: "property",
    type: optional ? union([type, "undefined"]) : type,
  };
}

function emitMember(
  owner: string,
  name: string,
  member: ts.TypeElement | ts.ClassElement,
  state: RenderState,
  module: ModuleSeed,
  inherited?: ts.Symbol | undefined,
) {
  const reservationMark = state.pending.length;
  const dependencyMark = state.projection?.currentDependencies?.length;
  const rendering = renderMemberTags(member, state, module);
  if (inherited) {
    const base = renderInheritedMember(inherited, state, module);
    if (base && contradictsInherited(rendering, base)) {
      releaseReservations(state, reservationMark, dependencyMark);
      diagnostic(
        state,
        module,
        inherited,
        "inherited-member-mismatch",
        `Omitted ${propertyAccess(owner, name)}: it renders less precisely than the declaration it inherits.`,
      );
      return;
    }
  }
  if (rendering.kind === "method") {
    state.lines.push(
      "/**",
      ...rendering.tags,
      " */",
      `${propertyAccess(owner, name)} = function(${rendering.parameterNames.join(", ")}) {};`,
    );
    return;
  }
  state.lines.push(
    `/** @type {${rendering.type}} */`,
    `${propertyAccess(owner, name)};`,
  );
}

/**
 * Only the extends chain can hide a member. `getPropertyOfType` resolves
 * through the base's own bases, so one lookup per direct superclass covers the
 * whole chain without walking it here.
 */
function superclassTypes(
  declarations: readonly ts.ClassDeclaration[],
  state: RenderState,
) {
  const types: ts.Type[] = [];
  for (const declaration of declarations) {
    types.push(...classExtendsTypes(declaration, state));
  }
  return types;
}

function classExtendsTypes(
  declaration: ts.ClassDeclaration,
  state: RenderState,
) {
  const hasSuperclass = declaration.heritageClauses?.some(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  if (!hasSuperclass) return [];
  const symbol = declaration.name
    ? state.checker.getSymbolAtLocation(declaration.name)
    : undefined;
  if (!symbol) return [];
  return state.checker.getDeclaredTypeOfSymbol(symbol).getBaseTypes() ?? [];
}

function inheritedProperty(
  superclasses: readonly ts.Type[],
  name: string,
  state: RenderState,
) {
  for (const superclass of superclasses) {
    const property = state.checker.getPropertyOfType(superclass, name);
    if (property) return property;
  }
  return undefined;
}

/**
 * The inherited declaration is rendered only to be compared against, so every
 * effect of rendering it is undone: `renderType` reserves and queues the
 * symbols it references, counts degradations and files diagnostics, none of
 * which belong to a rendering that is thrown away.
 */
function renderInheritedMember(
  property: ts.Symbol,
  state: RenderState,
  module: ModuleSeed,
) {
  const declaration = (property.declarations ?? []).find(
    ts.isClassOrTypeElement,
  );
  if (!declaration) return undefined;
  const captured = captureRenderEffects(state);
  const rendering = renderMemberTags(declaration, state, module);
  revertRenderEffects(state, captured);
  return rendering;
}

type RenderEffectCapture = {
  reservationMark: number;
  dependencyMark: number | undefined;
  diagnosticMark: number;
  degradedMark: number;
  symbol: ts.Symbol | undefined;
  wasDegraded: boolean;
};

function captureRenderEffects(state: RenderState): RenderEffectCapture {
  const reservationMark = state.pending.length;
  const diagnosticMark = state.diagnostics.length;
  const degradedMark = state.degradedOccurrences;
  const symbol = state.currentSymbol;
  return {
    reservationMark,
    dependencyMark: state.projection?.currentDependencies?.length,
    diagnosticMark,
    degradedMark,
    symbol,
    wasDegraded: !symbol || state.degradedSymbols.has(symbol),
  };
}

function revertRenderEffects(
  state: RenderState,
  captured: RenderEffectCapture,
) {
  releaseReservations(state, captured.reservationMark, captured.dependencyMark);
  state.diagnostics.length = captured.diagnosticMark;
  state.degradedOccurrences = captured.degradedMark;
  if (captured.symbol && !captured.wasDegraded) {
    state.degradedSymbols.delete(captured.symbol);
  }
}

/**
 * `nameForSymbol` doubles as the "already queued" guard, so a discarded
 * rendering has to drop the names it reserved along with the queue entries: a
 * name left behind would be handed to a later reference while the symbol it
 * names is never emitted.
 */
function releaseReservations(
  state: RenderState,
  mark: number,
  dependencyMark: number | undefined,
) {
  // Dependencies are append-only during one symbol's emission. Truncating the
  // speculative suffix also removes edges to already-reserved symbols without
  // losing a real reference made earlier in that same symbol.
  const dependencies = state.projection?.currentDependencies;
  if (dependencies && dependencyMark !== undefined) {
    dependencies.length = dependencyMark;
  }
  for (const symbol of state.pending.splice(mark)) {
    state.moduleForSymbol.delete(symbol);
    state.nameForSymbol.delete(symbol);
    state.projection?.symbols.delete(symbol);
  }
}

/**
 * Closure checks a subclass member against the superclass declaration it hides,
 * so a member rendered less precisely than the inherited one contradicts it
 * (`JSC_HIDDEN_SUPERCLASS_PROPERTY_MISMATCH`). Only lost precision counts: a
 * subclass that restates or narrows what it inherits still carries its own
 * information and is emitted unchanged.
 */
function contradictsInherited(
  member: MemberRendering,
  inherited: MemberRendering,
) {
  if (member.kind === "property") {
    if (inherited.kind !== "property") return true;
    return lostPrecision(member.type, inherited.type);
  }
  if (inherited.kind !== "method") return true;
  return inheritedMethodLosesPrecision(member, inherited);
}

function inheritedMethodLosesPrecision(
  member: Extract<MemberRendering, { kind: "method" }>,
  inherited: Extract<MemberRendering, { kind: "method" }>,
) {
  const shared = Math.min(member.tags.length, inherited.tags.length);
  for (let index = 0; index < shared; index += 1) {
    if (lostPrecision(member.tags[index] ?? "", inherited.tags[index] ?? "")) {
      return true;
    }
  }
  return false;
}

/** A `?` atom, which `renderType` emits only where it gave up on a type. */
const UNTYPED = /(?<![\w$])\?(?![\w$])/u;

function lostPrecision(rendered: string, inherited: string) {
  if (rendered === inherited) return false;
  return UNTYPED.test(rendered) && !UNTYPED.test(inherited);
}

export function emitUnknown(name: string, state: RenderState) {
  state.lines.push("/** @type {?} */", `${name};`);
}
