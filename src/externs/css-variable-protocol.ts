import fs from "fs";
import path from "path";

import ts from "@typescript/typescript6";

import { getScriptKindForFile, isRuntimeExternPropertyName } from "./shared";

/**
 * The CSS custom-property protocol: member names that a stylesheet spells out.
 *
 * `@ant-design/cssinjs` turns a token object into CSS variables by enumerating
 * its keys and transliterating each one into a custom-property name:
 *
 * ```js
 * const token2CSSVar = (token, prefix = "") =>
 *   `--${prefix ? `${prefix}-` : ""}${token}`.replace(…).toLowerCase();
 * const transformToken = (token, themeKey, config) => {
 *   Object.entries(token).forEach(([key, value]) => { … token2CSSVar(key, prefix) … });
 * };
 * ```
 *
 * The keys are ordinary dot-defined literal keys spread across three packages,
 * so Closure renames them and the renamed spelling is what lands in the
 * stylesheet: `gap: var(--ant-button-e$)`. A renamed name is not merely ugly —
 * `$` is not valid in a CSS identifier, so the declaration is dropped by the
 * parser, and the `.toLowerCase()` above can collide two renamed keys that
 * differ only in case. A prerendered shell also hashes token *content*, so a
 * renamed key changes the hash and the client render stops matching the shell.
 *
 * No other evidence class reaches this: the enumeration happens on a
 * *parameter*, the names never appear as a string literal, and the object that
 * carries them is assembled by three packages of spreads, dot-writes and
 * higher-order calls. This class is that cross-module dataflow, kept narrow by
 * two things:
 *
 * 1. **The sink signature is the `--` literal head.** A key counts only when it
 *    flows into construction of a string whose literal text contains `--`,
 *    which is what makes it a custom-property *name* rather than a computed
 *    read (`pickAttrs`, `dequal`) or ordinary declaration text (`k:v;` in
 *    antd-style and watermark). No package names anywhere.
 * 2. **The taint is bounded.** Three upward hops, where a hop is one call-site
 *    expansion of a tainted parameter — the only step that fans out. Local
 *    slicing, import resolution and stepping into a resolved function to taint
 *    its `return` expressions do not fan out and are not counted, but carry
 *    their own depth limit.
 */
export interface CssVariableProtocolResult {
  /** Member names that become CSS custom-property names. */
  keyNames: Set<string>;
  /** `file:line` of every sink the scan proved, for reporting. */
  sinkSites: string[];
}

/** Upward hops: one hop is one call-site expansion of a tainted parameter. */
const MAX_UPWARD_HOPS = 3;
/** Depth of the non-fanning steps (returns, initializers, merges). */
const MAX_TAINT_DEPTH = 64;
/** Depth of the sink proof: `key` -> `f(key)` -> template with a `--` head. */
const MAX_SINK_CALL_DEPTH = 2;
/** Total taint steps; a stop valve, not a design parameter. */
const MAX_TAINT_STEPS = 2_000_000;

const CSS_VARIABLE_MARKER = "--";

const KEY_ENUMERATION_METHODS = new Set([
  "entries",
  "getOwnPropertyNames",
  "keys",
]);
const ITERATION_METHODS = new Set([
  "every",
  "filter",
  "flatMap",
  "forEach",
  "map",
  "some",
]);
/**
 * Helpers that merge their arguments into one object: Babel and esbuild emit
 * the spread forms, `Object.assign` is the platform one. A merge is transparent
 * to the taint — the keys of the result are the keys of the arguments.
 */
const MERGE_HELPER_PATTERN = /^_{0,2}(?:objectSpread2?|extends|assign)\d*$/u;

type FunctionLikeNode =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

type ScopeNode = FunctionLikeNode | ts.SourceFile;

/**
 * One flat record rather than a discriminated union, and deliberately so.
 * Closure disambiguates a property by the receiver type it can see; a variant
 * read out of a union after TypeScript narrowing — which Closure cannot see —
 * is an unknown receiver, so it renames one side of the property and leaves
 * the other alone, and the two spellings never meet. With one named type every
 * read and every write agree. Which kind of symbol this is, is the field that
 * is set: exactly one of `call`, `declaration`, `fn`, `node` and `specifier`,
 * or none of them for a name declared twice in one scope.
 */
