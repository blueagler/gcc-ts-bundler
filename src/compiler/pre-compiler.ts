import {
  parseSync,
  printSync,
  type ExportAllDeclaration,
  type ExportDeclaration,
  type ExportDefaultDeclaration,
  type ExportDefaultExpression,
  type ExportNamedDeclaration,
  type FunctionExpression,
  type ImportDeclaration,
  type Module,
  type ModuleExportName,
  type ModuleItem,
  type VariableDeclaration,
} from "@swc/core";
import { existsSync, promises as fs } from "fs";
import path from "path";

const modulePathCache = new Map<string, string>();
const parsedModuleCache = new Map<string, Module>();
const DEFAULT_EXPORT_IDENTIFIER = "__DEFAULT_EXPORT__";
const GCC = "GCC";

function getParseOptions(filePath: string) {
  return {
    syntax: "typescript",
    target: "es2022",
    decorators: true,
    dts: filePath.endsWith(".d.ts"),
    tsx: filePath.endsWith(".tsx"),
  } as const;
}

export async function customTransform(
  code: string,
  filePath: string,
  isEntryPoint: boolean,
  projectRoot: string,
): Promise<string> {
  if (code.length === 0 || !isEntryPoint) {
    return code;
  }

  await preloadModules(filePath, projectRoot);
  const module = parseSync(code, getParseOptions(filePath));
  const transformed = transformEntryModule(module, filePath);

  return printSync(transformed).code;
}

async function getParsedModule(filePath: string): Promise<Module> {
  const cachedModule = parsedModuleCache.get(filePath);
  if (cachedModule) {
    return cachedModule;
  }

  const code = await fs.readFile(filePath, "utf-8");
  const module = parseSync(code, getParseOptions(filePath));
  parsedModuleCache.set(filePath, module);

  return module;
}

function collectStaticDependencies(
  module: Module,
  importerFile: string,
  projectRoot: string,
): string[] {
  const dependencies = new Set<string>();

  for (const item of module.body) {
    if (item.type === "ImportDeclaration") {
      const resolvedPath = resolveModulePath(
        item.source.value,
        importerFile,
        projectRoot,
      );
      if (resolvedPath) {
        dependencies.add(resolvedPath);
      }
      continue;
    }

    if (item.type === "ExportAllDeclaration") {
      const resolvedPath = resolveModulePath(
        item.source.value,
        importerFile,
        projectRoot,
      );
      if (resolvedPath) {
        dependencies.add(resolvedPath);
      }
      continue;
    }

    if (item.type === "ExportNamedDeclaration" && item.source) {
      const resolvedPath = resolveModulePath(
        item.source.value,
        importerFile,
        projectRoot,
      );
      if (resolvedPath) {
        dependencies.add(resolvedPath);
      }
    }
  }

  return Array.from(dependencies);
}

async function preloadModules(entryFilePath: string, projectRoot: string) {
  const pendingFiles = [entryFilePath];
  const visitedFiles = new Set<string>();

  while (pendingFiles.length > 0) {
    const currentFile = pendingFiles.pop()!;
    if (visitedFiles.has(currentFile)) {
      continue;
    }

    visitedFiles.add(currentFile);
    const module = await getParsedModule(currentFile);

    for (const dependency of collectStaticDependencies(
      module,
      currentFile,
      projectRoot,
    )) {
      if (!visitedFiles.has(dependency)) {
        pendingFiles.push(dependency);
      }
    }
  }
}

function resolveModulePath(
  source: string,
  importerFile: string,
  projectRoot: string,
): string | undefined {
  if (!source.startsWith(".") && !path.isAbsolute(source)) {
    return undefined;
  }

  const resolvedBasePath = path.resolve(path.dirname(importerFile), source);
  if (!resolvedBasePath.startsWith(projectRoot + path.sep)) {
    return undefined;
  }

  if (modulePathCache.has(resolvedBasePath)) {
    return modulePathCache.get(resolvedBasePath)!;
  }

  const candidates = [resolvedBasePath];
  const extensions = [".ts", ".d.ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    candidates.push(`${resolvedBasePath}${ext}`);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      modulePathCache.set(resolvedBasePath, candidate);
      return candidate;
    }
  }

  throw new Error(`Module not found: ${source}`);
}

