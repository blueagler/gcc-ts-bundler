import crypto from "node:crypto";
import path from "node:path";
import type ts from "typescript";

import { sanitizeClosureName } from "../build/transpile/closure-ir/metadata/closure-type-strings";

export function stableExternNamespace(
  specifier: string,
  declarationEntry: string,
  projectRoot?: string,
) {
  return `__gccExtern$${shortHash(`${specifier}\0${canonicalDeclarationPath(declarationEntry, projectRoot)}`)}`;
}

export function stableSymbolName(
  namespace: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  projectRoot?: string,
) {
  const declaration = symbol.declarations?.[0];
  const identity = declaration
    ? `${canonicalDeclarationPath(declaration.getSourceFile().fileName, projectRoot)}:${declaration.pos}:${symbol.getName()}`
    : checker.getFullyQualifiedName(symbol);
  return `${namespace}.${sanitizeClosureName(symbol.getName())}$${shortHash(identity)}`;
}

export function renderRuntimeBridge(specifier: string, namespace: string) {
  return [
    `// Compile this bridge with the importing Closure job; it is not an extern.`,
    `const ${namespace}$runtime = __gccExternalRuntimeLoad(${JSON.stringify(specifier)});`,
  ].join("\n");
}

/**
 * Extern namespaces and symbol names land in generated externs and runtime
 * bridge code, so their hash inputs must be project-relative: hashing the
 * absolute declaration path makes output bytes differ when the same project
 * is built from two directories.
 */
function canonicalDeclarationPath(filePath: string, projectRoot?: string) {
  const resolved = path.resolve(filePath);
  const marker = `${path.sep}node_modules${path.sep}`;
  const nodeModulesIndex = resolved.lastIndexOf(marker);
  if (nodeModulesIndex >= 0) {
    return `node_modules/${resolved
      .slice(nodeModulesIndex + marker.length)
      .replace(/\\/g, "/")}`;
  }
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    if (resolved.startsWith(`${root}${path.sep}`)) {
      return path.relative(root, resolved).replace(/\\/g, "/");
    }
  }
  return resolved;
}

function shortHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}