interface ScopeSymbol {
  /** `const { x } = f(…)` — the call, with `property` naming the member. */
  call: ts.CallExpression | null;
  /** `const x = …` — the declaration, with `scope` naming where it lives. */
  declaration: ts.VariableDeclaration | null;
  exportName: string | null;
  /** A parameter of `fn`, at `index`, optionally destructured to `property`. */
  fn: FunctionLikeNode | null;
  index: number;
  /** A function declaration or a function-valued `const`. */
  node: FunctionLikeNode | null;
  property: string | null;
  scope: ScopeNode | null;
  /** An import from `specifier`, of `exportName`. */
  specifier: string | null;
}

function emptySymbol(): ScopeSymbol {
  return {
    call: null,
    declaration: null,
    exportName: null,
    fn: null,
    index: -1,
    node: null,
    property: null,
    scope: null,
    specifier: null,
  };
}

function parameterSymbol(
  fn: FunctionLikeNode,
  index: number,
  property: string | null,
): ScopeSymbol {
  return { ...emptySymbol(), fn, index, property };
}

function functionSymbol(node: FunctionLikeNode): ScopeSymbol {
  return { ...emptySymbol(), node };
}

function importSymbol(exportName: string, specifier: string): ScopeSymbol {
  return { ...emptySymbol(), exportName, specifier };
}

function variableSymbol(
  declaration: ts.VariableDeclaration,
  scope: ScopeNode,
): ScopeSymbol {
  return { ...emptySymbol(), declaration, scope };
}

function destructuredCallSymbol(
  call: ts.CallExpression,
  property: string,
): ScopeSymbol {
  return { ...emptySymbol(), call, property };
}

type ExportTarget =
  | { kind: "local"; name: string }
  | { kind: "reExport"; exportName: string; specifier: string };

interface ModuleInfo {
  exports: Map<string, ExportTarget>;
  filePath: string;
  scopes: Map<ScopeNode, Map<string, ScopeSymbol>>;
  sourceFile: ts.SourceFile;
  starReExports: string[];
}

interface Resolution {
  module: ModuleInfo;
  symbol: ScopeSymbol;
}

interface FunctionRef {
  module: ModuleInfo;
  node: FunctionLikeNode;
}

interface CallSite {
  call: ts.CallExpression;
  module: ModuleInfo;
}

export async function analyzeCssVariableProtocol(
  filePaths: readonly string[],
): Promise<CssVariableProtocolResult> {
  const modules = new Map<string, ModuleInfo>();
  const parsed = await Promise.all(
    [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].map(
      async (filePath) => {
        const sourceText = await fs.promises.readFile(filePath, "utf8");
        return ts.createSourceFile(
          filePath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          getScriptKindForFile(filePath),
        );
      },
    ),
  );
  for (const sourceFile of parsed) {
    modules.set(sourceFile.fileName, buildModuleInfo(sourceFile));
  }
  const result = new ModuleGraph(modules).run();
  for (const sourceFile of parsed) {
    collectSelectorElementKeys(sourceFile, result.keyNames);
  }
  return result;
}

