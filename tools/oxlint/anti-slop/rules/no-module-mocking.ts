import { defineRule } from "@oxlint/plugins";

import type { Definition, ESTree, Options, Scope, SourceCode, Variable } from "@oxlint/plugins";

type OptionRecord = Record<string, Options[number]>;

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

/** Names under which a test framework exposes its module mocking API. */
const testFrameworkObjectNames = new Set(["vi", "jest"]);

const defaultModules: readonly string[] = ["vitest", "@jest/globals", "jest", "bun:test"];

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function isOptionRecord(option: Options[number] | undefined): option is OptionRecord {
  return typeof option === "object" && option !== null && !Array.isArray(option);
}

/** Configuring `modules` replaces the default list rather than adding to it. */
function testFrameworkModules(options: Readonly<Options>): readonly string[] {
  const option = options[0];
  if (!isOptionRecord(option)) return defaultModules;
  const configured = option.modules;
  if (!Array.isArray(configured)) return defaultModules;
  const modules = configured.filter((module): module is string => typeof module === "string");
  return modules.length === 0 ? defaultModules : modules;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function stringLiteralValue(node: ESTree.Node): string | null {
  if (node.type !== "Literal") return null;
  const value = node.value;
  return typeof value === "string" ? value : null;
}

/** The statically known property name of a member access, whether written `a.b` or `a["b"]`. */
function memberPropertyName(member: ESTree.MemberExpression): string | null {
  const property = member.property;
  if (member.computed) return stringLiteralValue(property);
  return property.type === "Identifier" ? property.name : null;
}

/** The specifier of `require("vitest")`, or of a static or dynamic `import("vitest")`. */
function loadedModule(expression: ESTree.Expression): string | null {
  const source = expression.type === "AwaitExpression" ? expression.argument : expression;
  if (source.type === "ImportExpression") return stringLiteralValue(source.source);
  if (source.type !== "CallExpression") return null;
  if (source.callee.type !== "Identifier" || source.callee.name !== "require") return null;
  const specifier = source.arguments.at(0);
  return specifier === undefined ? null : stringLiteralValue(specifier);
}

/** Covers named, default, and namespace imports, since all three reach the same mocking API. */
function isTestFrameworkImport(definition: Definition, modules: readonly string[]): boolean {
  if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
    return false;
  }
  if (!modules.includes(definition.parent.source.value)) return false;
  const specifier = definition.node;
  if (
    specifier.type === "ImportDefaultSpecifier" ||
    specifier.type === "ImportNamespaceSpecifier"
  ) {
    return true;
  }
  const name = importedName(specifier);
  return name !== null && testFrameworkObjectNames.has(name);
}

/** Whether a pattern binds `bindingName` to the whole module or to its mocking API. */
function bindsTestFrameworkObject(pattern: ESTree.BindingPattern, bindingName: string): boolean {
  if (pattern.type === "Identifier") return true;
  if (pattern.type !== "ObjectPattern") return false;
  return pattern.properties.some((property) => {
    if (property.type !== "Property") return false;
    const value = property.value;
    if (value.type !== "Identifier" || value.name !== bindingName) return false;
    const key = property.key;
    const name = property.computed
      ? stringLiteralValue(key)
      : key.type === "Identifier"
        ? key.name
        : null;
    return name !== null && testFrameworkObjectNames.has(name);
  });
}

function isTestFrameworkRequire(
  definition: Definition,
  bindingName: string,
  modules: readonly string[],
): boolean {
  if (definition.type !== "Variable") return false;
  const declarator = definition.node;
  if (declarator.type !== "VariableDeclarator") return false;
  const initializer = declarator.init;
  if (initializer === null) return false;
  const module = loadedModule(initializer);
  if (module === null || !modules.includes(module)) return false;
  return bindsTestFrameworkObject(declarator.id, bindingName);
}

function isTestFrameworkObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  modules: readonly string[],
): boolean {
  // `vitest.vi.mock(…)` reaches the same API as `vi.mock(…)`, so a member access whose property
  // names the framework object is resolved against the module binding underneath it.
  if (expression.type === "MemberExpression") {
    const object = memberPropertyName(expression);
    if (object === null || !testFrameworkObjectNames.has(object)) return false;
    return isTestFrameworkObject(sourceCode, expression.object, modules);
  }
  if (expression.type !== "Identifier") return false;
  if (testFrameworkObjectNames.has(expression.name) && sourceCode.isGlobalReference(expression)) {
    return true;
  }

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) {
    return testFrameworkObjectNames.has(expression.name);
  }
  return variable.defs.some(
    (definition) =>
      isTestFrameworkImport(definition, modules) ||
      isTestFrameworkRequire(definition, variable.name, modules),
  );
}

function moduleMockCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  modules: readonly string[],
): boolean {
  if (callee.type !== "MemberExpression") return false;
  if (!isTestFrameworkObject(sourceCode, callee.object, modules)) return false;
  const method = memberPropertyName(callee);
  return method !== null && moduleMockMethods.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest, Jest, and Bun test module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
    schema: [
      {
        type: "object",
        properties: {
          modules: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ modules: [...defaultModules] }],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const modules = testFrameworkModules(context.options);
        if (moduleMockCall(context.sourceCode, node.callee, modules)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
