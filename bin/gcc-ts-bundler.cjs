#!/usr/bin/env node
const __gcc_current_module_url = require('node:url').pathToFileURL(__filename).href;
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/cache/hash.ts
function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, nestedValue]) => typeof nestedValue !== "function").sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]));
  }
  return value;
}
function hashContent(content) {
  return import_crypto.default.createHash("sha256").update(content).digest("hex");
}
function hashJson(value) {
  return hashContent(JSON.stringify(normalizeValue(value)));
}
var import_crypto;
var init_hash = __esm(() => {
  import_crypto = __toESM(require("crypto"));
});

// src/stages/native/compiler-options.ts
async function loadCompilerOptions(configPath, extraOptions = {}) {
  const configStat = await import_fs.default.promises.stat(configPath);
  const cacheKey = hashJson({
    configPath,
    extraOptions,
    mtimeMs: configStat.mtimeMs,
    size: configStat.size
  });
  const cached = compilerOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const configDir = import_path.default.dirname(configPath);
  const configFile = import_typescript.default.readConfigFile(configPath, import_typescript.default.sys.readFile);
  if (configFile.error) {
    throw new Error(import_typescript.default.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = import_typescript.default.parseJsonConfigFileContent(configFile.config, import_typescript.default.sys, configDir, {
    ...extraOptions,
    baseUrl: extraOptions.baseUrl ?? configFile.config.compilerOptions?.baseUrl ?? configDir,
    ignoreDeprecations: extraOptions.ignoreDeprecations ?? configFile.config.compilerOptions?.ignoreDeprecations ?? "6.0",
    paths: {
      ...configFile.config.compilerOptions?.paths ?? {},
      ...extraOptions.paths ?? {}
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(import_typescript.default.formatDiagnosticsWithColorAndContext(parsedConfig.errors, import_typescript.default.createCompilerHost({})));
  }
  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
}
var import_fs, import_path, import_typescript, compilerOptionsCache;
var init_compiler_options = __esm(() => {
  init_hash();
  import_fs = __toESM(require("fs"));
  import_path = __toESM(require("path"));
  import_typescript = __toESM(require("typescript"));
  compilerOptionsCache = new Map;
});

// src/api/externs/shared.ts
function createEmptyContractRegistry() {
  return {
    classContracts: new Map,
    interfaceContracts: new Map,
    scannedFiles: new Set,
    typeAliasContracts: new Map
  };
}
function collectStructuralContractMembers(symbol, registry, seen = new Set) {
  if (seen.has(symbol)) {
    return new Set;
  }
  seen.add(symbol);
  const interfaceContract = registry.interfaceContracts.get(symbol);
  if (interfaceContract) {
    const members = new Set(interfaceContract.members);
    for (const extendedSymbol of interfaceContract.extends) {
      for (const member of collectStructuralContractMembers(extendedSymbol, registry, seen)) {
        members.add(member);
      }
    }
    return members;
  }
  const typeAliasContract = registry.typeAliasContracts.get(symbol);
  if (typeAliasContract) {
    return new Set(typeAliasContract.members);
  }
  return new Set;
}
function resolveTypeSymbol(type, checker) {
  const symbol = type.getSymbol();
  if (!symbol && type.isUnionOrIntersection()) {
    for (const child of type.types) {
      const childSymbol = resolveTypeSymbol(child, checker);
      if (childSymbol) {
        return childSymbol;
      }
    }
    return null;
  }
  return resolveAliasedSymbol(symbol, checker);
}
function resolveValueSymbol(node, checker) {
  return resolveAliasedSymbol(checker.getSymbolAtLocation(node), checker);
}
function resolveAliasedSymbol(symbol, checker) {
  if (!symbol) {
    return null;
  }
  return symbol.flags & import_typescript2.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function resolveNominalInstanceTarget(symbol, registry) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}
function resolveNominalStaticTarget(symbol, registry) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}
function isAmbientGlobalSymbol(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !import_typescript2.default.isExternalModule(sourceFile);
  });
}
function renderStructuralExternLine(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `Object.prototype.${name};` : `Object.prototype[${JSON.stringify(name)}];`;
}
function renderNominalInstanceExternLine(target, name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${target}.prototype.${name};` : `${target}.prototype[${JSON.stringify(name)}];`;
}
function renderNominalStaticExternLine(target, name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${target}.${name};` : `${target}[${JSON.stringify(name)}];`;
}
function addMapSetValue(map, key, value) {
  const current = map.get(key);
  if (current) {
    current.add(value);
    return;
  }
  map.set(key, new Set([value]));
}
function isProjectAppSourceFile(filePath, projectRoot) {
  const resolvedFilePath = import_path2.default.resolve(filePath);
  return !resolvedFilePath.includes(`${import_path2.default.sep}node_modules${import_path2.default.sep}`) && !resolvedFilePath.endsWith(".d.ts") && resolvedFilePath.startsWith(import_path2.default.resolve(projectRoot) + import_path2.default.sep);
}
function isExportedDeclaration(node) {
  return (import_typescript2.default.getCombinedModifierFlags(node) & import_typescript2.default.ModifierFlags.Export) !== 0;
}
function hasStaticModifier(node) {
  return (import_typescript2.default.getCombinedModifierFlags(node) & import_typescript2.default.ModifierFlags.Static) !== 0;
}
function hasNonPublicModifier(node) {
  const modifierFlags = import_typescript2.default.getCombinedModifierFlags(node);
  return (modifierFlags & import_typescript2.default.ModifierFlags.Private) !== 0 || (modifierFlags & import_typescript2.default.ModifierFlags.Protected) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (import_typescript2.default.isIdentifier(name) || import_typescript2.default.isStringLiteral(name) || import_typescript2.default.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}
function getStringLiteralMemberName(expression) {
  if (!expression) {
    return null;
  }
  return import_typescript2.default.isStringLiteral(expression) || import_typescript2.default.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}
function isExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !name.startsWith("_") && !name.startsWith("$") && !BUILTIN_CONTAINER_NAMES.has(name);
}
function isRuntimeExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !BUILTIN_CONTAINER_NAMES.has(name) && !BUILTIN_RUNTIME_MEMBER_NAMES.has(name);
}
function isThisOrSuperExpression(expression) {
  return expression.kind === import_typescript2.default.SyntaxKind.ThisKeyword || expression.kind === import_typescript2.default.SyntaxKind.SuperKeyword;
}
function isKnownConstructorExpression(expression, knownConstructors) {
  return import_typescript2.default.isIdentifier(expression) && knownConstructors.has(expression.text);
}
function isKnownPrototypeExpression(expression, knownConstructors) {
  return import_typescript2.default.isPropertyAccessExpression(expression) && expression.name.text === "prototype" && isKnownConstructorExpression(expression.expression, knownConstructors);
}
function isObjectDefinePropertyCall(expression) {
  return import_typescript2.default.isPropertyAccessExpression(expression) && import_typescript2.default.isIdentifier(expression.expression) && expression.expression.text === "Object" && expression.name.text === "defineProperty";
}
function isAssignmentOperator(kind) {
  return kind === import_typescript2.default.SyntaxKind.EqualsToken || kind === import_typescript2.default.SyntaxKind.BarBarEqualsToken || kind === import_typescript2.default.SyntaxKind.AmpersandAmpersandEqualsToken || kind === import_typescript2.default.SyntaxKind.QuestionQuestionEqualsToken;
}
function getScriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return import_typescript2.default.ScriptKind.TSX;
  }
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
    return import_typescript2.default.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return import_typescript2.default.ScriptKind.JSX;
  }
  return import_typescript2.default.ScriptKind.JS;
}
function isScannedDeclarationSymbol(symbol, scannedFiles) {
  return (symbol.declarations ?? []).some((declaration) => scannedFiles.has(import_path2.default.resolve(declaration.getSourceFile().fileName)));
}
function findPackageDir(filePath) {
  let currentDir = import_path2.default.dirname(filePath);
  while (true) {
    const packageJsonPath = import_path2.default.join(currentDir, "package.json");
    if (import_typescript2.default.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = import_path2.default.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
function isTypeSourceFile(filePath) {
  return DECLARATION_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}
function isTypescriptLibFile(filePath) {
  return filePath.includes(`${import_path2.default.sep}node_modules${import_path2.default.sep}typescript${import_path2.default.sep}lib${import_path2.default.sep}`);
}
function symbolCacheKey(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration ? `${import_path2.default.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}` : symbol.getName();
}
function uniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function isRecoverableExternConfigError(error) {
  return error instanceof Error && (error.message.includes("TS18003") || error.message.includes("No inputs were found in config file"));
}
var import_path2, import_typescript2, DECLARATION_EXTENSIONS, BUILTIN_CONTAINER_NAMES, BUILTIN_RUNTIME_MEMBER_NAMES;
var init_shared = __esm(() => {
  import_path2 = __toESM(require("path"));
  import_typescript2 = __toESM(require("typescript"));
  DECLARATION_EXTENSIONS = [
    ".d.ts",
    ".d.mts",
    ".d.cts",
    ".ts",
    ".tsx",
    ".mts",
    ".cts"
  ];
  BUILTIN_CONTAINER_NAMES = new Set([
    "Array",
    "AsyncIterable",
    "AsyncIterator",
    "Iterable",
    "Iterator",
    "Map",
    "Promise",
    "ReadonlyArray",
    "ReadonlyMap",
    "ReadonlySet",
    "Set",
    "String",
    "WeakMap",
    "WeakSet"
  ]);
  BUILTIN_RUNTIME_MEMBER_NAMES = new Set([
    "addEventListener",
    "apply",
    "attachShadow",
    "attributes",
    "length",
    "message",
    "name",
    "removeAttribute",
    "removeEventListener",
    "setAttribute"
  ]);
});

// src/api/externs/compiler.ts
async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: import_typescript3.default.ModuleKind.ESNext,
    moduleResolution: import_typescript3.default.ModuleResolutionKind.Bundler,
    target: import_typescript3.default.ScriptTarget.ESNext
  };
  const resolvedConfigPath = tsConfigPath ?? import_path3.default.join(projectRoot, "tsconfig.json");
  try {
    await import_fs2.default.promises.access(resolvedConfigPath, import_fs2.default.constants.R_OK);
    try {
      return await loadCompilerOptions(resolvedConfigPath, {
        allowJs: true,
        rootDir: projectRoot
      });
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return fallbackOptions;
}
async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  specifiers,
  tolerateMissing
}) {
  const resolvedEntries = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(await resolveModuleTypeEntry({
        compilerOptions,
        projectRoot,
        specifier
      }));
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueStrings(resolvedEntries);
}
function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir
}) {
  return entryFiles.map((entry) => {
    if (import_path3.default.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = import_path3.default.resolve(srcDir, entry);
    if (import_typescript3.default.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return import_path3.default.resolve(projectRoot, entry);
  });
}
async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies
}) {
  const rootPackageDirs = new Set(entryFiles.map((filePath) => findPackageDir(filePath)).filter((packageDir) => packageDir !== null));
  const queue = [...entryFiles];
  const seen = new Set;
  while (queue.length > 0) {
    const nextFile = queue.shift();
    if (!nextFile) {
      continue;
    }
    const resolvedFile = import_path3.default.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);
    const sourceText = await import_fs2.default.promises.readFile(resolvedFile, "utf8");
    const sourceFile = import_typescript3.default.createSourceFile(resolvedFile, sourceText, import_typescript3.default.ScriptTarget.Latest, true);
    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = import_typescript3.default.resolveModuleName(specifier, resolvedFile, compilerOptions, import_typescript3.default.sys).resolvedModule;
      if (!resolvedModule) {
        continue;
      }
      const normalizedDependency = normalizeResolvedTypeFile(resolvedModule.resolvedFileName);
      if (!normalizedDependency || isTypescriptLibFile(normalizedDependency)) {
        continue;
      }
      if (!includeDependencies) {
        const dependencyPackageDir = findPackageDir(normalizedDependency);
        if (dependencyPackageDir && !rootPackageDirs.has(dependencyPackageDir)) {
          continue;
        }
      }
      queue.push(normalizedDependency);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}
