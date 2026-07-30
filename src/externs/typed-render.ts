import path from "node:path";
import ts from "typescript";

import { sanitizeClosureName } from "../build/transpile/closure-ir/metadata/closure-type-strings";
import { resolveAliasedSymbol } from "./shared";
import {
  renderRuntimeBridge,
  stableExternNamespace,
  stableSymbolName,
} from "./module-identity";
import type { ExternTypeDiagnostic, GeneratedExternModule } from "./types";

const BUILTINS = new Map([
  ["Array", "Array"],
  ["Date", "Date"],
  ["Error", "Error"],
  ["Function", "Function"],
  ["Iterable", "Iterable"],
  ["Iterator", "Iterator"],
  ["Map", "Map"],
  ["Object", "Object"],
  ["Promise", "Promise"],
  ["ReadonlyArray", "Array"],
  ["ReadonlyMap", "Map"],
  ["ReadonlySet", "Set"],
  ["Set", "Set"],
  ["WeakMap", "WeakMap"],
  ["WeakSet", "WeakSet"],
]);
const MAX_DEPTH = 24;
const MAX_PROPERTIES = 48;
const MAX_UNION = 16;

type ModuleSeed = {
  declarationEntry: string;
  selectedExports?: ReadonlySet<string> | undefined;
  specifier: string;
};
type RenderState = {
  checker: ts.TypeChecker;
  projectRoot?: string | undefined;
  diagnostics: ExternTypeDiagnostic[];
  emitted: Set<ts.Symbol>;
  lines: string[];
  moduleForSymbol: Map<ts.Symbol, ModuleSeed>;
  nameForSymbol: Map<ts.Symbol, string>;
  namespaces: Set<string>;
  pending: ts.Symbol[];
};

export function renderTypedExternalDeclarations({
  checker,
  modules,
  program,
  projectRoot,
}: {
  checker: ts.TypeChecker;
  modules: readonly ModuleSeed[];
  program: ts.Program;
  projectRoot?: string | undefined;
}): {
  diagnostics: ExternTypeDiagnostic[];
  moduleExports: GeneratedExternModule[];
  text: string;
} {
  const state: RenderState = {
    checker,
    projectRoot,
    diagnostics: [],
    emitted: new Set(),
    lines: [],
    moduleForSymbol: new Map(),
    nameForSymbol: new Map(),
    namespaces: new Set(),
    pending: [],
  };
  const moduleExports: GeneratedExternModule[] = [];

  for (const module of [...modules].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    const sourceFile = program.getSourceFile(
      path.resolve(module.declarationEntry),
    );
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!sourceFile || !moduleSymbol) {
      diagnostic(
        state,
        module,
        undefined,
        "module-symbol",
        "Declaration module has no TypeScript module symbol.",
      );
      continue;
    }
    const namespace = stableExternNamespace(
      module.specifier,
      module.declarationEntry,
      state.projectRoot,
    );
    state.namespaces.add(namespace);
    const exports = collectModuleExports(
      moduleSymbol,
      checker,
      module.selectedExports,
    )
      .map(({ exportName, symbol }) => ({
        exportName,
        qualifiedName: reserveSymbol(symbol, module, state),
      }))
      .sort((a, b) => a.exportName.localeCompare(b.exportName));
    moduleExports.push({
      declarationEntry: module.declarationEntry,
      exports,
      namespace,
      runtimeBridge: renderRuntimeBridge(module.specifier, namespace),
      specifier: module.specifier,
    });
  }

  while (state.pending.length > 0) {
    const symbol = state.pending.shift();
    if (!symbol || state.emitted.has(symbol)) continue;
    state.emitted.add(symbol);
    emitSymbol(symbol, state);
  }

  const header = [
    "/** @externs */",
    "// Owner-qualified declarations for runtimes outside this Closure job.",
    "// Runtime bridge snippets in moduleExports must be compiled, not passed as externs.",
    "",
    ...[...state.namespaces]
      .sort()
      .flatMap((namespace) => ["/** @const */", `var ${namespace} = {};`]),
    "",
  ];
  return {
    diagnostics: dedupeDiagnostics(state.diagnostics),
    moduleExports,
    text: [...header, ...state.lines, ""].join("\n"),
  };
}

