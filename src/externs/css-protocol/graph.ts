import path from "path";

import ts from "@typescript/typescript6";

import { isRuntimeExternPropertyName } from "../shared";
import {
  collectEnumeratedKeyBindings,
  collectReturnExpressions,
  concatenationContainsMarker,
  templateContainsMarker,
} from "./helpers";
import { buildScopeTable } from "./module-info";
import { taintParameter, type TaintHost } from "./taint";
import {
  MAX_FRAME_DEPTH,
  MAX_SINK_CALL_DEPTH,
  MAX_TAINT_STEPS,
  addToSet,
  getPropertyKeyText,
  isFunctionLikeNode,
  parameterSlotKey,
  pushInto,
  type CallSite,
  type Frame,
  type FunctionLikeNode,
  type FunctionRef,
  type ModuleInfo,
  type Resolution,
  type ScopeNode,
} from "./types";

export class ModuleGraph implements TaintHost {
  private readonly calleeCache = new Map<ts.Node, FunctionRef | null>();
  private readonly callSites = new Map<FunctionLikeNode, CallSite[]>();
  private readonly functionSlots = new Map<FunctionLikeNode, Set<string>>();
  private readonly keyNames = new Set<string>();
  private readonly modules: Map<string, ModuleInfo>;
  private readonly sinkSites: string[] = [];
  private readonly slotCallSites = new Map<string, CallSite[]>();
  private readonly slotEdges = new Map<string, Set<string>>();
  /**
   * Higher-order flow. antd hands `useCacheToken` the function that computes
   * its token, and hands `genStyleHooks` the function that prepares each
   * component's tokens; both are read back through a parameter. These three
   * indexes say which functions can arrive in a parameter slot
   * (`slotFunctions`, closed under `slotEdges`), and which calls are made
   * through such a slot (`slotCallSites`). Resolving a callee through them is
   * resolution, not taint, so it costs no hop.
   */
  readonly slotFunctions = new Map<string, Set<FunctionLikeNode>>();
  private steps = 0;
  private readonly visited = new Set<string>();

  constructor(modules: Map<string, ModuleInfo>) {
    this.modules = modules;
  }

  addKeyName(name: string | null) {
    if (name && isRuntimeExternPropertyName(name)) this.keyNames.add(name);
  }

  // ---------------------------------------------------------------- resolution

  /**
   * The arguments one parameter slot receives at one call. A rest parameter
   * (`(...sources) => …`) collects every argument from its index on, so it
   * takes all of them — `shallowMergeOneLevel(a, b, { … })` puts the literal
   * in slot 2 of the same rest binding.
   */
  argumentsForSlot(
    fn: FunctionLikeNode,
    index: number,
    call: ts.CallExpression,
  ): ts.Expression[] {
    const args = call.arguments;
    const rest = !!fn.parameters[index]?.dotDotDotToken;
    const selected = rest ? args.slice(index) : [args[index]];
    return selected
      .filter((argument): argument is ts.Expression => !!argument)
      .map((argument) =>
        ts.isSpreadElement(argument) ? argument.expression : argument,
      );
  }

  /** Direct calls, plus calls made through a parameter this function reaches. */
  callSitesOf(fn: FunctionLikeNode): CallSite[] {
    const sites = [...(this.callSites.get(fn) ?? [])];
    for (const slot of this.functionSlots.get(fn) ?? []) {
      sites.push(...(this.slotCallSites.get(slot) ?? []));
    }
    return sites;
  }

  /** Relay closure: a function passed on through another parameter. */
  private closeSlotFunctions() {
    let changed = true;
    let rounds = 0;
    while (changed && rounds < 16) {
      changed = false;
      rounds += 1;
      for (const [source, targets] of this.slotEdges) {
        const functions = this.slotFunctions.get(source);
        if (!functions) continue;
        for (const target of targets) {
          for (const fn of functions) {
            const existing = this.slotFunctions.get(target);
            if (existing?.has(fn)) continue;
            addToSet(this.slotFunctions, target, fn);
            changed = true;
          }
        }
      }
    }
    for (const [slot, functions] of this.slotFunctions) {
      for (const fn of functions) addToSet(this.functionSlots, fn, slot);
    }
  }