async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  specifier
}) {
  const containingFile = import_path3.default.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = import_typescript3.default.resolveModuleName(specifier, containingFile, compilerOptions, import_typescript3.default.sys).resolvedModule;
  const resolvedFromTypescript = resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }
  const require2 = import_typescript3.default.createModuleResolutionCache(projectRoot, (fileName) => fileName, compilerOptions);
  const fallbackResolution = import_typescript3.default.nodeModuleNameResolver(specifier, containingFile, compilerOptions, import_typescript3.default.sys, require2).resolvedModule;
  const resolvedFromFallback = fallbackResolution && normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }
  throw new Error(`Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`);
}
function normalizeResolvedTypeFile(resolvedFileName) {
  const normalizedPath = import_path3.default.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }
  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (import_typescript3.default.sys.fileExists(candidate)) {
      return import_path3.default.resolve(candidate);
    }
  }
  return null;
}
function withTypeExtension(filePath, nextExtension) {
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return filePath;
  }
  const extension = import_path3.default.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`;
}
function collectReferencedSpecifiers(sourceFile) {
  const specifiers = new Set;
  const add = (value) => {
    if (value) {
      specifiers.add(value);
    }
  };
  const visit = (node) => {
    if (import_typescript3.default.isImportDeclaration(node) || import_typescript3.default.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && import_typescript3.default.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (import_typescript3.default.isImportEqualsDeclaration(node) && import_typescript3.default.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && import_typescript3.default.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text);
    } else if (import_typescript3.default.isImportTypeNode(node) && import_typescript3.default.isLiteralTypeNode(node.argument) && import_typescript3.default.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text);
    }
    import_typescript3.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
var import_fs2, import_path3, import_typescript3;
var init_compiler = __esm(() => {
  init_compiler_options();
  init_shared();
  import_fs2 = __toESM(require("fs"));
  import_path3 = __toESM(require("path"));
  import_typescript3 = __toESM(require("typescript"));
});

// src/api/externs/contracts.ts
function collectContracts(program, scannedFiles) {
  const checker = program.getTypeChecker();
  const scannedFileSet = new Set(scannedFiles.map((filePath) => import_path4.default.resolve(filePath)));
  const interfaceContracts = new Map;
  const typeAliasContracts = new Map;
  const classContracts = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(import_path4.default.resolve(sourceFile.fileName))) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (import_typescript4.default.isInterfaceDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        interfaceContracts.set(symbol, {
          extends: getReferencedContractSymbols(statement.heritageClauses?.flatMap((clause) => clause.types) ?? [], checker, scannedFileSet),
          members: collectTypeElementMembers(statement.members),
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (import_typescript4.default.isTypeAliasDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const members = collectAliasMembers(statement.type);
        if (members.size === 0) {
          continue;
        }
        typeAliasContracts.set(symbol, {
          members,
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (import_typescript4.default.isClassDeclaration(statement) && statement.name && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set;
        const staticMembers = new Set;
        for (const member of statement.members) {
          if (import_typescript4.default.isConstructorDeclaration(member)) {
            continue;
          }
          if (hasNonPublicModifier(member)) {
            continue;
          }
          const memberName = getPropertyNameText(member.name);
          if (!memberName || !isExternPropertyName(memberName)) {
            continue;
          }
          if (hasStaticModifier(member)) {
            staticMembers.add(memberName);
          } else {
            instanceMembers.add(memberName);
          }
        }
        classContracts.set(symbol, {
          constructorParamContracts: collectConstructorParamContracts(statement, checker, scannedFileSet),
          instanceMembers,
          name: statement.name.text,
          staticMembers,
          symbol,
          usedImplementedContracts: getClassImplementedContracts(statement, checker, scannedFileSet)
        });
      }
    }
  }
  return {
    classContracts,
    interfaceContracts,
    scannedFiles: scannedFileSet,
    typeAliasContracts
  };
}
function collectCandidateExternLines(registry) {
  const properties = new Set;
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(contract.symbol, registry)) {
      properties.add(member);
    }
  }
  for (const contract of registry.typeAliasContracts.values()) {
    for (const member of contract.members) {
      properties.add(member);
    }
  }
  for (const contract of registry.classContracts.values()) {
    for (const member of contract.instanceMembers) {
      properties.add(member);
    }
  }
  return new Set([...properties].sort((left, right) => left.localeCompare(right)).map((property) => renderStructuralExternLine(property)));
}
function collectBoundaryAwareExternLines({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry
}) {
  const usage = analyzeAppUsage({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry
  });
  const emittedLines = new Set;
  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, registry)) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  for (const [symbol, members] of usage.nominalInstanceMembers) {
    const nominalTarget = resolveNominalInstanceTarget(symbol, registry);
    for (const member of members) {
      emittedLines.add(nominalTarget ? renderNominalInstanceExternLine(nominalTarget, member) : renderStructuralExternLine(member));
    }
  }
  for (const [symbol, members] of usage.nominalStaticMembers) {
    const nominalTarget = resolveNominalStaticTarget(symbol, registry);
    for (const member of members) {
      emittedLines.add(nominalTarget ? renderNominalStaticExternLine(nominalTarget, member) : renderStructuralExternLine(member));
    }
  }
  return emittedLines;
}
function analyzeAppUsage({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry
}) {
  const program = import_typescript4.default.createProgram(appEntryFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true
  });
  const checker = program.getTypeChecker();
  const usage = {
    nominalInstanceMembers: new Map,
    nominalStaticMembers: new Map,
    structuralContracts: new Set,
    structuralMembers: new Set
  };
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => isProjectAppSourceFile(sourceFile.fileName, projectRoot));
  for (const sourceFile of sourceFiles) {
    const importBindings = collectImportedClassBindings(sourceFile, registry);
    const localBindings = new Map;
    const visit = (node) => {
      if (import_typescript4.default.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child) => {
          if (import_typescript4.default.isNewExpression(child)) {
            analyzeNewExpression(child, checker, registry, usage, importBindings, localBindings);
          } else if (import_typescript4.default.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (import_typescript4.default.isElementAccessExpression(child) && import_typescript4.default.isStringLiteral(child.argumentExpression)) {
            analyzeElementAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (import_typescript4.default.isVariableDeclaration(child)) {
            registerVariableBinding(child, importBindings, localBindings);
          }
          import_typescript4.default.forEachChild(child, classVisit);
        };
        import_typescript4.default.forEachChild(node, classVisit);
        return;
      }
      if (import_typescript4.default.isVariableDeclaration(node)) {
        registerVariableBinding(node, importBindings, localBindings);
      } else if (import_typescript4.default.isNewExpression(node)) {
        analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings);
      } else if (import_typescript4.default.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      } else if (import_typescript4.default.isElementAccessExpression(node) && import_typescript4.default.isStringLiteral(node.argumentExpression)) {
        analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      }
      import_typescript4.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return usage;
}
function analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings) {
  const calleeSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, new Map) ?? resolveValueSymbol(node.expression, checker) ?? resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!calleeSymbol) {
    return;
  }
  const classContract = registry.classContracts.get(calleeSymbol);
  if (!classContract) {
    return;
  }
  for (const symbol of classContract.usedImplementedContracts) {
    usage.structuralContracts.add(symbol);
  }
  for (const [
    index,
    contractSymbols
  ] of classContract.constructorParamContracts.entries()) {
    const argument = node.arguments?.[index];
    if (!argument || !isStructuralBoundaryArgument(argument)) {
      continue;
    }
    for (const symbol of contractSymbols) {
      usage.structuralContracts.add(symbol);
    }
  }
}
function analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const propertyName = node.name.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  if (import_typescript4.default.isIdentifier(node.expression) && importBindings.has(node.expression.text)) {
    const targetSymbol = importBindings.get(node.expression.text);
    if (targetSymbol) {
      const classContract = registry.classContracts.get(targetSymbol);
      if (classContract && classContract.staticMembers.has(propertyName)) {
        addMapSetValue(usage.nominalStaticMembers, targetSymbol, propertyName);
        return;
      }
    }
  }
  const boundInstanceSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundInstanceSymbol && registry.classContracts.has(boundInstanceSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundInstanceSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const argumentExpression = node.argumentExpression;
  if (!import_typescript4.default.isStringLiteral(argumentExpression)) {
    return;
  }
  const propertyName = argumentExpression.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  const boundSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundSymbol && registry.classContracts.has(boundSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function collectImportedClassBindings(sourceFile, registry) {
  const bindings = new Map;
  for (const statement of sourceFile.statements) {
    if (!import_typescript4.default.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      const symbol = findClassContractByName(clause.name.text, registry);
      if (symbol) {
        bindings.set(clause.name.text, symbol);
      }
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings || !import_typescript4.default.isNamedImports(namedBindings)) {
      continue;
    }
    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const symbol = findClassContractByName(importedName, registry);
      if (symbol) {
        bindings.set(specifier.name.text, symbol);
      }
    }
  }
  return bindings;
}
function collectClassFieldBindings(declaration, importBindings) {
  const bindings = new Map;
  for (const member of declaration.members) {
    if (!import_typescript4.default.isPropertyDeclaration(member) || !member.initializer || !import_typescript4.default.isIdentifier(member.name) || !import_typescript4.default.isNewExpression(member.initializer) || !import_typescript4.default.isIdentifier(member.initializer.expression)) {
      continue;
    }
    const classSymbol = importBindings.get(member.initializer.expression.text);
    if (classSymbol) {
      bindings.set(member.name.text, classSymbol);
    }
  }
  return bindings;
}
function registerVariableBinding(declaration, importBindings, localBindings) {
  if (!import_typescript4.default.isIdentifier(declaration.name) || !declaration.initializer || !import_typescript4.default.isNewExpression(declaration.initializer) || !import_typescript4.default.isIdentifier(declaration.initializer.expression)) {
    return;
  }
  const classSymbol = importBindings.get(declaration.initializer.expression.text);
  if (classSymbol) {
    localBindings.set(declaration.name.text, classSymbol);
  }
}
function resolveBoundClassSymbol(expression, importBindings, localBindings, fieldBindings) {
  if (import_typescript4.default.isIdentifier(expression)) {
    return localBindings.get(expression.text) ?? importBindings.get(expression.text) ?? null;
  }
  if (import_typescript4.default.isPropertyAccessExpression(expression) && expression.expression.kind === import_typescript4.default.SyntaxKind.ThisKeyword) {
    return fieldBindings.get(expression.name.text) ?? null;
  }
  return null;
}
function findClassContractByName(name, registry) {
  for (const [symbol, contract] of registry.classContracts) {
    if (contract.name === name) {
      return symbol;
    }
  }
  return null;
}
function collectTypeElementMembers(members) {
  const collected = new Set;
  for (const member of members) {
    if (import_typescript4.default.isPropertySignature(member) || import_typescript4.default.isMethodSignature(member) || import_typescript4.default.isGetAccessorDeclaration(member) || import_typescript4.default.isSetAccessorDeclaration(member)) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}
function collectAliasMembers(typeNode) {
  if (import_typescript4.default.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }
  if (import_typescript4.default.isIntersectionTypeNode(typeNode)) {
    const members = new Set;
    for (const child of typeNode.types) {
      for (const member of collectAliasMembers(child)) {
        members.add(member);
      }
    }
    return members;
  }
  return new Set;
}
function getReferencedContractSymbols(typeNodes, checker, scannedFiles) {
  const symbols = new Set;
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
      symbols.add(symbol);
    }
  }
  return symbols;
}
function getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles) {
  if (import_typescript4.default.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles) ? new Set([symbol]) : new Set;
  }
  if (import_typescript4.default.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }
  if (import_typescript4.default.isIntersectionTypeNode(typeNode) || import_typescript4.default.isUnionTypeNode(typeNode)) {
    const symbols = new Set;
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(child, checker, scannedFiles)) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }
  if (import_typescript4.default.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(typeNode.typeName, checker, scannedFiles);
  }
  return new Set;
}
function getContractSymbolsFromEntityName(entityName, checker, scannedFiles) {
  const symbol = import_typescript4.default.isIdentifier(entityName) ? checker.getSymbolAtLocation(entityName) : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set;
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles) ? new Set([resolved]) : new Set;
}
function collectConstructorParamContracts(statement, checker, scannedFiles) {
  const constructorDeclaration = statement.members.find((member) => import_typescript4.default.isConstructorDeclaration(member));
  if (!constructorDeclaration || !import_typescript4.default.isConstructorDeclaration(constructorDeclaration)) {
    return [];
  }
  return constructorDeclaration.parameters.map((parameter) => parameter.type ? getContractSymbolsFromTypeNode(parameter.type, checker, scannedFiles) : new Set);
}
function getClassImplementedContracts(statement, checker, scannedFiles, seen = new Set) {
  const contracts = new Set;
  const classSymbol = statement.name && checker.getSymbolAtLocation(statement.name);
  const classKey = classSymbol ? symbolCacheKey(classSymbol) : "";
  if (classKey && seen.has(classKey)) {
    return contracts;
  }
  if (classKey) {
    seen.add(classKey);
  }
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token === import_typescript4.default.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
          contracts.add(symbol);
        }
      }
      continue;
    }
    if (clause.token === import_typescript4.default.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) => import_typescript4.default.isClassDeclaration(item));
        if (declaration && import_typescript4.default.isClassDeclaration(declaration)) {
          for (const symbol of getClassImplementedContracts(declaration, checker, scannedFiles, seen)) {
            contracts.add(symbol);
          }
        }
      }
    }
  }
  return contracts;
}
function isStructuralBoundaryArgument(expression) {
  return !(import_typescript4.default.isArrayLiteralExpression(expression) || import_typescript4.default.isObjectLiteralExpression(expression) || import_typescript4.default.isStringLiteralLike(expression) || import_typescript4.default.isNumericLiteral(expression) || expression.kind === import_typescript4.default.SyntaxKind.TrueKeyword || expression.kind === import_typescript4.default.SyntaxKind.FalseKeyword || expression.kind === import_typescript4.default.SyntaxKind.NullKeyword);
}
var import_path4, import_typescript4;
var init_contracts = __esm(() => {
  init_shared();
  import_path4 = __toESM(require("path"));
  import_typescript4 = __toESM(require("typescript"));
});

// src/api/externs/runtime-analysis.ts
async function analyzeRuntimeUsage(runtimeEntryFiles) {
  const structuralMembers = new Set;
  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await import_fs3.default.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = import_typescript5.default.createSourceFile(runtimeEntryFile, sourceText, import_typescript5.default.ScriptTarget.Latest, true, getScriptKindForFile(runtimeEntryFile));
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node) => {
      if (import_typescript5.default.isClassDeclaration(node) || import_typescript5.default.isClassExpression(node)) {
        for (const member of node.members) {
          if (import_typescript5.default.isPropertyDeclaration(member) || import_typescript5.default.isGetAccessorDeclaration(member) || import_typescript5.default.isSetAccessorDeclaration(member)) {
            const memberName = getPropertyNameText(member.name);
            if (memberName && isRuntimeExternPropertyName(memberName)) {
              structuralMembers.add(memberName);
            }
          }
        }
      } else if (import_typescript5.default.isPropertyAccessExpression(node)) {
        if (isThisOrSuperExpression(node.expression) && isRuntimeExternPropertyName(node.name.text)) {
          structuralMembers.add(node.name.text);
        }
      } else if (import_typescript5.default.isElementAccessExpression(node)) {
        const memberName = getStringLiteralMemberName(node.argumentExpression);
        if (memberName && isThisOrSuperExpression(node.expression) && isRuntimeExternPropertyName(memberName)) {
          structuralMembers.add(memberName);
        }
      } else if (import_typescript5.default.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, structuralMembers);
      } else if (import_typescript5.default.isCallExpression(node)) {
        collectRuntimeCallMembers(node, knownConstructors, structuralMembers);
      }
      import_typescript5.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return structuralMembers;
}
function collectKnownConstructorBindings(sourceFile) {
  const knownConstructors = new Set;
  const visit = (node) => {
    if ((import_typescript5.default.isClassDeclaration(node) || import_typescript5.default.isFunctionDeclaration(node)) && node.name) {
      knownConstructors.add(node.name.text);
    } else if (import_typescript5.default.isVariableDeclaration(node) && import_typescript5.default.isIdentifier(node.name) && node.initializer && (import_typescript5.default.isClassExpression(node.initializer) || import_typescript5.default.isFunctionExpression(node.initializer) || import_typescript5.default.isArrowFunction(node.initializer))) {
      knownConstructors.add(node.name.text);
    }
    import_typescript5.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}
function collectRuntimeAssignmentMembers(target, knownConstructors, structuralMembers) {
  if (import_typescript5.default.isPropertyAccessExpression(target)) {
    if (isThisOrSuperExpression(target.expression) || isKnownPrototypeExpression(target.expression, knownConstructors) || isKnownConstructorExpression(target.expression, knownConstructors)) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        structuralMembers.add(target.name.text);
      }
    }
    return;
  }
  if (import_typescript5.default.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (memberName && (isThisOrSuperExpression(target.expression) || isKnownPrototypeExpression(target.expression, knownConstructors) || isKnownConstructorExpression(target.expression, knownConstructors)) && isRuntimeExternPropertyName(memberName)) {
      structuralMembers.add(memberName);
    }
  }
}
function collectRuntimeCallMembers(node, knownConstructors, structuralMembers) {
  const callee = node.expression;
  if (import_typescript5.default.isIdentifier(callee) && callee.text === "__publicField" && node.arguments.length >= 2) {
    const memberName2 = getStringLiteralMemberName(node.arguments[1]);
    if (memberName2 && (isThisOrSuperExpression(node.arguments[0]) || isKnownConstructorExpression(node.arguments[0], knownConstructors)) && isRuntimeExternPropertyName(memberName2)) {
      structuralMembers.add(memberName2);
    }
    return;
  }
  if (!isObjectDefinePropertyCall(callee) || node.arguments.length < 2) {
    return;
  }
  const memberName = getStringLiteralMemberName(node.arguments[1]);
  if (!memberName || !isRuntimeExternPropertyName(memberName)) {
    return;
  }
  const target = node.arguments[0];
  if (isThisOrSuperExpression(target) || isKnownConstructorExpression(target, knownConstructors) || isKnownPrototypeExpression(target, knownConstructors)) {
    structuralMembers.add(memberName);
  }
}
var import_fs3, import_typescript5;
var init_runtime_analysis = __esm(() => {
  init_shared();
  import_fs3 = __toESM(require("fs"));
  import_typescript5 = __toESM(require("typescript"));
});

// src/api/externs/render.ts
function renderCandidateExterns({
  modules,
  registry,
  scannedFiles
}) {
  return renderExternText({
    emittedLines: collectCandidateExternLines(registry),
    mode: "candidates",
    modules,
    scannedFiles
  });
}
function renderBoundaryAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  scannedFiles
}) {
  return renderExternText({
    emittedLines: collectBoundaryAwareExternLines({
      appEntryFiles,
      compilerOptions,
      projectRoot,
      registry
    }),
    mode: "boundary-aware",
    modules,
    scannedFiles
  });
}
async function renderRuntimeAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  runtimeEntryFiles,
  scannedFiles
}) {
  const emittedLines = appEntryFiles.length > 0 ? collectBoundaryAwareExternLines({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry
  }) : collectCandidateExternLines(registry);
  const runtimeMembers = await analyzeRuntimeUsage(runtimeEntryFiles);
  for (const member of runtimeMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles
  });
}
function renderExternText({
  emittedLines,
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles
}) {
  const scannedSummary = mode === "runtime-aware" ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.` : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;
  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    ""
  ].join(`
`);
}
var init_render = __esm(() => {
  init_runtime_analysis();
  init_contracts();
  init_shared();
});

