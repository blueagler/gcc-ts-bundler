import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { filesExist } from "../../internal/file-state";
import { collectFileStates } from "../../native/load";
import { NormalizedBuildOptions, PackageAlias } from "../../internal/types";
import { transpileSources } from "../../native/load";

export interface NativeEmitStageResult {
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
  supportFiles: string[];
}

interface NativeEmitMetadata {
  emittedFiles: string[];
  externsPath: string;
  supportFiles: string[];
}

export async function emitNativeStage({
  cacheDir,
  fileNames,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  fileNames: string[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readMetadata(metadataPath);
  if (
    cachedMetadata &&
    (await filesExist([
      cachedMetadata.externsPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
    ]))
  ) {
    return {
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles,
    };
  }

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const diagnostics = getPreflightDiagnostics({
    fileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir,
  });
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }

  const result = transpileSources({
    externsPath,
    fileNames,
    outDir,
    workspaceDir,
  });
  const supportFiles = await emitPackageSupportFiles({
    outDir,
    packageAliases,
    packageJsonFiles,
    workspaceDir,
  });

  await fs.promises.writeFile(
    metadataPath,
    JSON.stringify(
      {
        emittedFiles: result.emittedFiles,
        externsPath: result.externsPath,
        supportFiles,
      } satisfies NativeEmitMetadata,
      null,
      2,
    ),
    "utf-8",
  );

  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles,
  };
}

function getPreflightDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
  workspaceDir: string;
}): ts.Diagnostic[] {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates
    .filter((state) => !state.exists)
    .map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(
        `Missing required build input(s): ${missingFiles.join(", ")}`,
      ),
    ];
  }

  if (preflight !== "full") {
    return [];
  }

  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const finalCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };

  const compilerHost = ts.createCompilerHost(finalCompilerOptions);
  const program = ts.createProgram(
    fileNames,
    finalCompilerOptions,
    compilerHost,
  );
  return [...ts.getPreEmitDiagnostics(program)].filter(
    (diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic),
  );
}

function loadCompilerOptions(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsedConfig.errors,
        ts.createCompilerHost({}),
      ),
    );
  }

  return parsedConfig.options;
}

function createSimpleDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined,
  };
}

function shouldIgnorePreflightDiagnostic(diagnostic: ts.Diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }

  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
}

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NativeEmitMetadata>;
    return {
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function emitPackageSupportFiles({
  outDir,
  packageAliases,
  packageJsonFiles,
  workspaceDir,
}: {
  outDir: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  workspaceDir: string;
}) {
  const supportFiles: string[] = [];
  const rootPackageNames = new Set(
    packageAliases
      .filter((alias) => alias.subpath === ".")
      .map((alias) => alias.packageName),
  );

  for (const packageJsonFile of packageJsonFiles) {
    const packageDir = path.dirname(packageJsonFile);
    const packageName = path.relative(
      path.join(workspaceDir, "node_modules"),
      packageDir,
    );
    if (rootPackageNames.has(packageName)) {
      continue;
    }

    const outputPath = path.join(
      outDir,
      path.relative(workspaceDir, packageJsonFile),
    );
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.copyFile(packageJsonFile, outputPath);
    supportFiles.push(outputPath);
  }

  for (const alias of packageAliases) {
    const targetPath = toEmittedPath(alias.targetPath, outDir, workspaceDir);
    const packageDir = path.join(outDir, "node_modules", alias.packageName);

    if (alias.subpath === ".") {
      const entryFile = path.join(packageDir, "__gcc_entry__.js");
      const packageJsonOutput = path.join(packageDir, "package.json");
      await fs.promises.mkdir(packageDir, { recursive: true });
      await fs.promises.writeFile(
        entryFile,
        createReexportModule(entryFile, targetPath),
        "utf8",
      );
      await fs.promises.writeFile(
        packageJsonOutput,
        JSON.stringify(
          {
            browser: "./__gcc_entry__.js",
            main: "./__gcc_entry__.js",
            module: "./__gcc_entry__.js",
            name: alias.packageName,
          },
          null,
          2,
        ),
        "utf8",
      );
      supportFiles.push(entryFile, packageJsonOutput);
      continue;
    }

    const aliasFile = toAliasFilePath(packageDir, alias.subpath);
    if (aliasFile === targetPath) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(aliasFile), { recursive: true });
    await fs.promises.writeFile(
      aliasFile,
      createReexportModule(aliasFile, targetPath),
      "utf8",
    );
    supportFiles.push(aliasFile);
  }

  return [...new Set(supportFiles)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function createReexportModule(fromPath: string, targetPath: string) {
  const relativePath = toImportPath(path.relative(path.dirname(fromPath), targetPath));
  return [
    `import * as __module from ${JSON.stringify(relativePath)};`,
    `export * from ${JSON.stringify(relativePath)};`,
    "export default __module.default;",
    "",
  ].join("\n");
}

function toAliasFilePath(packageDir: string, subpath: string) {
  const relativeSubpath = subpath.replace(/^\.\//, "");
  return path.extname(relativeSubpath)
    ? path.join(packageDir, relativeSubpath)
    : path.join(packageDir, `${relativeSubpath}.js`);
}

function toEmittedPath(sourcePath: string, outDir: string, workspaceDir: string) {
  return path
    .join(outDir, path.relative(workspaceDir, sourcePath))
    .replace(/\.[^/.]+$/, ".js");
}

function toImportPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
