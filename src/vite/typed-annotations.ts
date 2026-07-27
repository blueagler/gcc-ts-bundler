/**
 * Extracts Closure JSDoc from the app's TypeScript types.
 *
 * Vite hands us transpiled JS with the types erased, so this re-reads the
 * authored `.ts`/`.tsx` sources through a `ts.Program` and re-attaches the
 * type information as JSDoc on the *materialized* modules native emit reads.
 *
 * v1 is deliberately narrow, because a wrong type changes Closure's output
 * silently while a missing type only costs optimisation:
 *
 * - function declarations get `@param`/`@return` only when **every** parameter
 *   and the return type is a primitive or a class declared in the same module;
 * - single-declarator top-level `const`/`let`/`var` get `@type` under the same
 *   type rule;
 * - classes get no JSDoc of their own — Closure already reads ES6 `class`
 *   structure natively, and `/** @constructor *\/ class Foo {}` is a
 *   `JSC_MISPLACED_ANNOTATION` — but their primitive-typed fields get a
 *   per-member `@type`, which is what completes Closure's per-type dead
 *   property removal (docs/research/typed-input.md §4a experiment A2).
 *
 * v2 also allows a signature to name a class imported from another module of
 * the same program. Type references are written with the name **as it appears
 * in this module** (the local import alias), because native rewrites names
 * inside the block through exactly the maps it applies to the code: the
 * same-module `$$ordinal` rename map and the hoisted import planner's
 * local-to-origin map. Whether a given import survives as a direct binding or
 * degrades to a registry slot depends on the hoist plan, which is decided in
 * native long after this runs — so this side cannot pre-filter, and native
 * drops any block whose names it cannot resolve.
 */
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import type {
  TypedAnnotationBinding,
  TypedAnnotationFile,
  TypedAnnotationMember,
} from "../api/types";
import { loadCompilerOptions } from "../build/transpile/compiler-options";

/** One materialized module paired with the source it was transpiled from. */
export interface TypedAnnotationCandidate {
  /** Absolute path of the materialized module native emit reads. */
  materializedFilePath: string;
  /** Absolute path of the authored `.ts`/`.tsx` source. */
  sourceFilePath: string;
}

export interface TypedAnnotationResult {
  bindingCount: number;
  files: TypedAnnotationFile[];
}

const EMPTY_RESULT: TypedAnnotationResult = { bindingCount: 0, files: [] };

/**
 * True for module ids we can type: an authored `.ts`/`.tsx` file inside the
 * project, with no Vite query suffix and outside `node_modules`. Everything
 * else (`.svelte`, `.vue`, virtual modules, dependencies) is skipped — those
 * go through framework compilers whose output bindings do not correspond to
 * anything the checker can see.
 */
export function isTypedAnnotationSource(
  moduleId: string,
  projectRoot: string,
): boolean {
  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return false;
  }
  // A query means Vite rewrote the module; the materialized name gets a hash
  // suffix and the text no longer matches the authored source one-to-one.
  if (/[?#]/u.test(moduleId)) {
    return false;
  }
  if (!path.isAbsolute(moduleId)) {
    return false;
  }
  const relative = path.relative(projectRoot, moduleId);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  if (relative.split(path.sep).includes("node_modules")) {
    return false;
  }
  return /\.tsx?$/u.test(moduleId);
}

export async function extractTypedAnnotations(input: {
  candidates: readonly TypedAnnotationCandidate[];
  projectRoot: string;
}): Promise<TypedAnnotationResult> {
  if (input.candidates.length === 0) {
    return EMPTY_RESULT;
  }
  const configPath = ts.findConfigFile(
    input.projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    // No tsconfig: no types to read, and guessing compiler options would make
    // the checker disagree with the app's own build. Emit nothing.
    return EMPTY_RESULT;
  }

  let compilerOptions: ts.CompilerOptions;
  try {
    compilerOptions = await loadCompilerOptions(configPath, {
      allowJs: true,
      checkJs: false,
      declaration: false,
      ignoreDeprecations: "6.0",
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    });
  } catch {
    return EMPTY_RESULT;
  }

  const rootNames = [
    ...new Set(input.candidates.map((candidate) => candidate.sourceFilePath)),
  ].sort((left, right) => left.localeCompare(right));
  const program = ts.createProgram(rootNames, compilerOptions);
  const checker = program.getTypeChecker();

  const files: TypedAnnotationFile[] = [];
  let bindingCount = 0;
  await Promise.all(
    input.candidates.map(async (candidate) => {
      const sourceFile = program.getSourceFile(candidate.sourceFilePath);
      if (!sourceFile) {
        return;
      }
      const bindings = collectSourceFileBindings(sourceFile, checker);
      if (bindings.length === 0) {
        return;
      }
      let materializedText: string;
      try {
        materializedText = await fs.readFile(
          candidate.materializedFilePath,
          "utf-8",
        );
      } catch {
        return;
      }
      // esbuild keeps top-level names, but plugins in the chain may not: an
      // annotation whose binding is not in the emitted text would either be
      // dropped or, worse, land on an unrelated declaration.
      const surviving = bindings.filter((binding) =>
        declaresBinding(materializedText, binding.name),
      );
      if (surviving.length === 0) {
        return;
      }
      bindingCount += surviving.length;
      files.push({
        bindings: surviving,
        filePath: candidate.materializedFilePath,
      });
    }),
  );

  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return { bindingCount, files };
}

