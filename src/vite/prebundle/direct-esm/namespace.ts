import ts from "@typescript/typescript6";

import type { ParsedDependencyImport } from "../shared";

/**
 * Resolve a namespace import into the fixed member reads it makes, or null
 * when the namespace escapes (a computed read, a bare reference) and so has no
 * statically known member set.
 */
export function resolveNamespaceImportMembers(
  dependencyImport: ParsedDependencyImport,
) {
  const statement = dependencyImport.node;
  if (!ts.isImportDeclaration(statement)) {
    return null;
  }
  const namedBindings = statement.importClause?.namedBindings;
  if (
    statement.importClause?.name ||
    !namedBindings ||
    !ts.isNamespaceImport(namedBindings)
  ) {
    return null;
  }
  return collectNamespaceMemberUses(
    statement.getSourceFile(),
    namedBindings.name,
  );
}

export function collectNamespaceMemberUses(
  sourceFile: ts.SourceFile,
  namespaceBinding: ts.Identifier,
) {
  const uses = new Map<string, ts.PropertyAccessExpression[]>();
  let safe = true;
  const visit = (node: ts.Node) => {
    if (!safe) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === namespaceBinding.text) {
      if (node === namespaceBinding) {
        return;
      }
      const parent = node.parent;
      if (
        !parent ||
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== node ||
        parent.questionDotToken
      ) {
        safe = false;
        return;
      }
      const bucket = uses.get(parent.name.text);
      if (bucket) {
        bucket.push(parent);
      } else {
        uses.set(parent.name.text, [parent]);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return safe ? uses : null;
}