function transformEntryModule(module: Module, filePath: string): Module {
  const body: ModuleItem[] = [];
  const globalIdentifiers = new Set<string>();
  const existingImports = new Map<string, Set<string>>();

  for (const item of module.body) {
    if (item.type === "ImportDeclaration") {
      recordImportedSpecifiers(existingImports, item);
      body.push(item);
      continue;
    }

    if (item.type === "ExportDefaultDeclaration") {
      const localName = DEFAULT_EXPORT_IDENTIFIER;
      globalIdentifiers.add(localName);
      body.push(...rewriteDefaultDeclaration(item, localName));
      continue;
    }

    if (item.type === "ExportDefaultExpression") {
      const localName = DEFAULT_EXPORT_IDENTIFIER;
      globalIdentifiers.add(localName);
      body.push(...rewriteDefaultExpression(item, localName));
      continue;
    }

    if (item.type === "ExportNamedDeclaration" && item.source) {
      body.push(...createImportsForReExport(item, existingImports));
      collectExportedNamesFromReExport(item, globalIdentifiers);
      body.push(item);
      continue;
    }

    if (item.type === "ExportAllDeclaration") {
      body.push(...createImportsForExportAll(item, filePath, existingImports));
      collectExportNamesFromExportAll(item, filePath, globalIdentifiers);
      body.push(item);
      continue;
    }

    if (
      item.type === "ExportNamedDeclaration" ||
      item.type === "ExportDeclaration"
    ) {
      collectExportedNames(item, globalIdentifiers);
    }

    body.push(item);
  }

  const moduleWithAssignments = [...body];
  const identifiersToAssign = Array.from(globalIdentifiers).sort();

  if (identifiersToAssign.length > 0) {
    moduleWithAssignments.unshift(createGlobalDeclaration(identifiersToAssign));
    moduleWithAssignments.push(...createGccAssignments(identifiersToAssign));
  }

  module.body = moduleWithAssignments;
  return module;
}

function recordImportedSpecifiers(
  existingImports: Map<string, Set<string>>,
  declaration: ImportDeclaration,
) {
  const importedNames =
    existingImports.get(declaration.source.value) ?? new Set<string>();
  for (const specifier of declaration.specifiers) {
    if (specifier.type === "ImportSpecifier") {
      importedNames.add(specifier.local.value);
    }
  }
  existingImports.set(declaration.source.value, importedNames);
}

function rewriteDefaultDeclaration(
  declaration: ExportDefaultDeclaration,
  localName: string,
): ModuleItem[] {
  return rewriteDefaultNode(declaration.decl, localName);
}

function rewriteDefaultExpression(
  declaration: ExportDefaultExpression,
  localName: string,
): ModuleItem[] {
  const constDeclaration = parseModuleItems(`const ${localName} = null;`)[0];
  if (constDeclaration.type !== "VariableDeclaration") {
    throw new Error("Failed to create default export declaration.");
  }
  (constDeclaration as VariableDeclaration).declarations[0].init =
    declaration.expression;
  return [
    constDeclaration,
    parseModuleItems(`export default ${localName};`)[0],
  ];
}

function rewriteDefaultNode(
  declaration: ExportDefaultDeclaration["decl"],
  localName: string,
): ModuleItem[] {
  if (declaration.type === "TsInterfaceDeclaration") {
    return [parseModuleItems(`export default undefined;`)[0]];
  }

  const constDeclaration = parseModuleItems(`const ${localName} = null;`)[0];
  if (constDeclaration.type !== "VariableDeclaration") {
    throw new Error("Failed to create default export declaration.");
  }
  (constDeclaration as VariableDeclaration).declarations[0].init =
    declaration as FunctionExpression;

  return [
    constDeclaration,
    parseModuleItems(`export default ${localName};`)[0],
  ];
}

function createImportsForReExport(
  declaration: ExportNamedDeclaration,
  existingImports: Map<string, Set<string>>,
): ModuleItem[] {
  if (!declaration.source) {
    return [];
  }

  const importedNames =
    existingImports.get(declaration.source.value) ?? new Set<string>();
  const specifiers: string[] = [];

  for (const specifier of declaration.specifiers) {
    if (specifier.type !== "ExportSpecifier") {
      continue;
    }

    const localName = getModuleExportName(specifier.exported ?? specifier.orig);
    if (importedNames.has(localName)) {
      continue;
    }

    importedNames.add(localName);
    const importName = getModuleExportName(specifier.orig);
    specifiers.push(
      importName === localName ? importName : `${importName} as ${localName}`,
    );
  }

  existingImports.set(declaration.source.value, importedNames);
  if (specifiers.length === 0) {
    return [];
  }

  return parseModuleItems(
    `import { ${specifiers.join(", ")} } from ${JSON.stringify(
      declaration.source.value,
    )};`,
  );
}

