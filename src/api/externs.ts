import fs from "fs";
import path from "path";
import ts from "typescript";

import { loadCompilerOptions } from "../stages/native/compiler-options";

export type GenerateExternsMode =
  | "boundary-aware"
  | "candidates"
  | "runtime-aware";

export interface GenerateExternsOptions {
  appEntryFiles?: string[];
  includeDependencies?: boolean;
  mode?: GenerateExternsMode;
  modules: string[];
  outputFile?: string;
  projectRoot?: string;
  runtimeEntryFiles?: string[];
  srcDir?: string;
  tsConfigPath?: string;
}

export interface GenerateExternsResult {
  mode: GenerateExternsMode;
  modules: string[];
  outputFile?: string;
  scannedFiles: string[];
  text: string;
}

const DECLARATION_EXTENSIONS = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

const BUILTIN_CONTAINER_NAMES = new Set([
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
  "WeakSet",
]);

const BUILTIN_RUNTIME_MEMBER_NAMES = new Set([
  "addEventListener",
  "apply",
  "attachShadow",
  "attributes",
  "length",
  "message",
  "name",
  "removeAttribute",
  "removeEventListener",
  "setAttribute",
]);

interface InterfaceContract {
  extends: Set<ts.Symbol>;
  members: Set<string>;
  name: string;
  symbol: ts.Symbol;
}

interface ClassContract {
  constructorParamContracts: Array<Set<ts.Symbol>>;
  instanceMembers: Set<string>;
  name: string;
  staticMembers: Set<string>;
  symbol: ts.Symbol;
  usedImplementedContracts: Set<ts.Symbol>;
}

interface TypeAliasContract {
  members: Set<string>;
  name: string;
  symbol: ts.Symbol;
}

interface ContractRegistry {
  classContracts: Map<ts.Symbol, ClassContract>;
  interfaceContracts: Map<ts.Symbol, InterfaceContract>;
  scannedFiles: Set<string>;
  typeAliasContracts: Map<ts.Symbol, TypeAliasContract>;
}

interface UsageAnalysis {
  nominalInstanceMembers: Map<ts.Symbol, Set<string>>;
  nominalStaticMembers: Map<ts.Symbol, Set<string>>;
  structuralContracts: Set<ts.Symbol>;
  structuralMembers: Set<string>;
}

export async function generateExterns(
  options: GenerateExternsOptions,
): Promise<GenerateExternsResult> {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }

  const mode = options.mode ?? "boundary-aware";
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath =
    options.tsConfigPath && path.resolve(projectRoot, options.tsConfigPath);
  const compilerOptions = await loadExternCompilerOptions({
    projectRoot,
    tsConfigPath,
  });
  const includeDependencies = options.includeDependencies ?? true;

  if (mode === "boundary-aware" && (options.appEntryFiles?.length ?? 0) === 0) {
    throw new Error(
      "generateExterns in boundary-aware mode requires appEntryFiles.",
    );
  }
  if (
    mode === "runtime-aware" &&
    (options.runtimeEntryFiles?.length ?? 0) === 0
  ) {
    throw new Error(
      "generateExterns in runtime-aware mode requires runtimeEntryFiles.",
    );
  }

  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot,
    specifiers: options.modules,
    tolerateMissing: mode === "runtime-aware",
  });
  const scannedFiles =
    typeEntryFiles.length === 0
      ? []
      : await collectReachableTypeFiles({
          compilerOptions,
          entryFiles: typeEntryFiles,
          includeDependencies,
        });
  const registry =
    scannedFiles.length === 0
      ? createEmptyContractRegistry()
      : collectContracts(
          ts.createProgram(scannedFiles, {
            ...compilerOptions,
            noEmit: true,
            skipLibCheck: true,
          }),
          scannedFiles,
        );
  const text =
    mode === "candidates"
      ? renderCandidateExterns({
          modules: options.modules,
          registry,
          scannedFiles,
        })
      : mode === "boundary-aware"
        ? renderBoundaryAwareExterns({
            appEntryFiles: resolveAnalysisEntryFiles({
              entryFiles: options.appEntryFiles ?? [],
              projectRoot,
              srcDir,
            }),
            compilerOptions,
            modules: options.modules,
            projectRoot,
            registry,
            scannedFiles,
          })
        : await renderRuntimeAwareExterns({
            appEntryFiles: resolveAnalysisEntryFiles({
              entryFiles: options.appEntryFiles ?? [],
              projectRoot,
              srcDir,
            }),
            compilerOptions,
            modules: options.modules,
            projectRoot,
            registry,
            runtimeEntryFiles: resolveAnalysisEntryFiles({
              entryFiles: options.runtimeEntryFiles ?? [],
              projectRoot,
              srcDir,
            }),
            scannedFiles,
          });

  const outputFile =
    options.outputFile && path.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.promises.writeFile(outputFile, text, "utf8");
  }

  return {
    mode,
    modules: [...options.modules],
    outputFile,
    scannedFiles,
    text,
  };
}