// src/api/externs.ts
async function generateExterns(options) {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }
  const mode = options.mode ?? "boundary-aware";
  const projectRoot = import_path5.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path5.default.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath = options.tsConfigPath && import_path5.default.resolve(projectRoot, options.tsConfigPath);
  const compilerOptions = await loadExternCompilerOptions({
    projectRoot,
    tsConfigPath
  });
  const includeDependencies = options.includeDependencies ?? true;
  if (mode === "boundary-aware" && (options.appEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in boundary-aware mode requires appEntryFiles.");
  }
  if (mode === "runtime-aware" && (options.runtimeEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in runtime-aware mode requires runtimeEntryFiles.");
  }
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot,
    specifiers: options.modules,
    tolerateMissing: mode === "runtime-aware"
  });
  const scannedFiles = typeEntryFiles.length === 0 ? [] : await collectReachableTypeFiles({
    compilerOptions,
    entryFiles: typeEntryFiles,
    includeDependencies
  });
  const registry = scannedFiles.length === 0 ? createEmptyContractRegistry() : collectContracts(import_typescript6.default.createProgram(scannedFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true
  }), scannedFiles);
  const text = mode === "candidates" ? renderCandidateExterns({
    modules: options.modules,
    registry,
    scannedFiles
  }) : mode === "boundary-aware" ? renderBoundaryAwareExterns({
    appEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.appEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    compilerOptions,
    modules: options.modules,
    projectRoot,
    registry,
    scannedFiles
  }) : await renderRuntimeAwareExterns({
    appEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.appEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    compilerOptions,
    modules: options.modules,
    projectRoot,
    registry,
    runtimeEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.runtimeEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    scannedFiles
  });
  const outputFile = options.outputFile && import_path5.default.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await import_fs4.default.promises.mkdir(import_path5.default.dirname(outputFile), { recursive: true });
    await import_fs4.default.promises.writeFile(outputFile, text, "utf8");
  }
  return {
    mode,
    modules: [...options.modules],
    outputFile,
    scannedFiles,
    text
  };
}
var import_fs4, import_path5, import_typescript6;
var init_externs = __esm(() => {
  init_compiler();
  init_contracts();
  init_render();
  import_fs4 = __toESM(require("fs"));
  import_path5 = __toESM(require("path"));
  import_typescript6 = __toESM(require("typescript"));
});

// src/api/types.ts
var DEFAULT_BUILD_OPTIONS;
var init_types = __esm(() => {
  DEFAULT_BUILD_OPTIONS = Object.freeze({
    cache: {
      dir: "",
      mode: "persistent"
    },
    compilationLevel: "ADVANCED",
    chunks: {
      baseChunkName: "main",
      loader: "auto",
      manifestFile: "",
      mode: "off",
      publicPath: "./"
    },
    diagnostics: {
      fatalWarnings: false,
      preflight: "errors-only",
      verbose: false
    },
    entries: [],
    externs: [],
    js: [],
    languageOut: "ECMASCRIPT_NEXT",
    outDir: "",
    outputNames: [],
    packages: {
      mode: "esm-only"
    },
    projectRoot: "",
    srcDir: ""
  });
});

