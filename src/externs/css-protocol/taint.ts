import ts from "@typescript/typescript6";

import {
  collectEnumeratedKeyBindings,
  collectReturnExpressions,
} from "./helpers";
import {
  MAX_TAINT_DEPTH,
  MAX_UPWARD_HOPS,
  MERGE_HELPER_PATTERN,
  getPropertyKeyText,
  isFunctionLikeNode,
  type CallSite,
  type Frame,
  type FunctionLikeNode,
  type FunctionRef,
  type ModuleInfo,
  type Resolution,
  type ScopeNode,
} from "./types";

/**
 * Graph services the taint walk needs. `ModuleGraph` implements this so
 * `taintExpression` can live outside the class.
 */
export interface TaintHost {
  addKeyName(name: string | null): void;
  argumentsForSlot(
    fn: FunctionLikeNode,
    index: number,
    call: ts.CallExpression,
  ): ts.Expression[];
  callSitesOf(fn: FunctionLikeNode): CallSite[];
  enter(node: ts.Node, tag: string, frame: Frame | null): boolean;
  enterCall(
    fn: FunctionLikeNode,
    call: ts.CallExpression,
    module: ModuleInfo,
    frame: Frame | null,
  ): Frame | null;
  lookup(module: ModuleInfo, useSite: ts.Node, name: string): Resolution | null;
  moduleOf(node: ts.Node): ModuleInfo | null;
  parameterSlotOf(
    module: ModuleInfo,
    useSite: ts.Node,
    name: string,
  ): string | null;
  resolveCallee(
    module: ModuleInfo,
    callee: ts.Identifier,
    depth?: number,
  ): FunctionRef | null;
  readonly slotFunctions: Map<string, Set<FunctionLikeNode>>;
}

function taintCall(
  host: TaintHost,
  module: ModuleInfo,
  call: ts.CallExpression,
  property: string | null,
  hops: number,
  depth: number,
  frame: Frame | null,
) {
  const callee = call.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  const taintArguments = () => {
    for (const argument of call.arguments) {
      taintExpression(
        host,
        module,
        ts.isSpreadElement(argument) ? argument.expression : argument,
        property,
        hops,
        depth + 1,
        frame,
      );
    }
  };

  if (calleeName && MERGE_HELPER_PATTERN.test(calleeName)) {
    taintArguments();
    return;
  }
  // A thunk argument is a deferred value: `useMemo(() => v, deps)`,
  // `useGlobalCache(key, path, () => v)` and `memoResult(() => v, deps)` all
  // return what the thunk returns, through a callee whose own body says so
  // only through a dispatcher. Its returns are the call's returns.
  for (const argument of call.arguments) {
    if (isFunctionLikeNode(argument) && argument.parameters.length === 0) {
      taintFunctionReturns(host, argument, property, hops, depth, frame);
    }
  }

  if (ts.isIdentifier(callee)) {
    const callable = host.resolveCallee(module, callee);
    if (callable) {
      taintFunctionReturns(
        host,
        callable.node,
        property,
        hops,
        depth,
        host.enterCall(callable.node, call, module, frame),
      );
      return;
    }
    // A callee held by a parameter: the higher-order index says which
    // functions can arrive there, so this stays resolution, not fan-out.
    const slot = host.parameterSlotOf(module, callee, callee.text);
    const functions = slot ? host.slotFunctions.get(slot) : null;
    if (functions && functions.size > 0) {
      for (const fn of functions) {
        taintFunctionReturns(
          host,
          fn,
          property,
          hops,
          depth,
          host.enterCall(fn, call, module, frame),
        );
      }
      return;
    }
    const resolved = host.lookup(module, callee, callee.text);
    const owner = resolved ? resolved.symbol : null;
    if (owner && owner.fn) {
      taintParameter(host, owner.fn, owner.index, owner.property, hops, frame);
      return;
    }
  }
  // Opaque: an unknown function builds its result out of its receiver and
  // its arguments — `theme.getDerivativeToken(seed)` is both.
  if (ts.isPropertyAccessExpression(callee)) {
    taintExpression(
      host,
      module,
      callee.expression,
      null,
      hops,
      depth + 1,
      frame,
    );
  }
  taintArguments();
}

