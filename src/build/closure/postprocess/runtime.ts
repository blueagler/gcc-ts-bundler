import ts from "@typescript/typescript6";

/**
 * Script-mode chunks reference Closure's `--rename_prefix_namespace` symbols
 * through `$gcc`; every wrapped chunk shares the object via `globalThis`.
 *
 * This is the only bundler-runtime output rewrite left. The alias
 * canonicalisation that used to run beside it ran `String.replaceAll` over
 * minified JavaScript and rewrote string literals and unrelated property
 * accesses along with the aliases it was aiming at (`"tab.js"` -> `"taG.js"`,
 * `o.b.c` -> `o.G.c`). It only ever fired for the post-Closure ES5 helper bag,
 * which no longer exists: helper pooling happens before Closure, so no chunk
 * grows a second runtime-root alias to collapse.
 */
export function wrapBundlerRuntimeOutputFile(code: string) {
  const trimmed = code.trimEnd();
  return `!function(){\nvar $gcc=globalThis.$gcc=globalThis.$gcc||{};\n${trimmed}\n}();\n`;
}

/**
 * Removes the eager-only ESM runtime after Closure has optimized the ordinary
 * runtime-shaped input. Keeping that input shape is intentional: deleting the
 * preamble before ADVANCED changed name allocation enough to grow jQuery by
 * several kilobytes. The native capability gate marks only a one-chunk graph
 * with no registry/helper calls or runtime CSS, and this final step accepts
 * only the generated leading runtime IIFE plus its loaded-state kick.
 */
export function stripBundlerRuntimeOutputFile(code: string) {
  const sourceFile = ts.createSourceFile(
    "bundler-runtime-output.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const statements = [...sourceFile.statements];
  const preambles = statements.filter((statement) =>
    isRuntimePreamble(statement, sourceFile),
  );
  if (preambles.length !== 1) {
    throw new Error(
      `Runtime elision expected exactly one generated bundler runtime preamble; found ${preambles.length}.`,
    );
  }

  const aliasStatements = statements.filter((statement) =>
    isRuntimeAliasStatement(statement, sourceFile),
  );
  if (aliasStatements.length > 1) {
    throw new Error(
      `Runtime elision expected at most one generated runtime alias statement; found ${aliasStatements.length}.`,
    );
  }
  const aliasStatement = aliasStatements[0];
  const runtimeAliases = new Set<string>();
  if (aliasStatement && ts.isVariableStatement(aliasStatement)) {
    for (const declaration of aliasStatement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        runtimeAliases.add(declaration.name.text);
      }
    }
  }

  const loadedCalls = statements.filter(
    (statement) =>
      statement !== preambles[0] &&
      isRuntimeLoadedCall(statement, sourceFile, runtimeAliases),
  );
  if (loadedCalls.length !== 1) {
    throw new Error(
      `Runtime elision expected exactly one generated base-chunk loaded call; found ${loadedCalls.length}.`,
    );
  }

  const removals = [preambles[0], loadedCalls[0], aliasStatement]
    .filter((statement): statement is ts.Statement => statement !== undefined)
    .map((statement) => ({
      end: statement.end,
      start: statement.getFullStart(),
    }))
    .sort((left, right) => right.start - left.start);
  let output = code;
  for (const removal of removals) {
    output = output.slice(0, removal.start) + output.slice(removal.end);
  }
  return output;
}

function isRuntimePreamble(statement: ts.Statement, sourceFile: ts.SourceFile) {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const call = statement.expression;
  if (!ts.isCallExpression(call) || call.arguments.length !== 2) {
    return false;
  }
  const callee = call.expression;
  const [thisArgument, globalArgument] = call.arguments;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "call" ||
    thisArgument === undefined ||
    thisArgument.kind !== ts.SyntaxKind.ThisKeyword ||
    globalArgument === undefined ||
    !ts.isIdentifier(globalArgument) ||
    globalArgument.text !== "globalThis"
  ) {
    return false;
  }
  let receiver: ts.Expression = callee.expression;
  while (ts.isParenthesizedExpression(receiver)) {
    receiver = receiver.expression;
  }
  if (!ts.isFunctionExpression(receiver)) {
    return false;
  }
  const text = statement.getText(sourceFile);
  return text.includes("__g") && text.includes("new Promise");
}

function isRuntimeAliasStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
) {
  if (!ts.isVariableStatement(statement)) {
    return false;
  }
  const declarations = statement.declarationList.declarations;
  if (declarations.length < 4) {
    return false;
  }
  const first = declarations[0];
  if (
    !first ||
    !ts.isIdentifier(first.name) ||
    first.initializer === undefined
  ) {
    return false;
  }
  const initializer = first.initializer.getText(sourceFile);
  return (
    initializer === "globalThis.__g" || initializer === 'globalThis["__g"]'
  );
}

function isRuntimeLoadedCall(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  runtimeAliases: Set<string>,
) {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const expression = statement.expression;
  if (!ts.isCallExpression(expression)) {
    return false;
  }
  const [argument] = expression.arguments;
  if (
    expression.arguments.length > 1 ||
    (argument !== undefined && !ts.isNumericLiteral(argument))
  ) {
    return false;
  }
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver) && runtimeAliases.has(receiver.text)) {
    return true;
  }
  const receiverText = receiver.getText(sourceFile);
  return (
    receiverText === "globalThis.__g" || receiverText === 'globalThis["__g"]'
  );
}