// src/cache/store.ts
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return import_path6.default.join(import_os.default.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return import_path6.default.join(process.env.LOCALAPPDATA ?? import_path6.default.join(import_os.default.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return import_path6.default.join(process.env.XDG_CACHE_HOME ?? import_path6.default.join(import_os.default.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await import_fs5.default.promises.mkdtemp(import_path6.default.join(import_os.default.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = import_path6.default.join(rootDir2, "workspace");
    await import_fs5.default.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await import_fs5.default.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = import_path6.default.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path6.default.join(rootDir, hashContent(projectRoot));
  const workspaceDir = import_path6.default.join(projectCacheDir, "workspace");
  await import_fs5.default.promises.mkdir(workspaceDir, { recursive: true });
  return {
    async cleanup() {},
    mode,
    projectCacheDir,
    rootDir,
    workspaceDir
  };
}
async function readJsonIfExists(filePath) {
  try {
    const raw = await import_fs5.default.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function writeJson(filePath, value) {
  await ensureDirectoryExistence(filePath);
  await import_fs5.default.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
async function ensureDirectoryExistence(filePath) {
  await import_fs5.default.promises.mkdir(import_path6.default.dirname(filePath), { recursive: true });
}
var import_fs5, import_os, import_path6;
var init_store = __esm(() => {
  init_hash();
  import_fs5 = __toESM(require("fs"));
  import_os = __toESM(require("os"));
  import_path6 = __toESM(require("path"));
});

// src/internal/bundle-location.ts
function getBundleFilePath() {
  return import_url.fileURLToPath(__gcc_current_module_url);
}
function createBundleRequire() {
  bundleRequire ??= import_module.createRequire(__gcc_current_module_url);
  return bundleRequire;
}
function getPackageRootFromBundle() {
  if (packageRoot) {
    return packageRoot;
  }
  let currentDir = import_path7.default.dirname(getBundleFilePath());
  while (true) {
    if (import_fs6.default.existsSync(import_path7.default.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }
    const parentDir = import_path7.default.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package.json from bundled module path ${getBundleFilePath()}`);
    }
    currentDir = parentDir;
  }
}
var import_fs6, import_path7, import_module, import_url, bundleRequire = null, packageRoot = null;
var init_bundle_location = __esm(() => {
  import_fs6 = __toESM(require("fs"));
  import_path7 = __toESM(require("path"));
  import_module = require("module");
  import_url = require("url");
});

// src/native/index.ts
function detectLinuxLibc() {
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return "gnu";
  }
  try {
    const { execFileSync } = require2("node:child_process");
    const output = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.includes("musl") ? "musl" : "gnu";
  } catch {}
  return "musl";
}
function getTargetKey() {
  if (process.platform === "linux") {
    return `${process.platform}-${process.arch}-${detectLinuxLibc()}`;
  }
  if (process.platform === "win32") {
    return `${process.platform}-${process.arch}-msvc`;
  }
  return `${process.platform}-${process.arch}`;
}
function loadNativeBinding() {
  const targetKey = getTargetKey();
  const packageName = SUPPORTED_TARGETS[targetKey];
  const localFallbackPath = import_path8.default.join(getPackageRootFromBundle(), "native", "index.node");
  if (import_fs7.default.existsSync(localFallbackPath)) {
    return require2(localFallbackPath);
  }
  const loadErrors = [];
  if (packageName) {
    try {
      return require2(packageName);
    } catch (error) {
      loadErrors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const supportedTargets = Object.keys(SUPPORTED_TARGETS).join(", ");
  const details = loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(`No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`);
}
var import_fs7, import_path8, require2, SUPPORTED_TARGETS, native_default;
var init_native = __esm(() => {
  init_bundle_location();
  import_fs7 = __toESM(require("fs"));
  import_path8 = __toESM(require("path"));
  require2 = createBundleRequire();
  SUPPORTED_TARGETS = {
    "darwin-arm64": "gcc-ts-bundler-darwin-arm64",
    "darwin-x64": "gcc-ts-bundler-darwin-x64",
    "linux-arm64-gnu": "gcc-ts-bundler-linux-arm64-gnu",
    "linux-arm64-musl": "gcc-ts-bundler-linux-arm64-musl",
    "linux-x64-gnu": "gcc-ts-bundler-linux-x64-gnu",
    "linux-x64-musl": "gcc-ts-bundler-linux-x64-musl",
    "win32-arm64-msvc": "gcc-ts-bundler-win32-arm64-msvc",
    "win32-x64-msvc": "gcc-ts-bundler-win32-x64-msvc"
  };
  native_default = loadNativeBinding();
});

// src/native/load.ts
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  cachedBinding = native_default;
  return cachedBinding;
}
function resolveGraph(input) {
  const result = loadBinding().resolveGraph(input.entries, input.srcDir, input.workspaceDir, input.packageMode);
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(result.fileHashes.map((entry) => [entry.filePath, entry.hash])),
    graph: Object.fromEntries(result.graph.map((entry) => [entry.filePath, entry.dependencies])),
    lazyImports: result.lazyImports,
    packageAliases: result.packageAliases,
    packageJsonFiles: result.packageJsonFiles,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles
  };
}
function planChunks(input) {
  return loadBinding().planChunks(input.chunkMode, input.baseChunkName, input.workspaceDir, input.entryFiles, input.graphEntries, input.lazyImports, input.shimFiles);
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.metadataPath, input.chunkMode, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? [], input.lazyImports ?? []);
}
function prepareClosureJobs(input) {
  return loadBinding().prepareClosureJobs(input);
}
function writeEntryShims(input) {
  return loadBinding().writeEntryShims(input.entries);
}
function collectFileStates(filePaths) {
  return loadBinding().collectFileStates(filePaths);
}
function collectPublishedOutputStats(filePaths) {
  return loadBinding().collectPublishedOutputStats(filePaths);
}
function matchFileStates(expected) {
  return loadBinding().matchFileStates(expected);
}
function publishedOutputSnapshotMatches(publishedOutputs, outDir) {
  return loadBinding().publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
function publishedOutputsMatch(outputFiles, outDir) {
  return loadBinding().publishedOutputsMatch(outputFiles, outDir);
}
var cachedBinding = null;
var init_load = __esm(() => {
  init_native();
});

// src/internal/file-state.ts
function uniqueSorted(filePaths) {
  return [...new Set(filePaths)].sort((left, right) => left.localeCompare(right));
}
async function collectTrackedFiles(filePaths) {
  const states = collectFileStates(uniqueSorted(filePaths));
  return Object.fromEntries(states.filter((state) => state.exists).map((state) => [
    state.filePath,
    {
      mtimeMs: state.mtimeMs,
      size: state.size
    }
  ]));
}
async function trackedFilesMatch(trackedFiles) {
  return matchFileStates(Object.entries(trackedFiles).map(([filePath, state]) => ({
    exists: true,
    filePath,
    mtimeMs: state.mtimeMs,
    size: state.size
  })));
}
async function filesExist(filePaths) {
  return collectFileStates(uniqueSorted(filePaths)).every((state) => state.exists);
}
async function publishedOutputsMatch2(outputFiles, outDir) {
  return publishedOutputsMatch(uniqueSorted(outputFiles), outDir);
}
async function publishedOutputsMatchSnapshot(publishedOutputs, outDir) {
  return publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
async function collectPublishedOutputStats2(outputFiles) {
  return collectPublishedOutputStats(uniqueSorted(outputFiles));
}
async function copyOrLinkFiles(sourceFiles, outDir) {
  await import_fs8.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs8.default.promises.mkdir(outDir, { recursive: true });
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = import_path9.default.join(outDir, import_path9.default.basename(sourceFile));
    try {
      await import_fs8.default.promises.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await import_fs8.default.promises.copyFile(sourceFile, destinationFile);
    }
  }));
}
var import_fs8, import_path9;
var init_file_state = __esm(() => {
  init_load();
  import_fs8 = __toESM(require("fs"));
  import_path9 = __toESM(require("path"));
});

// src/pipeline/resolve-build/entries.ts
function resolveOutputNames(entryPaths, outputNames) {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }
    return outputNames;
  }
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => import_path10.default.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return entryPaths.map((entryPath, index) => {
    const basename = basenames[index];
    if ((basenameCounts.get(basename) ?? 0) === 1) {
      return basename;
    }
    return `${entryPath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
  });
}
function sanitizeChunkName(outputName) {
  return outputName.replace(/\.js$/, "").replace(/[^\w-]/g, "-");
}
function toBuildEntry(entry, sourceRoot) {
  return {
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: import_path10.default.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  };
}
function toShimFiles(entryFiles, shimDir) {
  return entryFiles.map((entry) => import_path10.default.join(shimDir, `${entry.chunkName}.ts`));
}
var import_path10;
var init_entries = __esm(() => {
  import_path10 = __toESM(require("path"));
});

// src/pipeline/resolve-build/signatures.ts
async function hashTsConfig(configPath) {
  return hashContent(await import_fs9.default.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await import_fs9.default.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
function getPackageRoot() {
  return getPackageRootFromBundle();
}
async function getPackageSignature(packageRoot2 = getPackageRoot()) {
  let packageSignaturePromise = packageSignaturePromises.get(packageRoot2);
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await import_fs9.default.promises.stat(import_path11.default.join(packageRoot2, "package.json"));
      const runtimeSignature = await readRuntimeSignature(packageRoot2);
      const nativeSignature = await readNativeSignature(packageRoot2);
      return hashContent(JSON.stringify({
        nativeSignature,
        packageJson: {
          mtimeMs: packageJsonStat.mtimeMs,
          size: packageJsonStat.size
        },
        runtimeSignature
      }));
    })();
    packageSignaturePromises.set(packageRoot2, packageSignaturePromise);
  }
  return packageSignaturePromise;
}
function getOptionsSignature(options) {
  return hashJson({
    compilationLevel: options.compilationLevel,
    chunks: options.chunks,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => import_path11.default.relative(options.srcDir, entry)),
    externs: [...options.externs].sort(),
    js: [...options.js].sort(),
    languageOut: options.languageOut,
    outDir: options.outDir,
    outputNames: [...options.outputNames],
    packages: options.packages,
    projectRoot: options.projectRoot,
    srcDir: options.srcDir
  });
}
async function readRuntimeSignature(packageRoot2) {
  try {
    const stat = await import_fs9.default.promises.stat(import_path11.default.join(packageRoot2, "dist", "index.mjs"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot2) {
  try {
    const stat = await import_fs9.default.promises.stat(import_path11.default.join(packageRoot2, "native", "index.node"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
var import_fs9, import_path11, packageSignaturePromises;
var init_signatures = __esm(() => {
  init_hash();
  init_bundle_location();
  import_fs9 = __toESM(require("fs"));
  import_path11 = __toESM(require("path"));
  packageSignaturePromises = new Map;
});

// src/pipeline/resolve-build/workspace.ts
async function ensureDirectorySymlink(linkPath, targetPath) {
  try {
    const currentTarget = await import_fs10.default.promises.readlink(linkPath);
    if (import_path12.default.resolve(import_path12.default.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await import_fs10.default.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await import_fs10.default.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await import_fs10.default.promises.mkdir(import_path12.default.dirname(linkPath), { recursive: true });
  await import_fs10.default.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = import_path12.default.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = import_path12.default.join(options.projectRoot, "node_modules");
  const hasNodeModules = await import_fs10.default.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = import_typescript7.default.findConfigFile(projectRoot, import_typescript7.default.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function removePathIfExists(targetPath) {
  try {
    await import_fs10.default.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
var import_fs10, import_path12, import_typescript7;
var init_workspace = __esm(() => {
  import_fs10 = __toESM(require("fs"));
  import_path12 = __toESM(require("path"));
  import_typescript7 = __toESM(require("typescript"));
});

// src/pipeline/resolve-build/options.ts
function normalizeBuildOptions(options) {
  const projectRoot = import_path13.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path13.default.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = import_path13.default.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  const chunkPublicPath = normalizeChunkPublicPath(options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath);
  const chunkManifestFile = import_path13.default.basename(options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile);
  return {
    cache: {
      dir: options.cache?.dir ? import_path13.default.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
    },
    chunks: {
      baseChunkName: options.chunks?.baseChunkName ?? DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      loader: options.chunks?.loader ?? DEFAULT_BUILD_OPTIONS.chunks.loader,
      manifestFile: chunkManifestFile,
      mode: options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
      publicPath: chunkPublicPath
    },
    compilationLevel: options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight: options.diagnostics?.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose: options.diagnostics?.verbose ?? DEFAULT_BUILD_OPTIONS.diagnostics.verbose
    },
    entries: options.entries.map((entry) => import_path13.default.isAbsolute(entry) ? entry : import_path13.default.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => import_path13.default.isAbsolute(filePath) ? filePath : import_path13.default.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => import_path13.default.isAbsolute(filePath) ? filePath : import_path13.default.resolve(projectRoot, filePath)),
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    outputNames: [...options.outputNames ?? []],
    packages: {
      mode: options.packages?.mode ?? DEFAULT_BUILD_OPTIONS.packages.mode
    },
    projectRoot,
    srcDir
  };
}
function normalizeChunkPublicPath(publicPath) {
  if (publicPath.length === 0) {
    return "./";
  }
  return publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
}
var import_path13;
var init_options = __esm(() => {
  init_types();
  import_path13 = __toESM(require("path"));
});

// src/pipeline/resolve-build.ts
async function createBuildContext(options) {
  const packageRoot2 = getPackageRoot();
  const usesPersistentCache = options.cache.mode === "persistent";
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot: packageRoot2,
    packageSignature: usesPersistentCache ? await getPackageSignature(packageRoot2) : "",
    projectCacheDir: import_path14.default.join(import_path14.default.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), hashContent(options.projectRoot))
  };
}
async function resolveBuild(context) {
  const { options } = context;
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }
  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot
  });
  const usesPersistentCache = options.cache.mode === "persistent";
  const sourceRoot = import_path14.default.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = usesPersistentCache ? await hashTsConfig(tsConfigPath) : "";
  const entryRelativePaths = options.entries.map((entry) => import_path14.default.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => import_path14.default.join(sourceRoot, import_path14.default.relative(options.srcDir, entry)));
  const resolveSnapshotPath = import_path14.default.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = usesPersistentCache ? await readJsonIfExists(resolveSnapshotPath) : null;
  if (cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
    const shimDir2 = import_path14.default.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      lazyImports: cachedSnapshot.lazyImports ?? [],
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: import_path14.default.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: import_path14.default.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: shimFiles2,
      sourceFiles: cachedSnapshot.sourceFiles,
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir
    };
  }
  const graphResult = resolveGraph({
    entries: overlayEntries,
    packageMode: options.packages.mode,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir
  });
  const outputNames = resolveOutputNames(entryRelativePaths, options.outputNames);
  const resolvedLazyImports = graphResult.lazyImports;
  const resolveKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature
  }) : "active";
  const resolveMetadataPath = import_path14.default.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = usesPersistentCache ? await readJsonIfExists(resolveMetadataPath) : null;
  if (!resolveMetadata) {
    const entryFiles2 = graphResult.entries.map((entry, index) => ({
      chunkName: sanitizeChunkName(outputNames[index]),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: outputNames[index],
      sourcePath: entry.sourcePath,
      sourceRelativePath: import_path14.default.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = import_path14.default.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    resolveMetadata = {
      chunkPlan: planChunks({
        baseChunkName: options.chunks.baseChunkName,
        chunkMode: options.chunks.mode,
        entryFiles: entryFiles2.map((entry) => ({
          chunkName: entry.chunkName,
          outputName: entry.outputName,
          sourcePath: entry.sourcePath
        })),
        graphEntries: [
          ...Object.entries(graphResult.graph).map(([filePath, dependencies]) => ({
            dependencies,
            filePath
          })),
          ...shimFiles2.map((shimFile, index) => ({
            dependencies: [entryFiles2[index].sourcePath],
            filePath: shimFile
          }))
        ],
        lazyImports: resolvedLazyImports,
        shimFiles: shimFiles2,
        workspaceDir: cacheStore.workspaceDir
      }),
      entryFiles: entryFiles2.map((entry) => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath
      })),
      lazyImports: resolvedLazyImports
    };
    if (usesPersistentCache) {
      await writeJson(resolveMetadataPath, resolveMetadata);
    }
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
  const shimDir = import_path14.default.join(cacheStore.workspaceDir, "entries");
  const shimFiles = toShimFiles(entryFiles, shimDir);
  const nativeEmitKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    packageSignature: context.packageSignature,
    resolveKey
  }) : "active";
  const finalKey = usesPersistentCache ? hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash: await hashExternalInputs([
      ...options.externs,
      ...options.js
    ]),
    languageOut: options.languageOut,
    packageSignature: context.packageSignature,
    resolveKey
  }) : "active";
  const trackedFiles = usesPersistentCache ? await collectTrackedFiles([
    ...graphResult.trackedFiles,
    tsConfigPath,
    ...options.externs,
    ...options.js
  ]) : {};
  if (usesPersistentCache) {
    await writeJson(resolveSnapshotPath, {
      compilerOptionsHash,
      entryFiles: resolveMetadata.entryFiles,
      finalKey,
      lazyImports: resolvedLazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases: graphResult.packageAliases,
      packageJsonFiles: graphResult.packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey,
      sourceFiles: graphResult.sourceFiles,
      trackedFiles
    });
  }
  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    lazyImports: resolvedLazyImports,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    finalCacheDir: import_path14.default.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: import_path14.default.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  };
}
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = import_path14.default.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
var import_path14;
var init_resolve_build = __esm(() => {
  init_hash();
  init_store();
  init_file_state();
  init_load();
  init_entries();
  init_signatures();
  init_workspace();
  init_options();
  init_signatures();
  import_path14 = __toESM(require("path"));
});

// src/stages/native/closure-ir/diagnostics.ts
function shouldIgnorePreflightDiagnostic(diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }
  const message = import_typescript8.default.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
}
var import_typescript8;
var init_diagnostics = __esm(() => {
  import_typescript8 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/decorators.ts
function containsDecorators(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (import_typescript9.default.canHaveDecorators(node) && (import_typescript9.default.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    import_typescript9.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function transpileDecoratedSource({
  compilerOptions,
  fileName,
  sourceText
}) {
  return import_typescript9.default.transpileModule(sourceText, {
    compilerOptions: {
      ...compilerOptions,
      module: import_typescript9.default.ModuleKind.ESNext,
      moduleResolution: import_typescript9.default.ModuleResolutionKind.Bundler,
      sourceMap: false,
      target: import_typescript9.default.ScriptTarget.ES2018
    },
    fileName,
    reportDiagnostics: true
  });
}
var import_typescript9;
var init_decorators = __esm(() => {
  import_typescript9 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata.ts
function collectClosureIrFiles({
  compilerOptions,
  fileNames,
  program
}) {
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const inputFiles = new Set(fileNames);
  const diagnostics = [];
  const files = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }
    const typeDeclarations = [];
    const topLevelDocs = [];
    const enumDeclarations = [];
    for (const statement of sourceFile.statements) {
      if (import_typescript10.default.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker));
        continue;
      }
      if (import_typescript10.default.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker));
        continue;
      }
      if (import_typescript10.default.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols);
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }
      if (import_typescript10.default.isFunctionDeclaration(statement) && statement.name) {
        const objectParamRecord = buildFunctionObjectParamRecord(statement, checker);
        if (objectParamRecord) {
          typeDeclarations.push({ snippet: objectParamRecord.snippet });
        }
        const jsdoc = buildFunctionJsDoc(statement, checker, objectParamRecord?.typeName);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: statement.name.text
          });
        }
        continue;
      }
      if (import_typescript10.default.isClassDeclaration(statement) && statement.name) {
        const jsdoc = buildClassJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "class",
            name: statement.name.text
          });
        }
      }
    }
    let decoratedOutputText;
    if (containsDecorators(sourceFile)) {
      const transpiled = transpileDecoratedSource({
        compilerOptions,
        fileName: sourceFile.fileName,
        sourceText: sourceFile.getFullText()
      });
      diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === import_typescript10.default.DiagnosticCategory.Error));
      decoratedOutputText = transpiled.outputText;
    }
    files.push({
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations
    });
  }
  return { diagnostics, files };
}
function collectUnsafeEnumSymbols(program, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & import_typescript10.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node) => {
      if (import_typescript10.default.isElementAccessExpression(node) && import_typescript10.default.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (import_typescript10.default.isCallExpression(node) && import_typescript10.default.isPropertyAccessExpression(node.expression) && import_typescript10.default.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && import_typescript10.default.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (import_typescript10.default.isIdentifier(node) && !import_typescript10.default.isPropertyAccessExpression(node.parent) && !import_typescript10.default.isElementAccessExpression(node.parent) && !import_typescript10.default.isImportSpecifier(node.parent) && !import_typescript10.default.isImportClause(node.parent) && !import_typescript10.default.isExportSpecifier(node.parent) && !import_typescript10.default.isEnumDeclaration(node.parent) && !import_typescript10.default.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & import_typescript10.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & import_typescript10.default.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      import_typescript10.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & import_typescript10.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }
  const members = [];
  let valueType = null;
  let nextNumber = 0;
  for (const member of statement.members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      return null;
    }
    const constantValue = checker.getConstantValue(member);
    const memberValue = constantValue ?? (member.initializer ? literalValueFromExpression(member.initializer) : nextNumber);
    if (memberValue === undefined) {
      return null;
    }
    const currentValueType = typeof memberValue;
    if (currentValueType !== "number" && currentValueType !== "string" && currentValueType !== "boolean") {
      return null;
    }
    if (valueType && valueType !== currentValueType) {
      return null;
    }
    valueType = currentValueType;
    members.push({ name: memberName, value: memberValue });
    if (typeof memberValue === "number") {
      nextNumber = memberValue + 1;
    }
  }
  if (!valueType || members.length === 0) {
    return null;
  }
  if (valueType === "number" && !hasConstModifier(statement)) {
    return null;
  }
  return {
    exported: hasExportModifier(statement),
    members,
    name: statement.name.text,
    valueType
  };
}
function buildInterfaceDeclarationSnippet(statement, checker) {
  const lines = ["/**"];
  lines.push(" * @record");
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(" */");
  lines.push(`function ${statement.name.text}() {}`);
  for (const member of statement.members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      continue;
    }
    if (import_typescript10.default.isPropertySignature(member)) {
      const propertyType = member.type ? toClosureType(checker.getTypeFromTypeNode(member.type), checker) : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
      continue;
    }
    if (import_typescript10.default.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(signature, checker);
      lines.push(`/** @type {${functionType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
    }
  }
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildTypeAliasDeclarationSnippet(statement, checker) {
  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker);
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(` * @typedef {${closureType}}`);
  lines.push(" */");
  lines.push(`let ${statement.name.text};`);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildFunctionJsDoc(statement, checker, firstParamObjectRecordTypeName) {
  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  for (const [index, parameter] of signature.getParameters().entries()) {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    const parameterName = index === 0 && firstParamObjectRecordTypeName ? "__props" : parameter.getName();
    const closureType = index === 0 && firstParamObjectRecordTypeName ? `!${firstParamObjectRecordTypeName}` : toClosureType(parameterType, checker);
    lines.push(` * @param {${closureType}} ${parameterName}`);
  }
  const returnType = checker.getReturnTypeOfSignature(signature);
  lines.push(` * @return {${toClosureType(returnType, checker)}}`);
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function buildFunctionObjectParamRecord(statement, checker) {
  if (!isComponentLikeName(statement.name?.text)) {
    return null;
  }
  const firstParameter = statement.parameters[0];
  if (!firstParameter || !import_typescript10.default.isObjectBindingPattern(firstParameter.name) || hasRestElement(firstParameter.name)) {
    return null;
  }
  const parameterType = checker.getTypeAtLocation(firstParameter);
  const properties = checker.getPropertiesOfType(parameterType);
  if (properties.length === 0) {
    return null;
  }
  const typeName = `${statement.name.text}$Param0`;
  const lines = ["/**", " * @record", " */", `function ${typeName}() {}`];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? firstParameter;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    lines.push(`/** @type {${toClosureType(propertyType, checker)}} */`);
    lines.push(`${typeName}.prototype.${renderPropertyName(property.getName())};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`,
    typeName
  };
}
function hasRestElement(pattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}
function isComponentLikeName(name) {
  return !!name && /^[A-Z]/.test(name);
}
function buildClassJsDoc(statement, checker) {
  const typeParameters = statement.typeParameters ?? [];
  const lines = ["/**"];
  for (const templateName of getTemplateNames(typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureType(checker.getTypeAtLocation(typeNode), checker);
        if (clause.token === import_typescript10.default.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === import_typescript10.default.SyntaxKind.ImplementsKeyword) {
          lines.push(` * @implements {${closureType}}`);
        }
      }
    }
  }
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function getTemplateNames(typeParameters) {
  return (typeParameters ?? []).map((parameter) => parameter.name.text);
}
function hasExportModifier(node) {
  return (import_typescript10.default.getCombinedModifierFlags(node) & import_typescript10.default.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (import_typescript10.default.getCombinedModifierFlags(node) & import_typescript10.default.ModifierFlags.Const) !== 0;
}
function getPropertyNameText2(name) {
  if (!name) {
    return null;
  }
  if (import_typescript10.default.isIdentifier(name) || import_typescript10.default.isStringLiteral(name) || import_typescript10.default.isNumericLiteral(name) || import_typescript10.default.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `[${JSON.stringify(name)}]`;
}
function literalValueFromExpression(expression) {
  if (import_typescript10.default.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (import_typescript10.default.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === import_typescript10.default.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === import_typescript10.default.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (import_typescript10.default.isPrefixUnaryExpression(expression) && expression.operator === import_typescript10.default.SyntaxKind.MinusToken && import_typescript10.default.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text);
  }
  return;
}
function signatureToClosureFunctionType(signature, checker) {
  const params = signature.getParameters().map((parameter) => {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    return toClosureType(parameterType, checker);
  });
  const returnType = toClosureType(checker.getReturnTypeOfSignature(signature), checker);
  return `function(${params.join(", ")}): ${returnType}`;
}
function toClosureType(type, checker, seen = new Set) {
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);
  if (type.flags & import_typescript10.default.TypeFlags.Any)
    return "?";
  if (type.flags & import_typescript10.default.TypeFlags.Unknown)
    return "?";
  if (type.flags & import_typescript10.default.TypeFlags.StringLike)
    return "string";
  if (type.flags & import_typescript10.default.TypeFlags.NumberLike)
    return "number";
  if (type.flags & import_typescript10.default.TypeFlags.BooleanLike)
    return "boolean";
  if (type.flags & import_typescript10.default.TypeFlags.Void)
    return "void";
  if (type.flags & import_typescript10.default.TypeFlags.Undefined)
    return "undefined";
  if (type.flags & import_typescript10.default.TypeFlags.Null)
    return "null";
  if (type.flags & import_typescript10.default.TypeFlags.Never)
    return "never";
  if (type.flags & import_typescript10.default.TypeFlags.TypeParameter)
    return checker.typeToString(type);
  if (type.isUnion()) {
    return `(${type.types.map((item) => toClosureType(item, checker, seen)).join("|")})`;
  }
  if (checker.isArrayType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    const elementType = typeArguments[0] ? toClosureType(typeArguments[0], checker, seen) : "?";
    return `!Array<${elementType}>`;
  }
  if (checker.isTupleType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${typeArguments.map((item) => toClosureType(item, checker, seen)).join("|")}>`;
  }
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0) {
    return signatureToClosureFunctionType(callSignatures[0], checker);
  }
  if (type.getSymbol()) {
    const symbolName = checker.symbolToString(type.getSymbol());
    if (symbolName && symbolName !== "__type") {
      return symbolName;
    }
  }
  if (type.isClassOrInterface() || type.getProperties().length > 0 && !(type.flags & import_typescript10.default.TypeFlags.Object)) {
    return "!Object";
  }
  return "?";
}
var import_typescript10;
var init_metadata = __esm(() => {
  init_decorators();
  import_typescript10 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir.ts
async function collectNativeTypeAnalysis({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: import_typescript11.default.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript11.default.ScriptTarget.ESNext
  });
  const program = import_typescript11.default.createProgram(fileNames, compilerOptions);
  const preflightDiagnostics = preflight === "full" ? [...import_typescript11.default.getPreEmitDiagnostics(program)].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic)) : [];
  const { diagnostics: closureIrDiagnostics, files } = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program
  });
  return {
    diagnostics: [...preflightDiagnostics, ...closureIrDiagnostics],
    files
  };
}
var import_typescript11;
var init_closure_ir = __esm(() => {
  init_compiler_options();
  init_diagnostics();
  init_metadata();
  import_typescript11 = __toESM(require("typescript"));
});