async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath,
}: {
  projectRoot: string;
  tsConfigPath?: string;
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  } satisfies ts.CompilerOptions;
  const resolvedConfigPath =
    tsConfigPath ?? path.join(projectRoot, "tsconfig.json");
  try {
    await fs.promises.access(resolvedConfigPath, fs.constants.R_OK);
    try {
      return await loadCompilerOptions(resolvedConfigPath, {
        allowJs: true,
        rootDir: projectRoot,
      });
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return fallbackOptions;
}

async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  specifier,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  specifier: string;
}) {
  const containingFile = path.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  const resolvedFromTypescript =
    resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }

  const require = ts.createModuleResolutionCache(
    projectRoot,
    (fileName) => fileName,
    compilerOptions,
  );
  const fallbackResolution = ts.nodeModuleNameResolver(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
    require,
  ).resolvedModule;
  const resolvedFromFallback =
    fallbackResolution &&
    normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }

  throw new Error(
    `Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`,
  );
}

async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  specifiers,
  tolerateMissing,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  specifiers: string[];
  tolerateMissing: boolean;
}) {
  const resolvedEntries: string[] = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(
        await resolveModuleTypeEntry({
          compilerOptions,
          projectRoot,
          specifier,
        }),
      );
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueStrings(resolvedEntries);
}

function createEmptyContractRegistry(): ContractRegistry {
  return {
    classContracts: new Map(),
    interfaceContracts: new Map(),
    scannedFiles: new Set(),
    typeAliasContracts: new Map(),
  };
}

function normalizeResolvedTypeFile(resolvedFileName: string) {
  const normalizedPath = path.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }

  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (ts.sys.fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}

