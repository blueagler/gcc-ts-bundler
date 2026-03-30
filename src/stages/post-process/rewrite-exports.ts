import {
  minify,
  parseSync,
  printSync,
  type AssignmentExpression,
  type ExpressionStatement,
  type Identifier,
  type MemberExpression,
  type Module,
  type ModuleItem,
} from "@swc/core";

import { PostProcessMinify } from "../../api/types";

const DEFAULT_EXPORT_IDENTIFIER = "__DEFAULT_EXPORT__";
const GCC_IDENTIFIER = "GCC";
const SWC_PARSE_OPTIONS = {
  syntax: "ecmascript",
  target: "es2022",
} as const;

export async function rewriteClosureExports({
  code,
  minifyOutput,
  rewriteExports,
}: {
  code: string;
  minifyOutput: PostProcessMinify;
  rewriteExports: boolean;
}): Promise<string> {
  if (code.length === 0) {
    return code;
  }

  let transformedCode = code;
  if (rewriteExports && code.includes("globalThis.GCC")) {
    const module = parseSync(code, SWC_PARSE_OPTIONS);
    transformedCode = printSync(convertGccExportsToEsm(module)).code;
  }

  if (minifyOutput !== "swc") {
    return transformedCode;
  }

  const result = await minify(transformedCode, {
    compress: true,
    mangle: true,
    module: true,
  });

  if (!result.code) {
    throw new Error("SWC minify produced no output.");
  }

  return result.code;
}

function convertGccExportsToEsm(module: Module): Module {
  const body: ModuleItem[] = [];
  const exportsMap = new Map<string, string>();
  const processedExports = new Set<string>();
  const existingExportNames = new Set<string>();
  let hasDefaultExport = false;

  for (const item of module.body) {
    if (item.type === "ExportNamedDeclaration") {
      for (const specifier of item.specifiers) {
        if (specifier.type !== "ExportSpecifier") {
          continue;
        }

        existingExportNames.add(
          getModuleExportName(specifier.exported ?? specifier.orig),
        );
      }
      continue;
    }

    if (
      item.type === "ExportDefaultDeclaration" ||
      item.type === "ExportDefaultExpression"
    ) {
      hasDefaultExport = true;
    }
  }

  for (const item of module.body) {
    const gccExport = getGccExportAssignment(item);
    if (!gccExport) {
      body.push(item);
      continue;
    }

    if (processedExports.has(gccExport.exportName)) {
      continue;
    }

    processedExports.add(gccExport.exportName);
    const localName =
      gccExport.exportName === DEFAULT_EXPORT_IDENTIFIER
        ? "__gcc_default_export__"
        : `__gcc_export_${sanitizeIdentifier(gccExport.exportName)}`;

    exportsMap.set(gccExport.exportName, localName);
    body.push(createConstDeclaration(localName, gccExport.right));
  }

  for (const [exportName, localName] of exportsMap) {
    if (exportName === DEFAULT_EXPORT_IDENTIFIER) {
      if (!hasDefaultExport) {
        body.push(createDefaultExport(localName));
      }
      continue;
    }

    if (!existingExportNames.has(exportName)) {
      body.push(createNamedExport(localName, exportName));
    }
  }

  module.body = body;
  return module;
}

function getGccExportAssignment(
  item: ModuleItem,
): { exportName: string; right: AssignmentExpression["right"] } | undefined {
  if (item.type !== "ExpressionStatement") {
    return undefined;
  }

  const statement = item as ExpressionStatement;
  if (statement.expression.type !== "AssignmentExpression") {
    return undefined;
  }

  const expression = statement.expression as AssignmentExpression;
  if (expression.left.type !== "MemberExpression") {
    return undefined;
  }

  const left = expression.left as MemberExpression;
  if (left.object.type !== "MemberExpression") {
    return undefined;
  }

  const object = left.object as MemberExpression;
  if (
    object.object.type !== "Identifier" ||
    (object.object as Identifier).value !== "globalThis" ||
    getMemberPropertyName(object) !== GCC_IDENTIFIER
  ) {
    return undefined;
  }

  const exportName = getMemberPropertyName(left);
  if (!exportName) {
    return undefined;
  }

  return { exportName, right: expression.right };
}

function getMemberPropertyName(node: MemberExpression): string | undefined {
  const property = node.property as { type: string; value?: string };
  if (property.type === "Identifier" || property.type === "StringLiteral") {
    return property.value;
  }
  return undefined;
}

function getModuleExportName(
  node: Identifier | { type: "StringLiteral"; value: string },
): string {
  return node.type === "Identifier" ? node.value : node.value;
}

function sanitizeIdentifier(name: string): string {
  return name.replace(/[^\w$]/g, "_");
}

function parseModuleItem(code: string): ModuleItem {
  const module = parseSync(code, SWC_PARSE_OPTIONS);
  const [item] = module.body;
  if (!item) {
    throw new Error(`Failed to parse module item: ${code}`);
  }
  return item;
}

function createConstDeclaration(
  localName: string,
  right: AssignmentExpression["right"],
): ModuleItem {
  const declaration = parseModuleItem(`const ${localName} = null;`);
  if (declaration.type !== "VariableDeclaration") {
    throw new Error("Failed to create variable declaration.");
  }

  declaration.declarations[0].init = right;
  return declaration;
}

function createDefaultExport(localName: string): ModuleItem {
  return parseModuleItem(`export default ${localName};`);
}

function createNamedExport(localName: string, exportName: string): ModuleItem {
  const exportedName = /^[A-Za-z_$][\w$]*$/.test(exportName)
    ? exportName
    : JSON.stringify(exportName);
  return parseModuleItem(`export { ${localName} as ${exportedName} };`);
}