/**
 * `property` narrows the taint to one member of the value: the tainted thing
 * is `node.property`, not `node`. It is what keeps
 * `useMemo(() => ({ token: mergeTokens(…), intl, dark }))` from contributing
 * `intl` and `dark` while still following the token itself.
 */
function taintExpression(
  host: TaintHost,
  module: ModuleInfo,
  node: ts.Expression,
  property: string | null,
  hops: number,
  depth: number,
  frame: Frame | null,
) {
  if (depth > MAX_TAINT_DEPTH) return;
  if (!host.enter(node, `expr:${property ?? ""}:${hops}:${depth}`, frame)) {
    return;
  }

  if (ts.isParenthesizedExpression(node)) {
    taintExpression(
      host,
      module,
      node.expression,
      property,
      hops,
      depth,
      frame,
    );
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const member of node.properties) {
      if (ts.isSpreadAssignment(member)) {
        // A spread carries every member, so the selection survives it.
        taintExpression(
          host,
          module,
          member.expression,
          property,
          hops,
          depth + 1,
          frame,
        );
        continue;
      }
      const memberName = member.name ? getPropertyKeyText(member.name) : null;
      if (!property) {
        host.addKeyName(memberName);
        continue;
      }
      if (memberName !== property) continue;
      const value = ts.isPropertyAssignment(member)
        ? member.initializer
        : ts.isShorthandPropertyAssignment(member)
          ? member.name
          : null;
      if (value) {
        taintExpression(host, module, value, null, hops, depth + 1, frame);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      taintExpression(
        host,
        module,
        ts.isSpreadElement(element) ? element.expression : element,
        property,
        hops,
        depth + 1,
        frame,
      );
    }
    return;
  }
  if (isFunctionLikeNode(node)) {
    taintFunctionReturns(host, node, property, hops, depth, frame);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    taintExpression(
      host,
      module,
      node.whenTrue,
      property,
      hops,
      depth + 1,
      frame,
    );
    taintExpression(
      host,
      module,
      node.whenFalse,
      property,
      hops,
      depth + 1,
      frame,
    );
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      taintExpression(
        host,
        module,
        node.left,
        property,
        hops,
        depth + 1,
        frame,
      );
      taintExpression(
        host,
        module,
        node.right,
        property,
        hops,
        depth + 1,
        frame,
      );
    }
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    // One level of selection only: a deeper path degrades to the object.
    taintExpression(
      host,
      module,
      node.expression,
      property ? null : node.name.text,
      hops,
      depth + 1,
      frame,
    );
    return;
  }
  if (ts.isElementAccessExpression(node)) {
    taintExpression(
      host,
      module,
      node.expression,
      null,
      hops,
      depth + 1,
      frame,
    );
    return;
  }
  if (ts.isNewExpression(node)) {
    // A constructed object is built out of what was handed to it.
    for (const argument of node.arguments ?? []) {
      taintExpression(host, module, argument, property, hops, depth + 1, frame);
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    taintCall(host, module, node, property, hops, depth, frame);
    return;
  }
  if (ts.isIdentifier(node)) {
    taintIdentifier(host, module, node, property, hops, depth, frame);
  }
}

function taintFunctionReturns(
  host: TaintHost,
  fn: FunctionLikeNode,
  property: string | null,
  hops: number,
  depth: number,
  frame: Frame | null,
) {
  const module = host.moduleOf(fn);
  if (!module) return;
  if (!host.enter(fn, `returns:${property ?? ""}:${hops}:${depth}`, frame)) {
    return;
  }
  for (const returned of collectReturnExpressions(fn)) {
    taintExpression(host, module, returned, property, hops, depth + 1, frame);
  }
}