function withTypeExtension(filePath: string, nextExtension: string) {
  if (
    filePath.endsWith(".d.ts") ||
    filePath.endsWith(".d.mts") ||
    filePath.endsWith(".d.cts")
  ) {
    return filePath;
  }

  const extension = path.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`;
}

async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies,
}: {
  compilerOptions: ts.CompilerOptions;
  entryFiles: string[];
  includeDependencies: boolean;
}) {
  const rootPackageDirs = new Set(
    entryFiles
      .map((filePath) => findPackageDir(filePath))
      .filter((packageDir): packageDir is string => packageDir !== null),
  );
  const queue = [...entryFiles];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const nextFile = queue.shift();
    if (!nextFile) {
      continue;
    }
    const resolvedFile = path.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);

    const sourceText = await fs.promises.readFile(resolvedFile, "utf8");
    const sourceFile = ts.createSourceFile(
      resolvedFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = ts.resolveModuleName(
        specifier,
        resolvedFile,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolvedModule) {
        continue;
      }

      const normalizedDependency = normalizeResolvedTypeFile(
        resolvedModule.resolvedFileName,
      );
      if (!normalizedDependency || isTypescriptLibFile(normalizedDependency)) {
        continue;
      }

      if (!includeDependencies) {
        const dependencyPackageDir = findPackageDir(normalizedDependency);
        if (
          dependencyPackageDir &&
          !rootPackageDirs.has(dependencyPackageDir)
        ) {
          continue;
        }
      }

      queue.push(normalizedDependency);
    }
  }

  return [...seen].sort((left, right) => left.localeCompare(right));
}

function collectReferencedSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) {
      specifiers.add(value);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function collectContracts(
  program: ts.Program,
  scannedFiles: string[],
): ContractRegistry {
  const checker = program.getTypeChecker();
  const scannedFileSet = new Set(
    scannedFiles.map((filePath) => path.resolve(filePath)),
  );
  const interfaceContracts = new Map<ts.Symbol, InterfaceContract>();
  const typeAliasContracts = new Map<ts.Symbol, TypeAliasContract>();
  const classContracts = new Map<ts.Symbol, ClassContract>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(path.resolve(sourceFile.fileName))) {
      continue;
    }

    for (const statement of sourceFile.statements) {
      if (
        ts.isInterfaceDeclaration(statement) &&
        isExportedDeclaration(statement)
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        interfaceContracts.set(symbol, {
          extends: getReferencedContractSymbols(
            statement.heritageClauses?.flatMap((clause) => clause.types) ?? [],
            checker,
            scannedFileSet,
          ),
          members: collectTypeElementMembers(statement.members),
          name: statement.name.text,
          symbol,
        });
        continue;
      }

      if (
        ts.isTypeAliasDeclaration(statement) &&
        isExportedDeclaration(statement)
      ) {
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
          symbol,
        });
        continue;
      }

      if (
        ts.isClassDeclaration(statement) &&
        statement.name &&
        isExportedDeclaration(statement)
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set<string>();
        const staticMembers = new Set<string>();
        for (const member of statement.members) {
          if (ts.isConstructorDeclaration(member)) {
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
          constructorParamContracts: collectConstructorParamContracts(
            statement,
            checker,
            scannedFileSet,
          ),
          instanceMembers,
          name: statement.name.text,
          staticMembers,
          symbol,
          usedImplementedContracts: getClassImplementedContracts(
            statement,
            checker,
            scannedFileSet,
          ),
        });
      }
    }
  }

  return {
    classContracts,
    interfaceContracts,
    scannedFiles: scannedFileSet,
    typeAliasContracts,
  };
}

function renderCandidateExterns({
  modules,
  registry,
  scannedFiles,
}: {
  modules: string[];
  registry: ContractRegistry;
  scannedFiles: string[];
}) {
  return renderExternText({
    emittedLines: collectCandidateExternLines(registry),
    mode: "candidates",
    modules,
    scannedFiles,
  });
}

function renderBoundaryAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  scannedFiles,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  modules: string[];
  projectRoot: string;
  registry: ContractRegistry;
  scannedFiles: string[];
}) {
  return renderExternText({
    emittedLines: collectBoundaryAwareExternLines({
      appEntryFiles,
      compilerOptions,
      projectRoot,
      registry,
    }),
    mode: "boundary-aware",
    modules,
    scannedFiles,
  });
}

async function renderRuntimeAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  runtimeEntryFiles,
  scannedFiles,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  modules: string[];
  projectRoot: string;
  registry: ContractRegistry;
  runtimeEntryFiles: string[];
  scannedFiles: string[];
}) {
  const emittedLines =
    appEntryFiles.length > 0
      ? collectBoundaryAwareExternLines({
          appEntryFiles,
          compilerOptions,
          projectRoot,
          registry,
        })
      : collectCandidateExternLines(registry);
  const runtimeMembers = await analyzeRuntimeUsage(runtimeEntryFiles);
  for (const member of runtimeMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }

  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles,
  });
}

function collectCandidateExternLines(registry: ContractRegistry) {
  const properties = new Set<string>();
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(
      contract.symbol,
      registry,
    )) {
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

  return new Set(
    [...properties]
      .sort((left, right) => left.localeCompare(right))
      .map((property) => renderStructuralExternLine(property)),
  );
}

function collectBoundaryAwareExternLines({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  registry: ContractRegistry;
}) {
  const usage = analyzeAppUsage({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry,
  });
  const emittedLines = new Set<string>();

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
      emittedLines.add(
        nominalTarget
          ? renderNominalInstanceExternLine(nominalTarget, member)
          : renderStructuralExternLine(member),
      );
    }
  }
  for (const [symbol, members] of usage.nominalStaticMembers) {
    const nominalTarget = resolveNominalStaticTarget(symbol, registry);
    for (const member of members) {
      emittedLines.add(
        nominalTarget
          ? renderNominalStaticExternLine(nominalTarget, member)
          : renderStructuralExternLine(member),
      );
    }
  }

  return emittedLines;
}

function renderExternText({
  emittedLines,
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles,
}: {
  emittedLines: Set<string>;
  mode: GenerateExternsMode;
  modules: string[];
  runtimeEntryFiles?: string[];
  scannedFiles: string[];
}) {
  const scannedSummary =
    mode === "runtime-aware"
      ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.`
      : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;

  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    "",
  ].join("\n");
}