// src/stages/native/emit.ts
async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir
}) {
  const usesPersistentCache = options.cache.mode === "persistent";
  const outDir = import_path15.default.join(cacheDir, "out");
  const externsPath = import_path15.default.join(cacheDir, "native-generated.externs.js");
  const metadataPathForNative = import_path15.default.join(cacheDir, "closure-ir.json");
  const runtimePackageInputs = await collectTsxRuntimePackageInputs({
    fileNames,
    tsConfigPath,
    workspaceDir
  });
  const runtimeSupportFiles = runtimePackageInputs.sourceFiles.map((fileName) => toEmittedPath(fileName, outDir, workspaceDir));
  const combinedFileNames = uniqueSorted2([
    ...fileNames,
    ...runtimePackageInputs.sourceFiles
  ]);
  const combinedPackageAliases = mergePackageAliases([
    ...packageAliases,
    ...runtimePackageInputs.packageAliases
  ]);
  const combinedPackageJsonFiles = uniqueSorted2([
    ...packageJsonFiles,
    ...runtimePackageInputs.packageJsonFiles
  ]);
  const dependencyModules = collectDependencyModules(combinedPackageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir,
    sourceFiles: combinedFileNames,
    workspaceDir
  });
  const cachedMetadata = usesPersistentCache ? await readMetadata(metadataPath) : null;
  if (cachedMetadata && await filesExist([
    cachedMetadata.externsPath,
    cachedMetadata.metadataPath,
    ...cachedMetadata.emittedFiles,
    ...cachedMetadata.supportFiles
  ])) {
    return {
      dependencyModules: cachedMetadata.dependencyModules,
      dependencyRuntimeFiles: cachedMetadata.dependencyRuntimeFiles,
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles
    };
  }
  await import_fs11.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs11.default.promises.mkdir(outDir, { recursive: true });
  const missingInputDiagnostics = await getMissingInputDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  const analysis = await collectNativeTypeAnalysis({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir
  });
  if (analysis.diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysis.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  await import_fs11.default.promises.writeFile(metadataPathForNative, JSON.stringify(analysis.files, null, 2), "utf-8");
  const result = transpileSources({
    chunkMode: options.chunks.mode,
    metadataPath: metadataPathForNative,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir
  });
  const finalSupportFiles = uniqueSorted2([
    ...runtimeSupportFiles,
    ...result.supportFiles
  ]);
  if (usesPersistentCache) {
    await import_fs11.default.promises.writeFile(metadataPath, JSON.stringify({
      dependencyModules,
      dependencyRuntimeFiles,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath: metadataPathForNative,
      supportFiles: finalSupportFiles,
      version: NATIVE_EMIT_METADATA_VERSION
    }, null, 2), "utf-8");
  }
  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles
  };
}
async function collectTsxRuntimePackageInputs({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const resolvedEntry = require3.resolve(runtimeSpecifier, {
    paths: [workspaceDir]
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(resolvedEntry, workspaceDir);
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: import_path15.default.join(workspaceDir, "src"),
    workspaceDir
  });
  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles
  };
}
async function getMissingInputDiagnostics({
  fileNames,
  preflight,
  tsConfigPath
}) {
  if (preflight === "off") {
    return [];
  }
  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates.filter((state) => !state.exists).map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(`Missing required build input(s): ${missingFiles.join(", ")}`)
    ];
  }
  return [];
}
function createSimpleDiagnostic(messageText) {
  return {
    category: import_typescript12.default.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
function getJsxRuntimeSpecifier(compilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case import_typescript12.default.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case import_typescript12.default.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
async function readMetadata(metadataPath) {
  try {
    const raw = await import_fs11.default.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      dependencyModules: parsed.dependencyModules ?? [],
      dependencyRuntimeFiles: parsed.dependencyRuntimeFiles ?? [],
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      metadataPath: parsed.metadataPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function toEmittedPath(sourcePath, outDir, workspaceDir) {
  return import_path15.default.join(outDir, import_path15.default.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
}
function collectDependencyModules(packageAliases) {
  return uniqueSorted2(packageAliases.filter((alias) => isDependencyFile(alias.targetPath)).map((alias) => alias.subpath === "." ? alias.packageName : `${alias.packageName}/${alias.subpath.replace(/^\.\//, "")}`));
}
function collectDependencyRuntimeFiles({
  outDir,
  sourceFiles,
  workspaceDir
}) {
  return uniqueSorted2(sourceFiles.filter((filePath) => isDependencyFile(filePath)).map((filePath) => toEmittedPath(filePath, outDir, workspaceDir)));
}
function isDependencyFile(filePath) {
  return import_path15.default.resolve(filePath).includes(`${import_path15.default.sep}node_modules${import_path15.default.sep}`);
}
function uniqueSorted2(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function mergePackageAliases(aliases) {
  const merged = new Map;
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\x00${alias.subpath}`, alias);
  }
  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\x00${left.subpath}`;
    const rightKey = `${right.packageName}\x00${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}
function toWorkspaceNodeModulesPath(resolvedPath, workspaceDir) {
  const marker = `${import_path15.default.sep}node_modules${import_path15.default.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return import_path15.default.join(workspaceDir, relativeNodeModulesPath);
}
function toRuntimePackageAlias(specifier, targetPath) {
  const segments = specifier.startsWith("@") ? specifier.split("/", 3) : specifier.split("/", 2);
  const packageName = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  const subpath = specifier.startsWith("@") ? segments[2] : segments[1];
  return {
    packageName,
    subpath: subpath ? `./${subpath}` : ".",
    targetPath
  };
}
var import_fs11, import_path15, import_typescript12, require3, NATIVE_EMIT_METADATA_VERSION = 7;
var init_emit = __esm(() => {
  init_bundle_location();
  init_file_state();
  init_load();
  init_load();
  init_load();
  init_compiler_options();
  init_closure_ir();
  import_fs11 = __toESM(require("fs"));
  import_path15 = __toESM(require("path"));
  import_typescript12 = __toESM(require("typescript"));
  require3 = createBundleRequire();
});

// src/stages/closure/compiler.ts
function applyInternalClosureDebugOptions(closureOptions) {
  const mutableOptions = closureOptions;
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
    mutableOptions.useTypesForOptimization = false;
  }
}
function configureClosureCompilerOptions(closureOptions) {
  applyInternalClosureDebugOptions(closureOptions);
}
async function runClosureCompiler(options) {
  const closureCompiler = closureCompilerPackage.compiler;
  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(new closureCompiler(options));
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      if (stdOut) {
        console.log(stdOut);
      }
      if (stdErr) {
        console.error(stdErr);
      }
      resolve(exitCode);
    });
  });
}
function resolveClosureCompilerVersionTag() {
  return resolveClosureCompilerJarPath() ?? import_utils.getNativeImagePath() ?? "native";
}
function getDefaultString(value) {
  if (typeof value === "object" && value !== null && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return;
}
function resolveClosureCompilerJarPath() {
  const closureCompilerModule = closureCompilerPackage;
  const closureCompiler = closureCompilerPackage.compiler;
  const jarPath = typeof closureCompiler.JAR_PATH === "string" ? closureCompiler.JAR_PATH : typeof closureCompilerModule.JAR_PATH === "string" ? closureCompilerModule.JAR_PATH : getDefaultString(closureCompiler.JAR_PATH) ?? getDefaultString(closureCompilerModule.JAR_PATH);
  return jarPath;
}
function configureClosureCompilerInstance(instance) {
  const nativeImagePath = import_utils.getNativeImagePath();
  if (nativeImagePath) {
    instance.JAR_PATH = null;
    instance.javaPath = nativeImagePath;
    return instance;
  }
  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    instance.JAR_PATH = jarPath;
  }
  return instance;
}
var closureCompilerPackage, import_utils;
var init_compiler2 = __esm(() => {
  closureCompilerPackage = __toESM(require("google-closure-compiler"));
  import_utils = require("google-closure-compiler/lib/utils.js");
});

// src/stages/closure/cache.ts
function getCompileJobOutputFiles(job) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) => import_path16.default.join(job.chunkOutputPathPrefix, `${chunkSpec.split(":", 1)[0]}.js`));
  }
  throw new Error("Closure compile job is missing output configuration.");
}
async function tryRestoreCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  outputFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job, compilerVersion);
  const metadata = await readJsonIfExists(import_path16.default.join(jobCacheDir, "meta.json"));
  if (!metadata || metadata.version !== CLOSURE_JOB_CACHE_VERSION || metadata.outputFiles.length !== outputFiles.length) {
    return false;
  }
  const cachedFiles = metadata.outputFiles.map((fileName) => import_path16.default.join(jobCacheDir, fileName));
  const filesReady = await Promise.all(cachedFiles.map((filePath) => import_promises.default.stat(filePath).then(() => true).catch(() => false)));
  if (filesReady.some((ready) => !ready)) {
    return false;
  }
  await Promise.all(outputFiles.map(async (outputFile, index) => {
    await import_promises.default.mkdir(import_path16.default.dirname(outputFile), { recursive: true });
    await import_promises.default.copyFile(cachedFiles[index], outputFile);
  }));
  return true;
}
async function persistCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  outputFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job, compilerVersion);
  await import_promises.default.rm(jobCacheDir, { force: true, recursive: true });
  await import_promises.default.mkdir(jobCacheDir, { recursive: true });
  const outputNames = outputFiles.map((outputFile) => import_path16.default.basename(outputFile));
  await Promise.all(outputFiles.map((outputFile, index) => import_promises.default.copyFile(outputFile, import_path16.default.join(jobCacheDir, outputNames[index]))));
  await writeJson(import_path16.default.join(jobCacheDir, "meta.json"), {
    outputFiles: outputNames,
    version: CLOSURE_JOB_CACHE_VERSION
  });
}
async function getClosureJobCacheDir(cacheDir, job, compilerVersion) {
  const outputFiles = getCompileJobOutputFiles(job);
  const jsHash = await hashFilesInOrder(job.js);
  const externHash = await hashFilesInOrder(job.externs);
  const cacheKey = hashJson({
    compilerVersion,
    externHash,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      jsOutputKinds: outputFiles.map((outputFile) => import_path16.default.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel
    },
    jsHash,
    version: CLOSURE_JOB_CACHE_VERSION
  });
  return import_path16.default.join(cacheDir, cacheKey);
}
async function hashFilesInOrder(filePaths) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}
async function hashFileInput(filePath) {
  const stat = await import_promises.default.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = closureInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = import_promises.default.readFile(filePath, "utf-8").then((contents) => hashContent(contents));
  closureInputHashCache.set(cacheKey, pending);
  return pending;
}
var import_promises, import_path16, CLOSURE_JOB_CACHE_VERSION = 1, closureInputHashCache;
var init_cache = __esm(() => {
  init_hash();
  init_store();
  import_promises = __toESM(require("fs/promises"));
  import_path16 = __toESM(require("path"));
  closureInputHashCache = new Map;
});