function collectModuleExports(
  moduleSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  selectedExports?: ReadonlySet<string>,
) {
  const byName = new Map<string, ts.Symbol>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = resolveAliasedSymbol(exported, checker);
    if (symbol) byName.set(exported.getName(), symbol);
  }
  const exportEquals = moduleSymbol.exports?.get(
    ts.InternalSymbolName.ExportEquals,
  );
  const resolvedExportEquals = resolveAliasedSymbol(exportEquals, checker);
  if (resolvedExportEquals) byName.set("export=", resolvedExportEquals);
  if (selectedExports && !selectedExports.has("*")) {
    for (const exportName of byName.keys()) {
      if (!selectedExports.has(exportName)) byName.delete(exportName);
    }
  }
  return [...byName].map(([exportName, symbol]) => ({ exportName, symbol }));
}

function reserveSymbol(
  symbol: ts.Symbol,
  module: ModuleSeed,
  state: RenderState,
) {
  const current = state.nameForSymbol.get(symbol);
  if (current) return current;
  const namespace = stableExternNamespace(
    module.specifier,
    module.declarationEntry,
    state.projectRoot,
  );
  state.namespaces.add(namespace);
  const name = stableSymbolName(
    namespace,
    symbol,
    state.checker,
    state.projectRoot,
  );
  state.nameForSymbol.set(symbol, name);
  state.moduleForSymbol.set(symbol, module);
  state.pending.push(symbol);
  return name;
}

function emitSymbol(symbol: ts.Symbol, state: RenderState) {
  const name = state.nameForSymbol.get(symbol);
  const module = state.moduleForSymbol.get(symbol);
  if (!name || !module) return;
  const declarations = symbol.declarations ?? [];
  const declaration = declarations[0];
  if (!declaration) {
    emitUnknown(name, state);
    return;
  }
  if (symbol.flags & ts.SymbolFlags.Class) {
    emitClass(name, declarations.filter(ts.isClassDeclaration), state, module);
  } else if (symbol.flags & ts.SymbolFlags.Interface) {
    emitInterface(
      name,
      declarations.filter(ts.isInterfaceDeclaration),
      state,
      module,
    );
  } else if (symbol.flags & ts.SymbolFlags.TypeAlias) {
    emitTypeAlias(
      name,
      declarations.filter(ts.isTypeAliasDeclaration)[0],
      state,
      module,
    );
  } else if (symbol.flags & ts.SymbolFlags.Enum) {
    emitEnum(name, declarations.filter(ts.isEnumDeclaration)[0], state);
  } else if (symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method)) {
    emitFunction(name, symbol, state, module);
  } else if (
    symbol.flags &
    (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)
  ) {
    emitNamespace(name, symbol, state, module);
  } else {
    emitValue(name, symbol, declaration, state, module);
  }
}