function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir,
}: {
  entryFiles: string[];
  projectRoot: string;
  srcDir: string;
}) {
  return entryFiles.map((entry) => {
    if (path.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path.resolve(srcDir, entry);
    if (ts.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path.resolve(projectRoot, entry);
  });
}

async function analyzeRuntimeUsage(runtimeEntryFiles: string[]) {
  const structuralMembers = new Set<string>();

  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts.createSourceFile(
      runtimeEntryFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKindForFile(runtimeEntryFile),
    );
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ) {
            const memberName = getPropertyNameText(member.name);
            if (memberName && isRuntimeExternPropertyName(memberName)) {
              structuralMembers.add(memberName);
            }
          }
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        if (
          isThisOrSuperExpression(node.expression) &&
          isRuntimeExternPropertyName(node.name.text)
        ) {
          structuralMembers.add(node.name.text);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const memberName = getStringLiteralMemberName(node.argumentExpression);
        if (
          memberName &&
          isThisOrSuperExpression(node.expression) &&
          isRuntimeExternPropertyName(memberName)
        ) {
          structuralMembers.add(memberName);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        collectRuntimeAssignmentMembers(
          node.left,
          knownConstructors,
          structuralMembers,
        );
      } else if (ts.isCallExpression(node)) {
        collectRuntimeCallMembers(node, knownConstructors, structuralMembers);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return structuralMembers;
}

function collectKnownConstructorBindings(sourceFile: ts.SourceFile) {
  const knownConstructors = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name
    ) {
      knownConstructors.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isClassExpression(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        ts.isArrowFunction(node.initializer))
    ) {
      knownConstructors.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}

function collectRuntimeAssignmentMembers(
  target: ts.Expression,
  knownConstructors: Set<string>,
  structuralMembers: Set<string>,
) {
  if (ts.isPropertyAccessExpression(target)) {
    if (
      isThisOrSuperExpression(target.expression) ||
      isKnownPrototypeExpression(target.expression, knownConstructors) ||
      isKnownConstructorExpression(target.expression, knownConstructors)
    ) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        structuralMembers.add(target.name.text);
      }
    }
    return;
  }

  if (ts.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (
      memberName &&
      (isThisOrSuperExpression(target.expression) ||
        isKnownPrototypeExpression(target.expression, knownConstructors) ||
        isKnownConstructorExpression(target.expression, knownConstructors)) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      structuralMembers.add(memberName);
    }
  }
}

function collectRuntimeCallMembers(
  node: ts.CallExpression,
  knownConstructors: Set<string>,
  structuralMembers: Set<string>,
) {
  const callee = node.expression;
  if (
    ts.isIdentifier(callee) &&
    callee.text === "__publicField" &&
    node.arguments.length >= 2
  ) {
    const memberName = getStringLiteralMemberName(node.arguments[1]);
    if (
      memberName &&
      (isThisOrSuperExpression(node.arguments[0]) ||
        isKnownConstructorExpression(node.arguments[0], knownConstructors)) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      structuralMembers.add(memberName);
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
  if (
    isThisOrSuperExpression(target) ||
    isKnownConstructorExpression(target, knownConstructors) ||
    isKnownPrototypeExpression(target, knownConstructors)
  ) {
    structuralMembers.add(memberName);
  }
}

function analyzeAppUsage({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  registry: ContractRegistry;
}) {
  const program = ts.createProgram(appEntryFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const usage: UsageAnalysis = {
    nominalInstanceMembers: new Map(),
    nominalStaticMembers: new Map(),
    structuralContracts: new Set(),
    structuralMembers: new Set(),
  };
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) =>
      isProjectAppSourceFile(sourceFile.fileName, projectRoot),
    );

  for (const sourceFile of sourceFiles) {
    const importBindings = collectImportedClassBindings(sourceFile, registry);
    const localBindings = new Map<string, ts.Symbol>();
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child: ts.Node) => {
          if (ts.isNewExpression(child)) {
            analyzeNewExpression(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
            );
          } else if (ts.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
              fieldBindings,
            );
          } else if (
            ts.isElementAccessExpression(child) &&
            ts.isStringLiteral(child.argumentExpression)
          ) {
            analyzeElementAccess(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
              fieldBindings,
            );
          } else if (ts.isVariableDeclaration(child)) {
            registerVariableBinding(child, importBindings, localBindings);
          }
          ts.forEachChild(child, classVisit);
        };
        ts.forEachChild(node, classVisit);
        return;
      }

      if (ts.isVariableDeclaration(node)) {
        registerVariableBinding(node, importBindings, localBindings);
      } else if (ts.isNewExpression(node)) {
        analyzeNewExpression(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
        );
      } else if (ts.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
          new Map(),
        );
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        analyzeElementAccess(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
          new Map(),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return usage;
}

function analyzeNewExpression(
  node: ts.NewExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
) {
  const calleeSymbol =
    resolveBoundClassSymbol(
      node.expression,
      importBindings,
      localBindings,
      new Map(),
    ) ??
    resolveValueSymbol(node.expression, checker) ??
    resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
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
    contractSymbols,
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

function analyzePropertyAccess(
  node: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  const propertyName = node.name.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }

  if (
    ts.isIdentifier(node.expression) &&
    importBindings.has(node.expression.text)
  ) {
    const targetSymbol = importBindings.get(node.expression.text);
    if (targetSymbol) {
      const classContract = registry.classContracts.get(targetSymbol);
      if (classContract && classContract.staticMembers.has(propertyName)) {
        addMapSetValue(usage.nominalStaticMembers, targetSymbol, propertyName);
        return;
      }
    }
  }

  const boundInstanceSymbol = resolveBoundClassSymbol(
    node.expression,
    importBindings,
    localBindings,
    fieldBindings,
  );
  if (boundInstanceSymbol && registry.classContracts.has(boundInstanceSymbol)) {
    addMapSetValue(
      usage.nominalInstanceMembers,
      boundInstanceSymbol,
      propertyName,
    );
    return;
  }

  const typeSymbol = resolveTypeSymbol(
    checker.getTypeAtLocation(node.expression),
    checker,
  );
  if (!typeSymbol) {
    return;
  }

  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (
    registry.interfaceContracts.has(typeSymbol) ||
    registry.typeAliasContracts.has(typeSymbol)
  ) {
    usage.structuralMembers.add(propertyName);
  }
}

function analyzeElementAccess(
  node: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  const argumentExpression = node.argumentExpression;
  if (!ts.isStringLiteral(argumentExpression)) {
    return;
  }
  const propertyName = argumentExpression.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  const boundSymbol = resolveBoundClassSymbol(
    node.expression,
    importBindings,
    localBindings,
    fieldBindings,
  );
  if (boundSymbol && registry.classContracts.has(boundSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundSymbol, propertyName);
    return;
  }

  const typeSymbol = resolveTypeSymbol(
    checker.getTypeAtLocation(node.expression),
    checker,
  );
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (
    registry.interfaceContracts.has(typeSymbol) ||
    registry.typeAliasContracts.has(typeSymbol)
  ) {
    usage.structuralMembers.add(propertyName);
  }
}

function collectImportedClassBindings(
  sourceFile: ts.SourceFile,
  registry: ContractRegistry,
) {
  const bindings = new Map<string, ts.Symbol>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
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
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
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

function collectClassFieldBindings(
  declaration: ts.ClassDeclaration,
  importBindings: Map<string, ts.Symbol>,
) {
  const bindings = new Map<string, ts.Symbol>();
  for (const member of declaration.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.initializer ||
      !ts.isIdentifier(member.name) ||
      !ts.isNewExpression(member.initializer) ||
      !ts.isIdentifier(member.initializer.expression)
    ) {
      continue;
    }
    const classSymbol = importBindings.get(member.initializer.expression.text);
    if (classSymbol) {
      bindings.set(member.name.text, classSymbol);
    }
  }
  return bindings;
}

function registerVariableBinding(
  declaration: ts.VariableDeclaration,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
) {
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isNewExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression)
  ) {
    return;
  }
  const classSymbol = importBindings.get(
    declaration.initializer.expression.text,
  );
  if (classSymbol) {
    localBindings.set(declaration.name.text, classSymbol);
  }
}