function createImportsForExportAll(
  declaration: ExportAllDeclaration,
  importerFile: string,
  existingImports: Map<string, Set<string>>,
): ModuleItem[] {
  const source = declaration.source.value;
  const importedNames = existingImports.get(source) ?? new Set<string>();
  const specifiers = Array.from(
    collectExportNamesFromModuleSource(source, importerFile),
  )
    .filter((name) => !importedNames.has(name))
    .map((name) => {
      importedNames.add(name);
      return name;
    });

  existingImports.set(source, importedNames);
  if (specifiers.length === 0) {
    return [];
  }

  return parseModuleItems(
    `import { ${specifiers.join(", ")} } from ${JSON.stringify(source)};`,
  );
}

function collectExportedNames(
  declaration: ExportDeclaration | ExportNamedDeclaration,
  target: Set<string>,
) {
  if (declaration.type === "ExportNamedDeclaration") {
    for (const specifier of declaration.specifiers) {
      if (specifier.type === "ExportSpecifier") {
        target.add(getModuleExportName(specifier.exported ?? specifier.orig));
      }
    }
    return;
  }

  if (declaration.declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declaration.declarations) {
      if (declarator.id.type === "Identifier") {
        target.add(declarator.id.value);
      }
    }
    return;
  }

  if (
    declaration.declaration.type === "FunctionDeclaration" ||
    declaration.declaration.type === "ClassDeclaration"
  ) {
    if (declaration.declaration.identifier) {
      target.add(declaration.declaration.identifier.value);
    }
  }
}

function collectExportedNamesFromReExport(
  declaration: ExportNamedDeclaration,
  target: Set<string>,
) {
  for (const specifier of declaration.specifiers) {
    if (specifier.type === "ExportSpecifier") {
      target.add(getModuleExportName(specifier.exported ?? specifier.orig));
    }
  }
}

function collectExportNamesFromExportAll(
  declaration: ExportAllDeclaration,
  importerFile: string,
  target: Set<string>,
) {
  for (const name of collectExportNamesFromModuleSource(
    declaration.source.value,
    importerFile,
  )) {
    target.add(name);
  }
}

function collectExportNamesFromModuleSource(
  source: string,
  importerFile: string,
): Set<string> {
  const modulePath = resolveModulePath(
    source,
    importerFile,
    path.dirname(importerFile),
  );
  if (!modulePath) {
    return new Set();
  }

  return collectExportNamesFromModule(modulePath, new Set());
}

function collectExportNamesFromModule(
  modulePath: string,
  seen: Set<string>,
): Set<string> {
  if (seen.has(modulePath)) {
    return new Set();
  }

  seen.add(modulePath);
  const module = parsedModuleCache.get(modulePath);
  if (!module) {
    throw new Error(`AST not found for module ${modulePath}`);
  }

  const exports = new Set<string>();
  for (const item of module.body) {
    if (item.type === "ExportNamedDeclaration" && item.source) {
      collectExportedNamesFromReExport(item, exports);
      continue;
    }

    if (item.type === "ExportAllDeclaration") {
      const nestedPath = resolveModulePath(
        item.source.value,
        modulePath,
        path.dirname(modulePath),
      );
      if (nestedPath) {
        for (const exportName of collectExportNamesFromModule(
          nestedPath,
          seen,
        )) {
          exports.add(exportName);
        }
      }
      continue;
    }

    if (
      item.type === "ExportNamedDeclaration" ||
      item.type === "ExportDeclaration"
    ) {
      collectExportedNames(
        item as ExportDeclaration | ExportNamedDeclaration,
        exports,
      );
    }
  }

  return exports;
}

function createGlobalDeclaration(identifiers: string[]): ModuleItem {
  return parseModuleItems(
    `declare namespace globalThis { var ${GCC}: { ${identifiers
      .map((identifier) => `${identifier}: typeof ${identifier}`)
      .join("; ")}; }; }`,
  )[0];
}

function createGccAssignments(identifiers: string[]): ModuleItem[] {
  return identifiers.flatMap((identifier) =>
    parseModuleItems(`globalThis.${GCC}.${identifier} = ${identifier};`),
  );
}

function getModuleExportName(name: ModuleExportName): string {
  return name.type === "Identifier" ? name.value : name.value;
}

function parseModuleItems(code: string): ModuleItem[] {
  return parseSync(code, {
    syntax: "typescript",
    target: "es2022",
  }).body;
}