function declaresBinding(text: string, name: string) {
  return new RegExp(`(?:^|[^\\w$.])${escapeRegExp(name)}(?![\\w$])`, "u").test(
    text,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectSourceFileBindings(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): TypedAnnotationBinding[] {
  const names = collectLocalTypeNames(sourceFile, checker);
  const bindings: TypedAnnotationBinding[] = [];
  for (const statement of sourceFile.statements) {
    const binding =
      buildFunctionBinding(statement, names, checker) ??
      buildVariableBinding(statement, names, checker) ??
      buildClassBinding(statement, names, checker);
    if (binding) {
      bindings.push(binding);
    }
  }
  return bindings;
}

/**
 * Every class this module may name in a type, mapped from its symbol to the
 * identifier **this module** uses for it: its own name for a local class, the
 * import alias for an imported one. Native resolves those same identifiers
 * through the rename and import maps it applies to the code.
 */
type LocalTypeNames = ReadonlyMap<ts.Symbol, string>;

function collectLocalTypeNames(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): LocalTypeNames {
  const names = new Map<ts.Symbol, string>();
  const record = (local: ts.Identifier) => {
    const symbol = checker.getSymbolAtLocation(local);
    if (!symbol) {
      return;
    }
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    if (isEligibleClassSymbol(target)) {
      names.set(target, local.text);
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      record(statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const { name, namedBindings } = statement.importClause;
    if (name) {
      record(name);
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        if (!specifier.isTypeOnly) {
          record(specifier.name);
        }
      }
    }
  }
  return names;
}

/**
 * A class is nameable as a Closure type only if it is a non-generic class
 * *declaration* in a program source file we emit. Generics would need
 * `@template`; ambient `.d.ts` classes and dependencies have no emitted
 * binding for native to rewrite the name to.
 */
function isEligibleClassSymbol(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) {
    return false;
  }
  const declaration = declarations[0];
  if (
    !declaration ||
    !ts.isClassDeclaration(declaration) ||
    !declaration.name ||
    declaration.typeParameters?.length
  ) {
    return false;
  }
  const file = declaration.getSourceFile();
  return (
    !file.isDeclarationFile &&
    ts.isSourceFile(declaration.parent) &&
    !file.fileName.includes("/node_modules/")
  );
}

function buildFunctionBinding(
  statement: ts.Statement,
  names: LocalTypeNames,
  checker: ts.TypeChecker,
): TypedAnnotationBinding | null {
  if (!ts.isFunctionDeclaration(statement)) {
    return null;
  }
  // No body means an overload signature; generics would need @template.
  if (!statement.name || !statement.body || statement.typeParameters?.length) {
    return null;
  }

  const tags: string[] = [];
  for (const parameter of statement.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.questionToken ||
      parameter.dotDotDotToken ||
      parameter.initializer
    ) {
      // Destructuring has no single name to annotate; optional and rest
      // parameters need `{T=}`/`{...T}`, which v1 does not emit.
      return null;
    }
    const rendered = renderClosureType(
      checker.getTypeAtLocation(parameter),
      names,
      { allowVoid: false },
    );
    if (!rendered) {
      return null;
    }
    tags.push(`@param {${rendered}} ${parameter.name.text}`);
  }

  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const returnType = renderClosureType(
    checker.getReturnTypeOfSignature(signature),
    names,
    { allowVoid: true },
  );
  if (!returnType) {
    return null;
  }
  tags.push(`@return {${returnType}}`);

  return { jsdoc: renderJsDoc(tags), name: statement.name.text };
}

function buildVariableBinding(
  statement: ts.Statement,
  names: LocalTypeNames,
  checker: ts.TypeChecker,
): TypedAnnotationBinding | null {
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  // Native attaches JSDoc to single-declarator statements only.
  const declaration = statement.declarationList.declarations[0];
  if (statement.declarationList.declarations.length !== 1 || !declaration) {
    return null;
  }
  if (!ts.isIdentifier(declaration.name)) {
    return null;
  }
  const rendered = renderClosureType(
    checker.getTypeAtLocation(declaration.name),
    names,
    { allowVoid: false },
  );
  if (!rendered) {
    return null;
  }
  return {
    jsdoc: renderJsDoc([`@type {${rendered}}`]),
    name: declaration.name.text,
  };
}

/**
 * A class contributes no block of its own, only per-member `@type` for its
 * primitive-typed fields. That is the half of Closure's per-type dead
 * property removal v1 was missing: without a field type, a property name read
 * anywhere keeps the field alive in every class that shares the name
 * (docs/research/typed-input.md §4a, experiment A2).
 *
 * Both shapes are collected, because which one survives to the materialized
 * module depends on the transpiler's class-fields setting: a declared
 * `size: number` with no initializer is erased entirely, leaving only the
 * constructor's `this.size = 1`.
 */
function buildClassBinding(
  statement: ts.Statement,
  names: LocalTypeNames,
  checker: ts.TypeChecker,
): TypedAnnotationBinding | null {
  if (
    !ts.isClassDeclaration(statement) ||
    !statement.name ||
    statement.typeParameters?.length
  ) {
    return null;
  }
  // A name seen at two sites with two renderings is ambiguous; `null` marks
  // it so a later site cannot resurrect a type the first one contradicted.
  const rendered = new Map<string, string | null>();
  const add = (name: string, type: string | null) => {
    if (rendered.has(name) && rendered.get(name) !== type) {
      rendered.set(name, null);
      return;
    }
    rendered.set(name, type);
  };

  for (const member of statement.members) {
    if (ts.isPropertyDeclaration(member)) {
      // `static x` prints as `static x = ...`, whose first token is not the
      // key, so native would never match it; skipping keeps both sides
      // agreeing on what is annotatable.
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
        continue;
      }
      if (ts.isIdentifier(member.name)) {
        add(member.name.text, renderMemberType(member.name, names, checker));
      }
      continue;
    }
    if (ts.isConstructorDeclaration(member) && member.body) {
      for (const target of constructorFieldTargets(member.body)) {
        add(target.name.text, renderMemberType(target, names, checker));
      }
    }
  }

  const members: TypedAnnotationMember[] = [];
  for (const [name, type] of rendered) {
    if (type) {
      members.push({ jsdoc: renderJsDoc([`@type {${type}}`]), name });
    }
  }
  if (members.length === 0) {
    return null;
  }
  members.sort((left, right) => left.name.localeCompare(right.name));
  return { jsdoc: "", members, name: statement.name.text };
}