function taintIdentifier(
  host: TaintHost,
  module: ModuleInfo,
  identifier: ts.Identifier,
  property: string | null,
  hops: number,
  depth: number,
  frame: Frame | null,
) {
  const resolved = host.lookup(module, identifier, identifier.text);
  if (!resolved) return;
  const { symbol } = resolved;
  if (symbol.fn) {
    // A destructured binding is already one selection deep; a further one
    // degrades to the whole parameter.
    taintParameter(
      host,
      symbol.fn,
      symbol.index,
      symbol.property === null ? property : property ? null : symbol.property,
      hops,
      frame,
    );
    return;
  }
  if (symbol.node) {
    taintFunctionReturns(host, symbol.node, property, hops, depth, null);
    return;
  }
  if (symbol.call) {
    taintCall(
      host,
      resolved.module,
      symbol.call,
      property ? null : symbol.property,
      hops,
      depth,
      frame,
    );
    return;
  }
  const declaration = symbol.declaration;
  const scope = symbol.scope;
  if (!declaration || !scope) return;
  taintScopeWrites(
    host,
    resolved.module,
    scope,
    identifier.text,
    property,
    hops,
    depth,
    frame,
  );
  if (declaration.initializer) {
    taintExpression(
      host,
      resolved.module,
      declaration.initializer,
      property,
      hops,
      depth + 1,
      frame,
    );
  }
}

export function taintParameter(
  host: TaintHost,
  fn: FunctionLikeNode,
  index: number,
  property: string | null,
  hops: number,
  frame: Frame | null,
) {
  for (let current = frame; current; current = current.parent) {
    if (current.callee !== fn) continue;
    for (const argument of host.argumentsForSlot(fn, index, current.call)) {
      taintExpression(
        host,
        current.module,
        argument,
        property,
        hops,
        0,
        current.parent,
      );
    }
    return;
  }
  if (hops >= MAX_UPWARD_HOPS) return;
  if (!host.enter(fn, `param:${index}:${property ?? ""}:${hops}`, null)) {
    return;
  }
  for (const site of host.callSitesOf(fn)) {
    for (const argument of host.argumentsForSlot(fn, index, site.call)) {
      taintExpression(host, site.module, argument, property, hops + 1, 0, null);
    }
  }
}

/**
 * What else the scope that declares a tainted binding puts into it:
 * `token.x = v` and `Object.defineProperty(token, "x", …)` name a key,
 * `token = …` replaces the value and is tainted in turn.
 */
function taintScopeWrites(
  host: TaintHost,
  module: ModuleInfo,
  scope: ScopeNode,
  name: string,
  property: string | null,
  hops: number,
  depth: number,
  frame: Frame | null,
) {
  if (!host.enter(scope, `writes:${name}:${property ?? ""}:${hops}`, frame)) {
    return;
  }
  // `result[key] = …` under `for (const key in source)` copies whatever keys
  // `source` has, so the taint moves to `source`. That is what makes a
  // hand-written merge (`shallowMergeOneLevel`) transparent without naming it.
  const keyCopySources = property
    ? new Map<string, ts.Expression>()
    : new Map(
        collectEnumeratedKeyBindings(scope).map((binding) => [
          binding.key,
          binding.source,
        ]),
      );
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === name
      ) {
        if (!property) {
          host.addKeyName(node.left.name.text);
        } else if (node.left.name.text === property) {
          taintExpression(
            host,
            module,
            node.right,
            null,
            hops,
            depth + 1,
            frame,
          );
        }
      } else if (ts.isIdentifier(node.left) && node.left.text === name) {
        taintExpression(
          host,
          module,
          node.right,
          property,
          hops,
          depth + 1,
          frame,
        );
      } else if (
        ts.isElementAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === name &&
        ts.isIdentifier(node.left.argumentExpression)
      ) {
        const source = keyCopySources.get(node.left.argumentExpression.text);
        if (source) {
          taintExpression(host, module, source, null, hops, depth + 1, frame);
        }
      }
    }
    if (
      !property &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2
    ) {
      const [target, key] = node.arguments;
      if (
        target &&
        key &&
        ts.isIdentifier(target) &&
        target.text === name &&
        ts.isStringLiteral(key)
      ) {
        host.addKeyName(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
}