function resolveBoundClassSymbol(
  expression: ts.Expression,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  if (ts.isIdentifier(expression)) {
    return (
      localBindings.get(expression.text) ??
      importBindings.get(expression.text) ??
      null
    );
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return fieldBindings.get(expression.name.text) ?? null;
  }

  return null;
}

function findClassContractByName(name: string, registry: ContractRegistry) {
  for (const [symbol, contract] of registry.classContracts) {
    if (contract.name === name) {
      return symbol;
    }
  }
  return null;
}

function collectStructuralContractMembers(
  symbol: ts.Symbol,
  registry: ContractRegistry,
  seen = new Set<ts.Symbol>(),
): Set<string> {
  if (seen.has(symbol)) {
    return new Set();
  }
  seen.add(symbol);

  const interfaceContract = registry.interfaceContracts.get(symbol);
  if (interfaceContract) {
    const members = new Set(interfaceContract.members);
    for (const extendedSymbol of interfaceContract.extends) {
      for (const member of collectStructuralContractMembers(
        extendedSymbol,
        registry,
        seen,
      )) {
        members.add(member);
      }
    }
    return members;
  }

  const typeAliasContract = registry.typeAliasContracts.get(symbol);
  if (typeAliasContract) {
    return new Set(typeAliasContract.members);
  }

  return new Set();
}