function hasModifier(member: ts.ClassElement, kind: ts.SyntaxKind) {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === kind)
  );
}

/**
 * `this.<name>` assignment targets at the top level of a constructor body.
 * Nesting is not followed: native only matches one indent step inside the
 * class body, and a conditional assignment is a weaker type claim anyway.
 */
function constructorFieldTargets(body: ts.Block) {
  const targets: ts.PropertyAccessExpression[] = [];
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement)) {
      continue;
    }
    const { expression } = statement;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const target = expression.left;
    if (
      ts.isPropertyAccessExpression(target) &&
      target.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(target.name)
    ) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * The declared type of the property a node names, not the type of one
 * assignment: a field written with two different types has a union symbol
 * type, which `renderClosureType` refuses, whereas a single assignment would
 * have looked unambiguous.
 */
function renderMemberType(
  node: ts.Node,
  names: LocalTypeNames,
  checker: ts.TypeChecker,
): string | null {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return null;
  }
  return renderClosureType(
    checker.getTypeOfSymbolAtLocation(symbol, node),
    names,
    { allowVoid: false },
  );
}

function renderJsDoc(tags: readonly string[]) {
  return `/** ${tags.join(" ")} */\n`;
}

/**
 * Maps a TypeScript type onto a Closure type expression, or `null` when we
 * refuse to describe it. Unions (other than `boolean`), enums, `any`,
 * nullables, generics and object literals all return `null`.
 */
function renderClosureType(
  type: ts.Type,
  names: LocalTypeNames,
  options: { allowVoid: boolean },
): string | null {
  const { flags } = type;
  // `boolean` is itself a `true | false` union, so it has to be recognised
  // before unions are rejected.
  if (flags & ts.TypeFlags.Boolean) {
    return "boolean";
  }
  if (type.isUnion() || type.isIntersection()) {
    return null;
  }
  if (flags & ts.TypeFlags.EnumLike) {
    return null;
  }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return "boolean";
  }
  if (flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
    return "number";
  }
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) {
    return "string";
  }
  if (options.allowVoid && flags & ts.TypeFlags.Void) {
    return "void";
  }
  const symbol = type.getSymbol();
  // Only a class this module can *name* is expressible: the emitted type
  // reference is that local identifier, which native then rewrites the same
  // way it rewrites the code's uses of it.
  const localName = symbol ? names.get(symbol) : undefined;
  return localName ? `!${localName}` : null;
}