  private collectSinks(module: ModuleInfo) {
    const visit = (node: ts.Node) => {
      if (isFunctionLikeNode(node) && node.body) {
        const body = node.body;
        node.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name)) return;
          const parameterName = parameter.name.text;
          for (const binding of collectEnumeratedKeyBindings(body)) {
            if (
              !ts.isIdentifier(binding.source) ||
              binding.source.text !== parameterName
            ) {
              continue;
            }
            if (
              !this.escapesToCssVariableName(
                module,
                binding.scope,
                binding.key,
                0,
              )
            ) {
              continue;
            }
            const { line } = module.sourceFile.getLineAndCharacterOfPosition(
              node.getStart(module.sourceFile),
            );
            this.sinkSites.push(`${module.filePath}:${line + 1}`);
            taintParameter(this, node, index, null, 0, null);
            break;
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  enter(node: ts.Node, tag: string, frame: Frame | null) {
    this.steps += 1;
    if (this.steps > MAX_TAINT_STEPS) return false;
    const context = frame ? `${frame.module.filePath}:${frame.call.pos}` : "";
    const key = `${tag}\u0000${context}\u0000${node.getSourceFile().fileName}\u0000${node.pos}\u0000${node.end}`;
    if (this.visited.has(key)) return false;
    this.visited.add(key);
    return true;
  }

  enterCall(
    fn: FunctionLikeNode,
    call: ts.CallExpression,
    module: ModuleInfo,
    frame: Frame | null,
  ): Frame | null {
    const depth = (frame?.depth ?? 0) + 1;
    if (depth > MAX_FRAME_DEPTH) return null;
    return { call, callee: fn, depth, module, parent: frame };
  }

  /**
   * Does `keyName` reach construction of a string with a `--` literal in it?
   * Directly, or through a call whose callee does that with the argument it
   * receives — `token2CSSVar(key, prefix)` is the second form.
   */
  private escapesToCssVariableName(
    module: ModuleInfo,
    scope: ts.Node,
    keyName: string,
    depth: number,
  ): boolean {
    if (depth > MAX_SINK_CALL_DEPTH) return false;
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === keyName) {
        const parent = node.parent;
        if (
          ts.isTemplateSpan(parent) &&
          ts.isTemplateExpression(parent.parent) &&
          templateContainsMarker(parent.parent)
        ) {
          found = true;
          return;
        }
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          concatenationContainsMarker(parent)
        ) {
          found = true;
          return;
        }
        if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
          const index = parent.arguments.indexOf(node);
          const callee =
            index >= 0 ? this.resolveCallee(module, parent.expression) : null;
          const parameter = callee?.node.parameters[index];
          if (
            callee?.node.body &&
            parameter &&
            ts.isIdentifier(parameter.name) &&
            this.escapesToCssVariableName(
              callee.module,
              callee.node.body,
              parameter.name.text,
              depth + 1,
            )
          ) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  }

  /** Which functions can arrive in one parameter slot, directly or by relay. */
  private indexArgumentFlow(
    module: ModuleInfo,
    fn: FunctionLikeNode,
    index: number,
    property: string | null,
    value: ts.Expression,
  ) {
    const slot = parameterSlotKey(fn, index, property);
    if (isFunctionLikeNode(value)) {
      addToSet(this.slotFunctions, slot, value);
      return;
    }
    if (!ts.isIdentifier(value)) return;
    const passed = this.resolveCallee(module, value);
    if (passed) {
      addToSet(this.slotFunctions, slot, passed.node);
      return;
    }
    const source = this.parameterSlotOf(module, value, value.text);
    if (source) addToSet(this.slotEdges, source, slot);
  }

  // ------------------------------------------------------------------ indexing

  private indexCall(
    module: ModuleInfo,
    call: ts.CallExpression,
    callee: ts.Identifier,
  ) {
    const callable = this.resolveCallee(module, callee);
    if (!callable) {
      const slot = this.parameterSlotOf(module, callee, callee.text);
      if (slot) pushInto(this.slotCallSites, slot, { call, module });
      return;
    }
    pushInto(this.callSites, callable.node, { call, module });
    call.arguments.forEach((argument, index) => {
      this.indexArgumentFlow(module, callable.node, index, null, argument);
      if (!ts.isObjectLiteralExpression(argument)) return;
      for (const member of argument.properties) {
        const property = member.name ? getPropertyKeyText(member.name) : null;
        if (!property) continue;
        const value = ts.isPropertyAssignment(member)
          ? member.initializer
          : ts.isShorthandPropertyAssignment(member)
            ? member.name
            : null;
        if (value) {
          this.indexArgumentFlow(module, callable.node, index, property, value);
        }
      }
    });
  }

  private indexCallSites() {
    for (const module of this.modules.values()) {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          this.indexCall(module, node, node.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(module.sourceFile);
    }
  }

  /** The declaration a name refers to at one use site, by lexical scope. */
  lookup(
    module: ModuleInfo,
    useSite: ts.Node,
    name: string,
  ): Resolution | null {
    for (let node: ts.Node | undefined = useSite; node; node = node.parent) {
      if (!isFunctionLikeNode(node) && !ts.isSourceFile(node)) continue;
      const symbol = this.scopeTable(module, node).get(name);
      if (!symbol) continue;
      const specifier = symbol.specifier;
      const exportName = symbol.exportName;
      if (specifier === null || exportName === null) return { module, symbol };
      const target = this.resolveSpecifier(module, specifier);
      if (!target) return null;
      const exported = this.resolveExport(target, exportName);
      return exported
        ? this.lookup(
            exported.module,
            exported.module.sourceFile,
            exported.name,
          )
        : null;
    }
    return null;
  }

  moduleOf(node: ts.Node) {
    return this.modules.get(node.getSourceFile().fileName) ?? null;
  }

  parameterSlotOf(
    module: ModuleInfo,
    useSite: ts.Node,
    name: string,
  ): string | null {
    // Destructured from a checked resolution rather than through `?.`: an
    // optional chain leaves the union optional, and Closure's property
    // disambiguation then invalidates the reads below and renames the
    // declaration without them.
    const resolved = this.lookup(module, useSite, name);
    const fn = resolved ? resolved.symbol.fn : null;
    return fn && resolved
      ? parameterSlotKey(fn, resolved.symbol.index, resolved.symbol.property)
      : null;
  }

  private resolveCallableSymbol(
    resolved: Resolution,
    depth: number,
  ): FunctionRef | null {
    const { module, symbol } = resolved;
    if (symbol.node) return { module, node: symbol.node };
    const initializer = symbol.declaration
      ? symbol.declaration.initializer
      : null;
    if (initializer && ts.isIdentifier(initializer)) {
      return this.resolveCallee(module, initializer, depth + 1);
    }
    if (symbol.call && symbol.property !== null) {
      return this.resolveFactoryProperty(
        module,
        symbol.call,
        symbol.property,
        depth + 1,
      );
    }
    return null;
  }

  // --------------------------------------------------------------------- sinks

  /**
   * The function a callee identifier runs. Follows imports and re-exports, plus
   * one deliberately narrow extra edge: a binding destructured from a call to a
   * resolvable factory (`const { genStyleHooks } = genStyleUtils({…})`), which
   * is how antd hands every component the hook that carries its tokens.
   */
  resolveCallee(
    module: ModuleInfo,
    callee: ts.Identifier,
    depth = 0,
  ): FunctionRef | null {
    const cached = this.calleeCache.get(callee);
    if (cached !== undefined) return cached;
    if (depth > 6) return null;
    this.calleeCache.set(callee, null);
    const resolved = this.lookup(module, callee, callee.text);
    const result = resolved
      ? this.resolveCallableSymbol(resolved, depth)
      : null;
    this.calleeCache.set(callee, result);
    return result;
  }

  private resolveExport(
    module: ModuleInfo,
    exportName: string,
    depth = 0,
  ): { module: ModuleInfo; name: string } | null {
    if (depth > 8) return null;
    const target = module.exports.get(exportName);
    if (target) {
      if (target.kind === "local") return { module, name: target.name };
      const next = this.resolveSpecifier(module, target.specifier);
      return next
        ? this.resolveExport(next, target.exportName, depth + 1)
        : null;
    }
    for (const specifier of module.starReExports) {
      const next = this.resolveSpecifier(module, specifier);
      const resolved = next
        ? this.resolveExport(next, exportName, depth + 1)
        : null;
      if (resolved) return resolved;
    }
    return null;
  }

  // --------------------------------------------------------------------- taint

  private resolveFactoryProperty(
    module: ModuleInfo,
    call: ts.CallExpression,
    property: string,
    depth: number,
  ): FunctionRef | null {
    if (!ts.isIdentifier(call.expression)) return null;
    const factory = this.resolveCallee(module, call.expression, depth);
    if (!factory) return null;
    for (const returned of collectReturnExpressions(factory.node)) {
      if (!ts.isObjectLiteralExpression(returned)) continue;
      for (const member of returned.properties) {
        const memberName = member.name ? getPropertyKeyText(member.name) : null;
        if (memberName !== property) continue;
        if (ts.isShorthandPropertyAssignment(member)) {
          return this.resolveCallee(factory.module, member.name, depth + 1);
        }
        if (ts.isPropertyAssignment(member)) {
          if (isFunctionLikeNode(member.initializer)) {
            return { module: factory.module, node: member.initializer };
          }
          if (ts.isIdentifier(member.initializer)) {
            return this.resolveCallee(
              factory.module,
              member.initializer,
              depth + 1,
            );
          }
        }
      }
    }
    return null;
  }

  private resolveSpecifier(fromModule: ModuleInfo, specifier: string) {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromModule.filePath), specifier);
    for (const candidate of [
      base,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, "index.js"),
    ]) {
      const found = this.modules.get(candidate);
      if (found) return found;
    }
    return null;
  }

  private scopeTable(module: ModuleInfo, scope: ScopeNode) {
    const cached = module.scopes.get(scope);
    if (cached) return cached;
    const table = buildScopeTable(scope);
    module.scopes.set(scope, table);
    return table;
  }

  run(): { keyNames: Set<string>; sinkSites: string[] } {
    this.indexCallSites();
    this.closeSlotFunctions();
    for (const module of this.modules.values()) this.collectSinks(module);
    return { keyNames: this.keyNames, sinkSites: this.sinkSites };
  }
}
