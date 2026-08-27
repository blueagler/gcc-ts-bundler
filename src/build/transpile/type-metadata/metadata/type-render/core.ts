import type ts from "@typescript/typescript6";

import type { ClosureDocRenderContext } from "./context";

type RenderToClosureType = (
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) => string;

let renderToClosureType: RenderToClosureType = () => {
  throw new Error("toClosureType renderer was not bound");
};

/**
 * Recursive TS→Closure conversion entry used by specialist renderers.
 *
 * The dispatcher lives in `to-closure.ts` and binds itself at module load so
 * this file stays a leaf: it imports no sibling renderers.
 */
export function recurseClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen = new Set<ts.Type>(),
  referenceNode?: ts.Node | undefined,
): string {
  return renderToClosureType(type, checker, context, seen, referenceNode);
}

export function bindToClosureTypeRenderer(render: RenderToClosureType) {
  renderToClosureType = render;
}