function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Element-name keys in selector position of a style object.
 *
 * cssinjs `parseStyle` prints an identifier key whose value is an object as a
 * nested selector: antd's `svg: { … }` under `.anticon` emits `.anticon svg`.
 * Closure renames the key and the emitted rule selects nothing — and the
 * changed rule text shifts the cssinjs content hash, so a prerendered shell
 * no longer matches the client render (React #418).
 *
 * The evidence is local and shape-based. An object literal is style-shaped
 * when one of its keys is a string or template whose text carries selector
 * syntax (`&`, `.`, `:`, whitespace, `>`, `[`). Inside a style-shaped
 * literal, an identifier key with an object-literal value is a selector
 * element name — unless the value is the `_skip_check_`/`_multi_value_`
 * declaration wrapper, which parseStyle prints as a declaration.
 */
function collectSelectorElementKeys(
  sourceFile: ts.SourceFile,
  keyNames: Set<string>,
) {
  const selectorSyntax = /[&.:\s>[]/u;
  const isSelectorStyleObject = (candidate: ts.ObjectLiteralExpression) =>
    candidate.properties.some((member) => {
      if (!ts.isPropertyAssignment(member)) return false;
      if (ts.isStringLiteralLike(member.name)) {
        return selectorSyntax.test(member.name.text);
      }
      if (!ts.isComputedPropertyName(member.name)) return false;
      const expression = member.name.expression;
      return (
        ts.isTemplateExpression(expression) ||
        ts.isStringLiteralLike(expression)
      );
    });
  const isDeclarationWrapper = (candidate: ts.ObjectLiteralExpression) =>
    candidate.properties.some(
      (member) =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
        (member.name.text === "_skip_check_" ||
          member.name.text === "_multi_value_"),
    );
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && isSelectorStyleObject(node)) {
      for (const member of node.properties) {
        if (
          ts.isPropertyAssignment(member) &&
          ts.isIdentifier(member.name) &&
          ts.isObjectLiteralExpression(member.initializer) &&
          !isDeclarationWrapper(member.initializer) &&
          isRuntimeExternPropertyName(member.name.text)
        ) {
          keyNames.add(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function buildModuleInfo(sourceFile: ts.SourceFile): ModuleInfo {
  const exports = new Map<string, ExportTarget>();
  const starReExports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = literalSpecifier(statement.moduleSpecifier);
      if (!statement.exportClause) {
        if (specifier) starReExports.push(specifier);
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        exports.set(
          element.name.text,
          specifier
            ? { kind: "reExport", exportName: localName, specifier }
            : { kind: "local", name: localName },
        );
      }
      continue;
    }
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      exports.set("default", {
        kind: "local",
        name: statement.expression.text,
      });
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      exports.set(name, { kind: "local", name });
      if (hasDefaultModifier(statement)) {
        exports.set("default", { kind: "local", name });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        exports.set(name, { kind: "local", name });
      }
    }
  }
  return {
    exports,
    filePath: sourceFile.fileName,
    scopes: new Map(),
    sourceFile,
    starReExports,
  };
}

/**
 * Names a scope introduces: parameters and their object-destructured
 * properties, plus every declaration in the scope body that is not inside a
 * nested function. A name declared twice in one scope becomes `ambiguous` and
 * stops resolution rather than guessing which declaration is live.
 */
function buildScopeTable(scope: ScopeNode): Map<string, ScopeSymbol> {
  const symbols = new Map<string, ScopeSymbol>();
  const declare = (name: string, symbol: ScopeSymbol) => {
    // A name declared twice in one scope stops resolution rather than
    // guessing which declaration is live.
    symbols.set(name, symbols.has(name) ? emptySymbol() : symbol);
  };
  const declareBindingPattern = (
    pattern: ts.ObjectBindingPattern,
    onProperty: (property: string, local: string) => void,
  ) => {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName
        ? getPropertyKeyText(element.propertyName)
        : element.name.text;
      if (propertyName) onProperty(propertyName, element.name.text);
    }
  };

  if (isFunctionLikeNode(scope)) {
    scope.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        declare(parameter.name.text, parameterSymbol(scope, index, null));
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        declareBindingPattern(parameter.name, (property, local) => {
          declare(local, parameterSymbol(scope, index, property));
        });
      }
    });
  }

  /** The index of the parameter a name binds, or -1. */
  const parameterIndexOf = (name: string) => {
    if (!isFunctionLikeNode(scope)) return -1;
    return scope.parameters.findIndex(
      (parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === name,
    );
  };

  const visit = (node: ts.Node) => {
    if (node !== scope && isFunctionLikeNode(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        declare(node.name.text, functionSymbol(node));
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.initializer && isFunctionLikeNode(node.initializer)) {
          declare(node.name.text, functionSymbol(node.initializer));
        } else {
          declare(node.name.text, variableSymbol(node, scope));
        }
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const initializer = node.initializer;
        if (ts.isIdentifier(initializer)) {
          const index = parameterIndexOf(initializer.text);
          if (index >= 0 && isFunctionLikeNode(scope)) {
            const owner = scope;
            declareBindingPattern(node.name, (property, local) => {
              declare(local, parameterSymbol(owner, index, property));
            });
          }
        } else if (ts.isCallExpression(initializer)) {
          declareBindingPattern(node.name, (property, local) => {
            declare(local, destructuredCallSymbol(initializer, property));
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (isFunctionLikeNode(scope)) {
    if (scope.body) visit(scope.body);
  } else {
    visit(scope);
  }

  if (ts.isSourceFile(scope)) {
    for (const statement of scope.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        continue;
      }
      const specifier = literalSpecifier(statement.moduleSpecifier);
      if (!specifier) continue;
      if (statement.importClause.name) {
        symbols.set(
          statement.importClause.name.text,
          importSymbol("default", specifier),
        );
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          symbols.set(
            element.name.text,
            importSymbol(
              (element.propertyName ?? element.name).text,
              specifier,
            ),
          );
        }
      }
    }
  }
  return symbols;
}

function getPropertyKeyText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function hasExportModifier(node: ts.Statement) {
  return ts.canHaveModifiers(node)
    ? (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    : false;
}

function hasDefaultModifier(node: ts.Statement) {
  return ts.canHaveModifiers(node)
    ? (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
        false)
    : false;
}

function literalSpecifier(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

/**
 * A call context. Entering a resolved function through a call binds its
 * parameters to that call's arguments, so reading a parameter inside is exact
 * and costs no hop. Only a parameter with no binding context fans out to every
 * call site, and that is what a hop counts.
 */
interface Frame {
  call: ts.CallExpression;
  /**
   * Deliberately not named `fn`: two record types that share a property name
   * are one disambiguation cluster for Closure, and it then renames the
   * declaration of `ScopeSymbol.fn` while leaving its reads alone.
   */
  callee: FunctionLikeNode;
  depth: number;
  module: ModuleInfo;
  parent: Frame | null;
}

const MAX_FRAME_DEPTH = 8;

class ModuleGraph {
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
  private readonly slotFunctions = new Map<string, Set<FunctionLikeNode>>();
  private steps = 0;
  private readonly visited = new Set<string>();

  constructor(modules: Map<string, ModuleInfo>) {
    this.modules = modules;
  }

  private addKeyName(name: string | null) {
    if (name && isRuntimeExternPropertyName(name)) this.keyNames.add(name);
  }

  // ---------------------------------------------------------------- resolution

  /**
   * The arguments one parameter slot receives at one call. A rest parameter
   * (`(...sources) => …`) collects every argument from its index on, so it
   * takes all of them — `shallowMergeOneLevel(a, b, { … })` puts the literal
   * in slot 2 of the same rest binding.
   */
  private argumentsForSlot(
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
  private callSitesOf(fn: FunctionLikeNode): CallSite[] {
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
            this.taintParameter(node, index, null, 0, null);
            break;
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  private enter(node: ts.Node, tag: string, frame: Frame | null) {
    this.steps += 1;
    if (this.steps > MAX_TAINT_STEPS) return false;
    const context = frame ? `${frame.module.filePath}:${frame.call.pos}` : "";
    const key = `${tag}\u0000${context}\u0000${node.getSourceFile().fileName}\u0000${node.pos}\u0000${node.end}`;
    if (this.visited.has(key)) return false;
    this.visited.add(key);
    return true;
  }

  private enterCall(
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
  private lookup(
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

  private moduleOf(node: ts.Node) {
    return this.modules.get(node.getSourceFile().fileName) ?? null;
  }

  private parameterSlotOf(
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
  private resolveCallee(
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

  private taintCall(
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
        this.taintExpression(
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
        this.taintFunctionReturns(argument, property, hops, depth, frame);
      }
    }

    if (ts.isIdentifier(callee)) {
      const callable = this.resolveCallee(module, callee);
      if (callable) {
        this.taintFunctionReturns(
          callable.node,
          property,
          hops,
          depth,
          this.enterCall(callable.node, call, module, frame),
        );
        return;
      }
      // A callee held by a parameter: the higher-order index says which
      // functions can arrive there, so this stays resolution, not fan-out.
      const slot = this.parameterSlotOf(module, callee, callee.text);
      const functions = slot ? this.slotFunctions.get(slot) : null;
      if (functions && functions.size > 0) {
        for (const fn of functions) {
          this.taintFunctionReturns(
            fn,
            property,
            hops,
            depth,
            this.enterCall(fn, call, module, frame),
          );
        }
        return;
      }
      const resolved = this.lookup(module, callee, callee.text);
      const owner = resolved ? resolved.symbol : null;
      if (owner && owner.fn) {
        this.taintParameter(owner.fn, owner.index, owner.property, hops, frame);
        return;
      }
    }
    // Opaque: an unknown function builds its result out of its receiver and
    // its arguments — `theme.getDerivativeToken(seed)` is both.
    if (ts.isPropertyAccessExpression(callee)) {
      this.taintExpression(
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
  private taintExpression(
    module: ModuleInfo,
    node: ts.Expression,
    property: string | null,
    hops: number,
    depth: number,
    frame: Frame | null,
  ) {
    if (depth > MAX_TAINT_DEPTH) return;
    if (!this.enter(node, `expr:${property ?? ""}:${hops}:${depth}`, frame)) {
      return;
    }

    if (ts.isParenthesizedExpression(node)) {
      this.taintExpression(
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
          this.taintExpression(
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
          this.addKeyName(memberName);
          continue;
        }
        if (memberName !== property) continue;
        const value = ts.isPropertyAssignment(member)
          ? member.initializer
          : ts.isShorthandPropertyAssignment(member)
            ? member.name
            : null;
        if (value) {
          this.taintExpression(module, value, null, hops, depth + 1, frame);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        this.taintExpression(
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
      this.taintFunctionReturns(node, property, hops, depth, frame);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      this.taintExpression(
        module,
        node.whenTrue,
        property,
        hops,
        depth + 1,
        frame,
      );
      this.taintExpression(
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
        this.taintExpression(
          module,
          node.left,
          property,
          hops,
          depth + 1,
          frame,
        );
        this.taintExpression(
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
      this.taintExpression(
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
      this.taintExpression(
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
        this.taintExpression(
          module,
          argument,
          property,
          hops,
          depth + 1,
          frame,
        );
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      this.taintCall(module, node, property, hops, depth, frame);
      return;
    }
    if (ts.isIdentifier(node)) {
      this.taintIdentifier(module, node, property, hops, depth, frame);
    }
  }

  private taintFunctionReturns(
    fn: FunctionLikeNode,
    property: string | null,
    hops: number,
    depth: number,
    frame: Frame | null,
  ) {
    const module = this.moduleOf(fn);
    if (!module) return;
    if (!this.enter(fn, `returns:${property ?? ""}:${hops}:${depth}`, frame)) {
      return;
    }
    for (const returned of collectReturnExpressions(fn)) {
      this.taintExpression(module, returned, property, hops, depth + 1, frame);
    }
  }

  private taintIdentifier(
    module: ModuleInfo,
    identifier: ts.Identifier,
    property: string | null,
    hops: number,
    depth: number,
    frame: Frame | null,
  ) {
    const resolved = this.lookup(module, identifier, identifier.text);
    if (!resolved) return;
    const { symbol } = resolved;
    if (symbol.fn) {
      // A destructured binding is already one selection deep; a further one
      // degrades to the whole parameter.
      this.taintParameter(
        symbol.fn,
        symbol.index,
        symbol.property === null ? property : property ? null : symbol.property,
        hops,
        frame,
      );
      return;
    }
    if (symbol.node) {
      this.taintFunctionReturns(symbol.node, property, hops, depth, null);
      return;
    }
    if (symbol.call) {
      this.taintCall(
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
    this.taintScopeWrites(
      resolved.module,
      scope,
      identifier.text,
      property,
      hops,
      depth,
      frame,
    );
    if (declaration.initializer) {
      this.taintExpression(
        resolved.module,
        declaration.initializer,
        property,
        hops,
        depth + 1,
        frame,
      );
    }
  }

  private taintParameter(
    fn: FunctionLikeNode,
    index: number,
    property: string | null,
    hops: number,
    frame: Frame | null,
  ) {
    for (let current = frame; current; current = current.parent) {
      if (current.callee !== fn) continue;
      for (const argument of this.argumentsForSlot(fn, index, current.call)) {
        this.taintExpression(
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
    if (!this.enter(fn, `param:${index}:${property ?? ""}:${hops}`, null)) {
      return;
    }
    for (const site of this.callSitesOf(fn)) {
      for (const argument of this.argumentsForSlot(fn, index, site.call)) {
        this.taintExpression(
          site.module,
          argument,
          property,
          hops + 1,
          0,
          null,
        );
      }
    }
  }

  /**
   * What else the scope that declares a tainted binding puts into it:
   * `token.x = v` and `Object.defineProperty(token, "x", …)` name a key,
   * `token = …` replaces the value and is tainted in turn.
   */
  private taintScopeWrites(
    module: ModuleInfo,
    scope: ScopeNode,
    name: string,
    property: string | null,
    hops: number,
    depth: number,
    frame: Frame | null,
  ) {
    if (!this.enter(scope, `writes:${name}:${property ?? ""}:${hops}`, frame)) {
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
            this.addKeyName(node.left.name.text);
          } else if (node.left.name.text === property) {
            this.taintExpression(
              module,
              node.right,
              null,
              hops,
              depth + 1,
              frame,
            );
          }
        } else if (ts.isIdentifier(node.left) && node.left.text === name) {
          this.taintExpression(
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
            this.taintExpression(module, source, null, hops, depth + 1, frame);
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
          this.addKeyName(key.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }

  run(): CssVariableProtocolResult {
    this.indexCallSites();
    this.closeSlotFunctions();
    for (const module of this.modules.values()) this.collectSinks(module);
    return { keyNames: this.keyNames, sinkSites: this.sinkSites };
  }
}

function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const current = map.get(key);
  if (current) current.add(value);
  else map.set(key, new Set([value]));
}

function parameterSlotKey(
  fn: FunctionLikeNode,
  index: number,
  property: string | null,
) {
  return `${fn.getSourceFile().fileName}\u0000${fn.pos}\u0000${index}\u0000${property ?? ""}`;
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function collectReturnExpressions(fn: FunctionLikeNode): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLikeNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns;
}

function templateContainsMarker(template: ts.TemplateExpression) {
  return (
    template.head.text.includes(CSS_VARIABLE_MARKER) ||
    template.templateSpans.some((span) =>
      span.literal.text.includes(CSS_VARIABLE_MARKER),
    )
  );
}

function concatenationContainsMarker(expression: ts.BinaryExpression) {
  let root: ts.Node = expression;
  while (
    ts.isBinaryExpression(root.parent) &&
    root.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    root = root.parent;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isStringLiteral(node) && node.text.includes(CSS_VARIABLE_MARKER)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

interface EnumeratedKeyBinding {
  key: string;
  scope: ts.Node;
  /** The object whose keys the binding walks. */
  source: ts.Expression;
}

/**
 * Bindings that receive the enumerated keys of some object, with the scope each
 * binding is live in: `Object.keys(o).forEach(k => …)`, `for (const k in o)`,
 * `for (const [k, v] of Object.entries(o))`, and the same through a local that
 * holds the key list.
 */
function collectEnumeratedKeyBindings(scope: ts.Node): EnumeratedKeyBinding[] {
  const bindings: EnumeratedKeyBinding[] = [];
  const aliases = new Map<string, ts.Expression>();

  const enumeratedObject = (node: ts.Expression): ts.Expression | null => {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    const [argument] = node.arguments;
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      KEY_ENUMERATION_METHODS.has(callee.name.text) &&
      argument
      ? argument
      : null;
  };

  const bindingNameOf = (name: ts.BindingName): string | null => {
    if (ts.isIdentifier(name)) return name.text;
    if (!ts.isArrayBindingPattern(name)) return null;
    const [first] = name.elements;
    return first && ts.isBindingElement(first) && ts.isIdentifier(first.name)
      ? first.name.text
      : null;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const enumerated = enumeratedObject(node.initializer);
      if (enumerated) aliases.set(node.name.text, enumerated);
    }
    const keyListSource = (expression: ts.Expression) =>
      enumeratedObject(expression) ??
      (ts.isIdentifier(expression)
        ? (aliases.get(expression.text) ?? null)
        : null);

    if (
      ts.isForInStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations[0]
    ) {
      const key = bindingNameOf(node.initializer.declarations[0].name);
      if (key) {
        bindings.push({ key, scope: node.statement, source: node.expression });
      }
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations[0]
    ) {
      const source = keyListSource(node.expression);
      const key = source
        ? bindingNameOf(node.initializer.declarations[0].name)
        : null;
      if (key && source) bindings.push({ key, scope: node.statement, source });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ITERATION_METHODS.has(node.expression.name.text)
    ) {
      const source = keyListSource(node.expression.expression);
      const [callback] = node.arguments;
      const parameter =
        callback && isFunctionLikeNode(callback)
          ? callback.parameters[0]
          : undefined;
      if (source && callback && isFunctionLikeNode(callback) && parameter) {
        const key = bindingNameOf(parameter.name);
        if (key && callback.body) {
          bindings.push({ key, scope: callback.body, source });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  // Two passes: the key list may be bound after the iteration site.
  visit(scope);
  visit(scope);

  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.key}\u0000${binding.scope.pos}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