// src/stages/closure/concurrency.ts
function determineClosureConcurrency(jobCount) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }
  const available = import_os2.default.availableParallelism?.() ?? import_os2.default.cpus().length ?? 1;
  return Math.min(jobCount, Math.max(1, available - 1));
}
async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;; ) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current]);
    }
  }));
  return results;
}
var import_os2;
var init_concurrency = __esm(() => {
  import_os2 = __toESM(require("os"));
});

// src/stages/closure/run-closure.ts
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
  projectCacheDir,
  supportFiles,
  packageRoot: packageRoot2
}) {
  await import_promises2.default.rm(finalCacheDir, { force: true, recursive: true });
  await import_promises2.default.mkdir(finalCacheDir, { recursive: true });
  const rawDir = import_path17.default.join(finalCacheDir, "raw");
  const cacheOutputDir = import_path17.default.join(finalCacheDir, "outputs");
  await import_promises2.default.mkdir(rawDir, { recursive: true });
  await import_promises2.default.mkdir(cacheOutputDir, { recursive: true });
  await import_promises2.default.rm(outDir, { force: true, recursive: true });
  await import_promises2.default.mkdir(outDir, { recursive: true });
  const prepared = prepareClosureJobs({
    chunkLoader: options.chunks.loader,
    chunkMode: options.chunks.mode,
    chunkPlan,
    compilationLevel: options.compilationLevel,
    diagnosticsVerbose: options.diagnostics.verbose,
    emittedOutDir,
    explicitExternPaths,
    explicitJsInputs: options.js,
    finalCacheDir,
    generatedExternPaths,
    languageOut: options.languageOut,
    manifestFile: options.chunks.manifestFile,
    nativeExternPath,
    outDir,
    packageRoot: packageRoot2,
    publicPath: options.chunks.publicPath,
    supportFiles
  });
  await Promise.all(prepared.generatedAssets.map(async (asset) => {
    await import_promises2.default.mkdir(import_path17.default.dirname(asset.path), { recursive: true });
    await import_promises2.default.writeFile(asset.path, asset.text, "utf-8");
  }));
  const closureJobCacheDir = options.cache.mode === "off" ? null : import_path17.default.join(projectCacheDir, "closure-jobs");
  const concurrency = options.chunks.mode === "bundler-runtime" ? determineClosureConcurrency(prepared.compileJobs.length) : 1;
  const exitCodes = await runWithConcurrency(prepared.compileJobs, concurrency, async (job) => runPreparedClosureJob({
    cacheDir: closureJobCacheDir,
    job
  }));
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }
  await Promise.all(prepared.postprocessActions.map(async (action) => {
    await import_promises2.default.mkdir(import_path17.default.dirname(action.outputPath), { recursive: true });
    if (action.kind === "rewrite-gcc-exports") {
      const contents = await import_promises2.default.readFile(action.inputPath, "utf-8");
      await import_promises2.default.writeFile(action.outputPath, rewriteGccExports(contents));
      return;
    }
    await import_promises2.default.copyFile(action.inputPath, action.outputPath);
  }));
  await copyOrLinkFiles(prepared.publishedOutputs, cacheOutputDir);
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) => import_path17.default.join(cacheOutputDir, import_path17.default.relative(outDir, outputFile)));
  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs
  };
}
async function runPreparedClosureJob({
  cacheDir,
  job
}) {
  const outputFiles = getCompileJobOutputFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir ? await tryRestoreCachedClosureJob({
    cacheDir,
    compilerVersion,
    job,
    outputFiles
  }) : false;
  if (cached) {
    return 0;
  }
  const closureOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel
  };
  if (job.chunk) {
    closureOptions.chunk = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions.chunkOutputPathPrefix = job.chunkOutputPathPrefix;
  }
  if (job.dependencyMode) {
    closureOptions.dependencyMode = job.dependencyMode;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions.entryPoint = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions.jsOutputFile = job.jsOutputFile;
  }
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }
  if (cacheDir) {
    await persistCachedClosureJob({
      cacheDir,
      compilerVersion,
      job,
      outputFiles
    });
  }
  return 0;
}
var import_promises2, import_path17;
var init_run_closure = __esm(() => {
  init_file_state();
  init_load();
  init_compiler2();
  init_cache();
  init_concurrency();
  import_promises2 = __toESM(require("fs/promises"));
  import_path17 = __toESM(require("path"));
});