function collectTypeElementMembers(members: ts.NodeArray<ts.TypeElement>) {
  const collected = new Set<string>();
  for (const member of members) {
    if (
      ts.isPropertySignature(member) ||
      ts.isMethodSignature(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}

function collectAliasMembers(typeNode: ts.TypeNode): Set<string> {
  if (ts.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    const members = new Set<string>();
    for (const child of typeNode.types) {
      for (const member of collectAliasMembers(child)) {
        members.add(member);
      }
    }
    return members;
  }

  return new Set();
}

function getReferencedContractSymbols(
  typeNodes: readonly (ts.TypeNode | ts.ExpressionWithTypeArguments)[],
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
) {
  const symbols = new Set<ts.Symbol>();
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(
      typeNode,
      checker,
      scannedFiles,
    )) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

function getContractSymbolsFromTypeNode(
  typeNode: ts.TypeNode | ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
): Set<ts.Symbol> {
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(
      checker.getSymbolAtLocation(typeNode.expression),
      checker,
    );
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles)
      ? new Set<ts.Symbol>([symbol])
      : new Set<ts.Symbol>();
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    const symbols = new Set<ts.Symbol>();
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(
        child,
        checker,
        scannedFiles,
      )) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(
      typeNode.typeName,
      checker,
      scannedFiles,
    );
  }

  return new Set<ts.Symbol>();
}

function getContractSymbolsFromEntityName(
  entityName: ts.EntityName,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
): Set<ts.Symbol> {
  const symbol = ts.isIdentifier(entityName)
    ? checker.getSymbolAtLocation(entityName)
    : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set<ts.Symbol>();
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles)
    ? new Set<ts.Symbol>([resolved])
    : new Set<ts.Symbol>();
}

function collectConstructorParamContracts(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
) {
  const constructorDeclaration = statement.members.find((member) =>
    ts.isConstructorDeclaration(member),
  );
  if (
    !constructorDeclaration ||
    !ts.isConstructorDeclaration(constructorDeclaration)
  ) {
    return [];
  }

  return constructorDeclaration.parameters.map((parameter) =>
    parameter.type
      ? getContractSymbolsFromTypeNode(parameter.type, checker, scannedFiles)
      : new Set<ts.Symbol>(),
  );
}

function getClassImplementedContracts(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
  seen = new Set<string>(),
) {
  const contracts = new Set<ts.Symbol>();
  const classSymbol =
    statement.name && checker.getSymbolAtLocation(statement.name);
  const classKey = classSymbol ? symbolCacheKey(classSymbol) : "";
  if (classKey && seen.has(classKey)) {
    return contracts;
  }
  if (classKey) {
    seen.add(classKey);
  }

  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(
          typeNode,
          checker,
          scannedFiles,
        )) {
          contracts.add(symbol);
        }
      }
      continue;
    }

    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(
          checker.getSymbolAtLocation(typeNode.expression),
          checker,
        );
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) =>
          ts.isClassDeclaration(item),
        );
        if (declaration && ts.isClassDeclaration(declaration)) {
          for (const symbol of getClassImplementedContracts(
            declaration,
            checker,
            scannedFiles,
            seen,
          )) {
            contracts.add(symbol);
          }
        }
      }
    }
  }

  return contracts;
}

function isStructuralBoundaryArgument(expression: ts.Expression) {
  return !(
    ts.isArrayLiteralExpression(expression) ||
    ts.isObjectLiteralExpression(expression) ||
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  );
}

