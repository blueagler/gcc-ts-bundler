import crypto from "node:crypto";
import path from "node:path";
import type ts from "typescript";

import { sanitizeClosureName } from "../build/transpile/closure-ir/metadata/closure-type-strings";

export function stableExternNamespace(
  specifier: string,
  declarationEntry: string,
) {
  return `__gccExtern$${shortHash(`${specifier}\0${path.resolve(declarationEntry)}`)}`;
}

export function stableSymbolName(
  namespace: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
) {
  const declaration = symbol.declarations?.[0];
  const identity = declaration
    ? `${path.resolve(declaration.getSourceFile().fileName)}:${declaration.pos}:${symbol.getName()}`
    : checker.getFullyQualifiedName(symbol);
  return `${namespace}.${sanitizeClosureName(symbol.getName())}$${shortHash(identity)}`;
}

export function renderRuntimeBridge(specifier: string, namespace: string) {
  return [
    `// Compile this bridge with the importing Closure job; it is not an extern.`,
    `const ${namespace}$runtime = __gccExternalRuntimeLoad(${JSON.stringify(specifier)});`,
  ].join("\n");
}

function shortHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}