// src/pipeline/build-helpers.ts
async function generateRuntimeDependencyExterns({
  appEntryFiles,
  cacheMode,
  cacheDir,
  dependencyModules,
  dependencyRuntimeFiles,
  projectRoot,
  srcDir,
  tsConfigPath
}) {
  if (dependencyModules.length === 0 || dependencyRuntimeFiles.length === 0) {
    return null;
  }
  const outputFile = import_path18.default.join(cacheDir, "runtime-dependency-externs.js");
  const metadataPath = import_path18.default.join(cacheDir, "runtime-dependency-externs.meta.json");
  if (cacheMode !== "off") {
    const compilerOptions = await loadCompilerOptions(tsConfigPath);
    const cacheKey = hashJson({
      appEntryFiles,
      compilerOptions,
      dependencyModules,
      dependencyRuntimeFiles,
      projectRoot,
      srcDir,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION
    });
    const cachedMetadata = await readJsonIfExists(metadataPath);
    if (cachedMetadata?.version === RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION && cachedMetadata.key === cacheKey && cachedMetadata.outputFile === outputFile && await filesExist([outputFile])) {
      return outputFile;
    }
    await generateExterns({
      appEntryFiles,
      mode: "runtime-aware",
      modules: dependencyModules,
      outputFile,
      projectRoot,
      runtimeEntryFiles: dependencyRuntimeFiles,
      srcDir,
      tsConfigPath
    });
    await writeJson(metadataPath, {
      key: cacheKey,
      outputFile,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION
    });
    return outputFile;
  }
  await generateExterns({
    appEntryFiles,
    mode: "runtime-aware",
    modules: dependencyModules,
    outputFile,
    projectRoot,
    runtimeEntryFiles: dependencyRuntimeFiles,
    srcDir,
    tsConfigPath
  });
  return outputFile;
}
async function publishOutputs(outputFiles, outDir) {
  if (await publishedOutputsMatch2(outputFiles, outDir)) {
    return;
  }
  await copyOrLinkFiles(outputFiles, outDir);
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
function toPublishedOutputPaths(publishedOutputs, outDir) {
  return publishedOutputs.map(({ name }) => import_path18.default.join(outDir, name));
}
function createBuildDiagnostic(error) {
  return {
    category: 1,
    code: 0,
    messageText: error instanceof Error ? error.message : typeof error === "string" ? error : "Build failed."
  };
}
async function removeProjectCacheDir(projectCacheDir) {
  await import_fs12.default.promises.rm(projectCacheDir, { force: true, recursive: true });
}
var import_fs12, import_path18, RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION = 1;
var init_build_helpers = __esm(() => {
  init_externs();
  init_hash();
  init_store();
  init_file_state();
  init_compiler_options();
  import_fs12 = __toESM(require("fs"));
  import_path18 = __toESM(require("path"));
});

// src/pipeline/build-pipeline.ts
var exports_build_pipeline = {};
__export(exports_build_pipeline, {
  cleanCache: () => cleanCache,
  build: () => build
});
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  const usesPersistentCache = context.options.cache.mode === "persistent";
  if (usesPersistentCache) {
    const fastSnapshot = await readJsonIfExists(import_path19.default.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(fastSnapshot.publishedOutputs, context.options.outDir)
      };
    }
  }
  let resolved = null;
  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = import_path19.default.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = usesPersistentCache ? await readJsonIfExists(finalMetadataPath) : null;
    if (usesPersistentCache && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(finalMetadata.outputFiles.map((outputFile) => ({
          name: import_path19.default.basename(outputFile)
        })), context.options.outDir)
      };
    }
    if (context.options.chunks.mode !== "off" && resolvedBuild.entryFiles.some((entry) => entry.exportNames.length > 0 || entry.hasDefaultExport)) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic("Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.")
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode === "off" && resolvedBuild.lazyImports.length > 0) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic('Dynamic import() requires chunks.mode = "bundler-runtime".')
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode === "off") {
      writeEntryShims({
        entries: resolvedBuild.entryFiles.map((entry) => ({
          exportNames: entry.exportNames,
          hasDefaultExport: entry.hasDefaultExport,
          importPath: toImportPath(import_path19.default.relative(import_path19.default.dirname(import_path19.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
          shimPath: import_path19.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
        }))
      });
    }
    const nativeEmitMetadataPath = import_path19.default.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: context.options.chunks.mode !== "off" ? resolvedBuild.sourceFiles : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      lazyImports: resolvedBuild.lazyImports,
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      packageAliases: resolvedBuild.packageAliases,
      packageJsonFiles: resolvedBuild.packageJsonFiles,
      tsConfigPath: resolvedBuild.tsConfigPath,
      workspaceDir: resolvedBuild.workspaceDir
    });
    if (nativeEmitResult.diagnostics.length > 0 || nativeEmitResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: nativeEmitResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    const runtimeDependencyExterns = await generateRuntimeDependencyExterns({
      appEntryFiles: context.options.entries,
      cacheMode: context.options.cache.mode,
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      dependencyModules: nativeEmitResult.dependencyModules,
      dependencyRuntimeFiles: nativeEmitResult.dependencyRuntimeFiles,
      projectRoot: context.options.projectRoot,
      srcDir: context.options.srcDir,
      tsConfigPath: resolvedBuild.tsConfigPath
    });
    const closureResult = await runClosureStage({
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      explicitExternPaths: context.options.externs,
      finalCacheDir: resolvedBuild.finalCacheDir,
      generatedExternPaths: runtimeDependencyExterns ? [runtimeDependencyExterns] : [],
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: context.options.outDir,
      projectCacheDir: context.projectCacheDir,
      supportFiles: nativeEmitResult.supportFiles,
      packageRoot: context.packageRoot
    });
    if (closureResult.exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode: closureResult.exitCode,
        outputFiles: []
      };
    }
    if (usesPersistentCache) {
      await writeJson(finalMetadataPath, {
        outputFiles: closureResult.cacheOutputFiles
      });
      await writeJson(import_path19.default.join(context.projectCacheDir, "final-fast.json"), {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats2(closureResult.outputFiles),
        trackedFiles: resolvedBuild.trackedFiles
      });
    }
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      outputFiles: closureResult.outputFiles
    };
  } catch (error) {
    return {
      cacheHit: false,
      diagnostics: [createBuildDiagnostic(error)],
      emitSkipped: true,
      exitCode: 1,
      outputFiles: []
    };
  } finally {
    await resolved?.cleanup();
  }
}
async function cleanCache(options = {}) {
  const projectRoot = import_path19.default.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = import_path19.default.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path19.default.join(cacheRoot, hashContent(projectRoot));
  await removeProjectCacheDir(projectCacheDir);
}
var import_path19;
var init_build_pipeline = __esm(() => {
  init_hash();
  init_store();
  init_file_state();
  init_resolve_build();
  init_emit();
  init_run_closure();
  init_load();
  init_build_helpers();
  import_path19 = __toESM(require("path"));
});