function emitClass(
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
  appendSignatureTags(lines, constructors, state, module, true);
  lines.push(
    " */",
    `${name} = function(${renderFunctionParameterList(constructors)}) {};`,
  );
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

function emitInterface(
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

function emitTypeAlias(
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

function emitEnum(
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

function emitFunction(
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
  appendSignatureTags(lines, declarations, state, module, false);
  lines.push(
    " */",
    `${name} = function(${renderFunctionParameterList(declarations)}) {};`,
  );
  state.lines.push(...lines);
}

function emitNamespace(
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

function emitValue(
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
    appendSignatureTags(lines, declarations, state, module, false);
    lines.push(
      " */",
      `${propertyAccess(owner, name)} = function(${renderFunctionParameterList(declarations)}) {};`,
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

function renderFunctionParameterList(
  declarations: readonly ts.SignatureDeclaration[],
) {
  const maxParams = Math.max(
    0,
    ...declarations.map((item) => item.parameters.length),
  );
  return Array.from({ length: maxParams }, (_, index) => {
    const parameter = declarations.find((item) => item.parameters[index])
      ?.parameters[index];
    return parameter ? parameterName(parameter, index) : `param${index}`;
  }).join(", ");
}

function appendSignatureTags(
  lines: string[],
  declarations: readonly ts.SignatureDeclaration[],
  state: RenderState,
  module: ModuleSeed,
  constructor: boolean,
) {
  const signatures = declarations
    .map((declaration) => ({
      declaration,
      signature: state.checker.getSignatureFromDeclaration(declaration),
    }))
    .filter(
      (
        item,
      ): item is {
        declaration: ts.SignatureDeclaration;
        signature: ts.Signature;
      } => !!item.signature,
    );
  const maxParams = Math.max(
    0,
    ...signatures.map((item) => item.declaration.parameters.length),
  );
  for (let index = 0; index < maxParams; index += 1) {
    const params = signatures
      .map((item) => item.declaration.parameters[index])
      .filter((item): item is ts.ParameterDeclaration => !!item);
    if (params.length === 0) continue;
    const first = params[0];
    if (!first) continue;
    const rest = params.some((param) => !!param.dotDotDotToken);
    const optional =
      params.length < signatures.length ||
      params.some((param) => !!param.questionToken || !!param.initializer);
    const types = params.map((param) => {
      const type = state.checker.getTypeAtLocation(param);
      if (!rest) return renderType(type, state, module);
      const typeArguments = getTypeArguments(type, state.checker);
      return state.checker.isArrayType(type)
        ? renderType(typeArguments[0] ?? type, state, module)
        : "?";
    });
    lines.push(
      ` * @param {${rest ? "..." : ""}${union(types)}${optional && !rest ? "=" : ""}} ${parameterName(first, index)}`,
    );
  }
  if (!constructor && signatures.length > 0) {
    lines.push(
      ` * @return {${union(signatures.map((item) => renderType(state.checker.getReturnTypeOfSignature(item.signature), state, module)))}}`,
    );
  }
}

/**
 * `seen` is threaded from the caller and *must* stay threaded: a function type
 * is a recursion edge like any other, and React's `Dispatch<SetStateAction<S>>` /
 * `ReactNode` chains cycle through signatures. Resetting the guard here is what
 * previously turned `MAX_DEPTH` into a no-op and crashed the renderer with
 * `RangeError: Maximum call stack size exceeded` on real libraries.
 */
function renderFunctionType(
  signature: ts.Signature,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
) {
  const declaration = signature.declaration;
  if (!declaration || !("parameters" in declaration)) return "!Function";
  const params = [...declaration.parameters]
    .filter(ts.isParameter)
    .map((param) => {
      const type = renderType(
        state.checker.getTypeAtLocation(param),
        state,
        module,
        new Set(seen),
      );
      return `${param.dotDotDotToken ? "..." : ""}${type}${param.questionToken || param.initializer ? "=" : ""}`;
    });
  return `function(${params.join(", ")}): ${renderType(state.checker.getReturnTypeOfSignature(signature), state, module, new Set(seen))}`;
}

function renderType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen = new Set<ts.Type>(),
): string {
  if (seen.size > MAX_DEPTH || seen.has(type))
    return fallback(state, module, type, "recursive-or-deep-type");
  seen.add(type);
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  )
    return "?";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.TypeParameter)
    return sanitizeClosureName(state.checker.typeToString(type));
  if (
    type.flags &
    (ts.TypeFlags.Conditional |
      ts.TypeFlags.IndexedAccess |
      ts.TypeFlags.Substitution)
  ) {
    return fallback(state, module, type, "unsupported-type-operator");
  }
  if (type.isUnion()) {
    if (type.types.length > MAX_UNION)
      return fallback(state, module, type, "union-too-large");
    return union(
      type.types.map((item) => renderType(item, state, module, new Set(seen))),
    );
  }
  if (type.isIntersection()) return "!Object";
  if (state.checker.isArrayType(type) || state.checker.isTupleType(type)) {
    const args = getTypeArguments(type, state.checker);
    return `!Array<${args.length ? union(args.map((item) => renderType(item, state, module, new Set(seen)))) : "?"}>`;
  }
  const call = type.getCallSignatures()[0];
  if (call && type.getProperties().length === 0)
    return renderFunctionType(call, state, module, seen);
  const symbol = resolveAliasedSymbol(
    type.aliasSymbol ?? type.getSymbol(),
    state.checker,
  );
  if (symbol && symbol.getName() !== "__type") {
    const builtin = BUILTINS.get(symbol.getName());
    const args = isTypeReference(type)
      ? state.checker.getTypeArguments(type)
      : (type.aliasTypeArguments ?? []);
    if (builtin)
      return `!${builtin}${args.length ? `<${args.map((item) => renderType(item, state, module, new Set(seen))).join(", ")}>` : ""}`;
    if (
      (symbol.declarations ?? []).some(
        (item) => item.getSourceFile().isDeclarationFile,
      )
    ) {
      const name = reserveSymbol(symbol, module, state);
      return `!${name}${args.length ? `<${args.map((item) => renderType(item, state, module, new Set(seen))).join(", ")}>` : ""}`;
    }
  }
  const properties = state.checker.getPropertiesOfType(type);
  if (properties.length > 0 && properties.length <= MAX_PROPERTIES) {
    const fields = properties.map((property) => {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = declaration
        ? state.checker.getTypeOfSymbolAtLocation(property, declaration)
        : state.checker.getTypeOfSymbol(property);
      return `${JSON.stringify(property.getName())}: ${renderType(propertyType, state, module, new Set(seen))}`;
    });
    return `{${fields.join(", ")}}`;
  }
  return fallback(state, module, type, "unresolved-type");
}

function fallback(
  state: RenderState,
  module: ModuleSeed,
  type: ts.Type,
  code: string,
) {
  diagnostic(
    state,
    module,
    undefined,
    code,
    `Degraded ${state.checker.typeToString(type)} to ?.`,
  );
  return "?";
}

function diagnostic(
  state: RenderState,
  module: ModuleSeed,
  symbol: ts.Symbol | undefined,
  code: string,
  message: string,
) {
  state.diagnostics.push({
    code,
    message,
    module: module.specifier,
    symbol: symbol?.getName(),
  });
}

function dedupeDiagnostics(diagnostics: ExternTypeDiagnostic[]) {
  const seen = new Set<string>();
  return diagnostics
    .filter((item) => {
      const key = `${item.module}\0${item.symbol ?? ""}\0${item.code}\0${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      `${a.module}:${a.symbol ?? ""}:${a.code}`.localeCompare(
        `${b.module}:${b.symbol ?? ""}:${b.code}`,
      ),
    );
}

function union(types: string[]) {
  const unique = [...new Set(types)].sort();
  const only = unique[0];
  return unique.length === 1 && only !== undefined
    ? only
    : `(${unique.join("|")})`;
}

function appendTemplates(
  lines: string[],
  parameters: readonly ts.TypeParameterDeclaration[],
) {
  const names = [
    ...new Set(parameters.map((item) => sanitizeClosureName(item.name.text))),
  ].sort();
  if (names.length) lines.push(` * @template ${names.join(", ")}`);
}

function parameterName(parameter: ts.ParameterDeclaration, index: number) {
  return ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : `param${index}`;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined) {
  return name &&
    (ts.isIdentifier(name) ||
      ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name))
    ? name.text
    : null;
}

function propertyAccess(owner: string, name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    ? `${owner}.${name}`
    : `${owner}[${JSON.stringify(name)}]`;
}

function hasStatic(node: ts.Node) {
  return !!(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((item) => item.kind === ts.SyntaxKind.StaticKeyword)
  );
}

function isNonPublic(node: ts.Node) {
  return !!(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some(
        (item) =>
          item.kind === ts.SyntaxKind.PrivateKeyword ||
          item.kind === ts.SyntaxKind.ProtectedKeyword,
      )
  );
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker) {
  return isTypeReference(type) ? checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

function isSignatureDeclaration(
  node: ts.Declaration,
): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function emitUnknown(name: string, state: RenderState) {
  state.lines.push("/** @type {?} */", `${name};`);
}