function resolveTypeSymbol(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Symbol | null {
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

function resolveValueSymbol(node: ts.Node, checker: ts.TypeChecker) {
  return resolveAliasedSymbol(checker.getSymbolAtLocation(node), checker);
}

function resolveAliasedSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
) {
  if (!symbol) {
    return null;
  }
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function resolveNominalInstanceTarget(
  symbol: ts.Symbol,
  registry: ContractRegistry,
) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}

function resolveNominalStaticTarget(
  symbol: ts.Symbol,
  registry: ContractRegistry,
) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}

function isAmbientGlobalSymbol(symbol: ts.Symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !ts.isExternalModule(sourceFile);
  });
}

function renderStructuralExternLine(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `Object.prototype.${name};`
    : `Object.prototype[${JSON.stringify(name)}];`;
}

function renderNominalInstanceExternLine(target: string, name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${target}.prototype.${name};`
    : `${target}.prototype[${JSON.stringify(name)}];`;
}

function renderNominalStaticExternLine(target: string, name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${target}.${name};`
    : `${target}[${JSON.stringify(name)}];`;
}

function addMapSetValue<K>(map: Map<K, Set<string>>, key: K, value: string) {
  const current = map.get(key);
  if (current) {
    current.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function isProjectAppSourceFile(filePath: string, projectRoot: string) {
  const resolvedFilePath = path.resolve(filePath);
  return (
    !resolvedFilePath.includes(`${path.sep}node_modules${path.sep}`) &&
    !resolvedFilePath.endsWith(".d.ts") &&
    resolvedFilePath.startsWith(path.resolve(projectRoot) + path.sep)
  );
}

function isExportedDeclaration(node: ts.Node) {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0
  );
}

function hasStaticModifier(node: ts.Node) {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Static) !==
    0
  );
}

function hasNonPublicModifier(node: ts.Node) {
  const modifierFlags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (
    (modifierFlags & ts.ModifierFlags.Private) !== 0 ||
    (modifierFlags & ts.ModifierFlags.Protected) !== 0
  );
}

function getPropertyNameText(name: ts.PropertyName | undefined) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function getStringLiteralMemberName(expression: ts.Expression | undefined) {
  if (!expression) {
    return null;
  }
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function isExternPropertyName(name: string) {
  return (
    name !== "prototype" &&
    name !== "constructor" &&
    !name.startsWith("#") &&
    !name.includes("@") &&
    !name.startsWith("_") &&
    !name.startsWith("$") &&
    !BUILTIN_CONTAINER_NAMES.has(name)
  );
}

function isRuntimeExternPropertyName(name: string) {
  return (
    name !== "prototype" &&
    name !== "constructor" &&
    !name.startsWith("#") &&
    !name.includes("@") &&
    !BUILTIN_CONTAINER_NAMES.has(name) &&
    !BUILTIN_RUNTIME_MEMBER_NAMES.has(name)
  );
}

function isThisOrSuperExpression(expression: ts.Node) {
  return (
    expression.kind === ts.SyntaxKind.ThisKeyword ||
    expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

function isKnownConstructorExpression(
  expression: ts.Expression,
  knownConstructors: Set<string>,
): boolean {
  return ts.isIdentifier(expression) && knownConstructors.has(expression.text);
}

function isKnownPrototypeExpression(
  expression: ts.Expression,
  knownConstructors: Set<string>,
) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "prototype" &&
    isKnownConstructorExpression(expression.expression, knownConstructors)
  );
}

function isObjectDefinePropertyCall(expression: ts.LeftHandSideExpression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Object" &&
    expression.name.text === "defineProperty"
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind) {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function getScriptKindForFile(filePath: string) {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".cts")
  ) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

function isScannedDeclarationSymbol(
  symbol: ts.Symbol,
  scannedFiles: Set<string>,
) {
  return (symbol.declarations ?? []).some((declaration) =>
    scannedFiles.has(path.resolve(declaration.getSourceFile().fileName)),
  );
}

function findPackageDir(filePath: string) {
  let currentDir = path.dirname(filePath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (ts.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function isTypeSourceFile(filePath: string) {
  return DECLARATION_EXTENSIONS.some((extension) =>
    filePath.endsWith(extension),
  );
}

function isTypescriptLibFile(filePath: string) {
  return filePath.includes(
    `${path.sep}node_modules${path.sep}typescript${path.sep}lib${path.sep}`,
  );
}

function symbolCacheKey(symbol: ts.Symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration
    ? `${path.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}`
    : symbol.getName();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecoverableExternConfigError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("TS18003") ||
      error.message.includes("No inputs were found in config file"))
  );
}