// src/api/build.ts
init_externs();

// src/cli/usage.ts
function usage() {
  console.error(`Usage: gcc-ts-bundler <command> [options]

Example:
  gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
  gcc-ts-bundler clean-cache --project-root=.
  gcc-ts-bundler externs --project-root=. --src-dir=. --entry=./main.ts --module=lit --module=@lit-labs/router --output-file=./closure-externs/lit.generated.js
  gcc-ts-bundler externs --project-root=. --src-dir=./src --entry=./main.ts --runtime-entry=./.prebundle/main.js --mode=runtime-aware --module=svelte --output-file=./closure-externs/runtime.generated.js

Commands:
  build               Build the requested entries
  clean-cache         Remove the persistent cache for a project root
  externs             Generate Closure externs from dependency types and runtime code

Build flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Output directory
  --language-out        ECMASCRIPT3 | ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT_NEXT
  --compilation-level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --chunks              off | bundler-runtime
  --chunk-loader        auto | script | fetch (bundler-runtime only)
  --chunk-public-path   Public URL prefix for chunk files in chunk mode
  --chunk-base-name     Base chunk output name in chunk mode
  --chunk-manifest      Relative manifest path in chunk mode
  --packages            off | esm-only
  --cache-mode          off | temp | persistent
  --cache-dir           Explicit cache directory
  --preflight           off | errors-only | full
  --verbose             Print verbose diagnostics
  --fatal-warnings      Treat typed transpile warnings as fatal
  -h, --help            Show this help message

Extern flags:
  --project-root          Project root used to resolve node_modules and tsconfig.json
  --src-dir               Source directory used to resolve extern analysis app entries
  --entry                 App entry file for boundary-aware usage analysis. May be provided multiple times
  --module                Package or subpath specifier to scan. May be provided multiple times
  --runtime-entry         Runtime JS entry for runtime-aware analysis. May be provided multiple times
  --mode                  boundary-aware | candidates | runtime-aware
  --output-file           Write generated externs to a file instead of stdout
  --include-dependencies  Follow imported declaration files across node_modules (default: true)
  --tsconfig              Explicit tsconfig path relative to --project-root

Modes:
  boundary-aware          App usage + dependency types
  candidates              Dependency types only
  runtime-aware           Dependency runtime code + dependency types, with optional app usage filtering from --entry
`);
}

// src/cli/parse-options.ts
init_types();
var import_minimist = __toESM(require("minimist"));
function asStringArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
function parseCliArgs(args) {
  const parsedArgs = import_minimist.default(args, {
    alias: {
      h: "help"
    },
    boolean: ["fatal-warnings", "help", "verbose"],
    string: [
      "cache-dir",
      "cache-mode",
      "chunk-base-name",
      "chunk-loader",
      "chunk-manifest",
      "chunk-public-path",
      "chunks",
      "compilation-level",
      "entry",
      "entry-point",
      "language-out",
      "out-dir",
      "packages",
      "preflight",
      "project-root",
      "src-dir"
    ]
  });
  if (parsedArgs.help) {
    return { options: { entries: [] }, showHelp: true };
  }
  const entries = asStringArray(parsedArgs.entry);
  return {
    options: {
      cache: {
        dir: parsedArgs["cache-dir"],
        mode: parsedArgs["cache-mode"] ?? DEFAULT_BUILD_OPTIONS.cache.mode
      },
      chunks: {
        baseChunkName: parsedArgs["chunk-base-name"],
        loader: parsedArgs["chunk-loader"],
        manifestFile: parsedArgs["chunk-manifest"],
        mode: parsedArgs.chunks ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
        publicPath: parsedArgs["chunk-public-path"]
      },
      compilationLevel: parsedArgs["compilation-level"],
      diagnostics: {
        fatalWarnings: Boolean(parsedArgs["fatal-warnings"]),
        preflight: parsedArgs.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
        verbose: Boolean(parsedArgs.verbose)
      },
      entries,
      externs: asStringArray(parsedArgs.externs),
      js: asStringArray(parsedArgs.js),
      languageOut: parsedArgs["language-out"],
      outDir: parsedArgs["out-dir"],
      projectRoot: parsedArgs["project-root"],
      packages: {
        mode: parsedArgs.packages ?? DEFAULT_BUILD_OPTIONS.packages.mode
      },
      srcDir: parsedArgs["src-dir"]
    },
    showHelp: false
  };
}

// src/cli/parse-externs-options.ts
var import_minimist2 = __toESM(require("minimist"));
function asStringArray2(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
function parseExternsCliArgs(args) {
  const hasIncludeDependenciesFlag = args.includes("--include-dependencies");
  const hasNoIncludeDependenciesFlag = args.includes("--no-include-dependencies");
  const parsedArgs = import_minimist2.default(args, {
    alias: {
      e: "entry",
      h: "help",
      o: "output-file",
      p: "project-root"
    },
    boolean: ["help", "include-dependencies"],
    string: [
      "entry",
      "mode",
      "module",
      "output-file",
      "project-root",
      "runtime-entry",
      "src-dir",
      "tsconfig"
    ]
  });
  if (parsedArgs.help) {
    return {
      options: { modules: [] },
      showHelp: true
    };
  }
  const modules = [...asStringArray2(parsedArgs.module)];
  return {
    options: {
      appEntryFiles: asStringArray2(parsedArgs.entry),
      includeDependencies: hasNoIncludeDependenciesFlag ? false : hasIncludeDependenciesFlag ? true : undefined,
      mode: parsedArgs.mode,
      modules,
      outputFile: parsedArgs["output-file"],
      projectRoot: parsedArgs["project-root"],
      runtimeEntryFiles: asStringArray2(parsedArgs["runtime-entry"]),
      srcDir: parsedArgs["src-dir"],
      tsConfigPath: parsedArgs.tsconfig
    },
    showHelp: false
  };
}

// src/api/build.ts
async function loadBuildPipeline() {
  return Promise.resolve().then(() => (init_build_pipeline(), exports_build_pipeline));
}
async function cleanCache2(options) {
  const pipeline = await loadBuildPipeline();
  return pipeline.cleanCache(options);
}
var build2 = async (options) => {
  const pipeline = await loadBuildPipeline();
  return pipeline.build(options);
};
async function runCli(args) {
  const [firstArg, ...restArgs] = args;
  if (!firstArg || firstArg === "-h" || firstArg === "--help") {
    usage();
    return 0;
  }
  if (firstArg === "clean-cache") {
    const { options: options2, showHelp: showHelp2 } = parseCliArgs(restArgs);
    if (showHelp2) {
      usage();
      return 0;
    }
    await cleanCache2({
      cacheDir: options2.cache?.dir,
      projectRoot: options2.projectRoot
    });
    return 0;
  }
  if (firstArg === "externs") {
    const { options: options2, showHelp: showHelp2 } = parseExternsCliArgs(restArgs);
    if (showHelp2 || options2.modules.length === 0) {
      usage();
      return showHelp2 ? 0 : 1;
    }
    const result2 = await generateExterns(options2);
    if (!result2.outputFile) {
      process.stdout.write(result2.text);
    }
    return 0;
  }
  const buildArgs = firstArg === "build" ? restArgs : args;
  const { options, showHelp } = parseCliArgs(buildArgs);
  if (showHelp) {
    usage();
    return 0;
  }
  const result = await build2(options);
  return result.exitCode;
}
async function main(args) {
  return runCli(args);
}

// src/entry/cli.ts
main(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
});
