import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

import { runClosureCompiler } from "../compiler/closure-compiler";
import { customTransform as preCompile } from "../compiler/pre-compiler";
import { toClosureJS } from "../compiler/tsickle-compiler";
import {
  BuildOptions,
  parseCliArgs,
  normalizeBuildOptions,
  Settings,
} from "./options";
import * as tsickle from "../tsickle";
import {
  cleanupDirectories,
  copyDirectoryRecursive,
  writeFileContent,
} from "../utils/file-operations";
import { ensureDirectoryExistence } from "../utils/file-utils";
import { loadTscConfig } from "../utils/ts-config-loader";

const PRE_COMPILED_DIR = ".pre-compiled";
const CLOSURED_DIR = ".closured";
const CLOSURE_EXTERNS_DIR = ".closure-externs";

let bundledExternsCache: string[] | undefined;

export interface BuildResult {
  diagnostics: readonly ts.Diagnostic[];
  emitSkipped: boolean;
  exitCode: number;
  options: Settings;
  outputFiles: string[];
  workspaceDir: string;
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, "");
}

function getPackageRoot(): string {
  let currentDir = __dirname;
  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    const closureExternsPath = path.join(currentDir, "closure-externs");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(closureExternsPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Unable to resolve gcc-ts-bundler package root.");
    }
    currentDir = parentDir;
  }
}

async function getBundledExterns(packageRoot: string): Promise<string[]> {
  if (bundledExternsCache) {
    return bundledExternsCache;
  }

  const closureExternsPath = path.join(packageRoot, "closure-externs");
  const files = await fs.promises.readdir(closureExternsPath);
  bundledExternsCache = files.map((file) =>
    path.join(closureExternsPath, file),
  );

  return bundledExternsCache;
}

async function collectJavaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs = [dir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop()!;
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }

      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

async function processTsFiles(
  config: ts.ParsedCommandLine,
  srcDir: string,
  preCompiledDir: string,
  settings: Settings,
) {
  const entryPointRelativePaths = new Set(
    settings.entryPoints.map((entryPoint) =>
      stripExtension(path.relative(srcDir, entryPoint)),
    ),
  );

  await Promise.all(
    config.fileNames.map(async (file) => {
      const relativePath = path.relative(preCompiledDir, file);
      const preCompiledPath = path.join(preCompiledDir, relativePath);
      const contents = await fs.promises.readFile(preCompiledPath, "utf-8");
      const isEntryPoint = entryPointRelativePaths.has(
        stripExtension(relativePath),
      );
      const transformed = await preCompile(
        contents,
        preCompiledPath,
        isEntryPoint,
        preCompiledDir,
      );
      await writeFileContent(preCompiledPath, transformed);
    }),
  );
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const settings = normalizeBuildOptions(options);
  const packageRoot = getPackageRoot();
  const explicitWorkspaceDir = options.workspaceDir
    ? path.resolve(settings.cwd, options.workspaceDir)
    : undefined;
  const workspaceDir =
    explicitWorkspaceDir ??
    (await fs.promises.mkdtemp(path.join(os.tmpdir(), "gcc-ts-bundler-")));
  const preCompiledDir = path.join(workspaceDir, PRE_COMPILED_DIR);
  const closuredDir = path.join(workspaceDir, CLOSURED_DIR);
  const closureExternsDir = path.join(workspaceDir, CLOSURE_EXTERNS_DIR);
  const stagedEntryPoints = settings.entryPoints.map((entryPoint) =>
    path.join(
      closuredDir,
      path.relative(settings.srcDir, entryPoint).replace(/\.[^/.]+$/, ".js"),
    ),
  );

  try {
    await cleanupDirectories([preCompiledDir, closuredDir], false);
    await copyDirectoryRecursive(settings.srcDir, preCompiledDir);
    const config = await loadTscConfig({
      configSearchDir: settings.cwd,
      outDir: closuredDir,
      projectDir: preCompiledDir,
    });
    if (config.errors.length > 0) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(
          config.errors,
          ts.createCompilerHost(config.options),
        ),
      );
      return {
        diagnostics: config.errors,
        emitSkipped: true,
        exitCode: 1,
        options: settings,
        outputFiles: [],
        workspaceDir,
      };
    }
    if (config.options.module !== ts.ModuleKind.CommonJS) {
      console.error(
        'tsickle converts TypeScript modules to Closure modules via CommonJS internally. Set tsconfig.json "module": "commonjs"',
      );
      return {
        diagnostics: [],
        emitSkipped: true,
        exitCode: 1,
        options: settings,
        outputFiles: [],
        workspaceDir,
      };
    }
    await processTsFiles(config, settings.srcDir, preCompiledDir, settings);
    const result = await toClosureJS(
      config.options,
      config.fileNames,
      settings,
      (fileName, content) => {
        void writeFileContent(fileName, content);
      },
    );
    if (result.diagnostics.length > 0) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(
          result.diagnostics,
          ts.createCompilerHost(config.options),
        ),
      );
      return {
        diagnostics: result.diagnostics,
        emitSkipped: result.emitSkipped,
        exitCode: 1,
        options: settings,
        outputFiles: [],
        workspaceDir,
      };
    }
    const modulesExterns = path.join(closureExternsDir, "modules-externs.js");
    await ensureDirectoryExistence(modulesExterns);
    await fs.promises.mkdir(settings.outputDir, { recursive: true });
    await fs.promises.writeFile(
      modulesExterns,
      tsickle.getGeneratedExterns(result.externs, config.options.rootDir || ""),
    );
    const closureSettings: Settings = {
      ...settings,
      entryPoints: stagedEntryPoints,
      externs: [
        ...settings.externs,
        ...(await getBundledExterns(packageRoot)),
        modulesExterns,
      ],
      js: [
        ...settings.js,
        ...(await collectJavaScriptFiles(
          path.join(packageRoot, "closure-lib"),
        )),
        ...(await collectJavaScriptFiles(closuredDir)),
      ],
    };
    console.log("Building with Closure Compiler...");
    const exitCode = await runClosureCompiler(closureSettings);
    if (exitCode !== 0) {
      console.error("Failed to build with Closure Compiler.");
    } else {
      console.log("Build succeeded.");
    }
    return {
      diagnostics: result.diagnostics,
      emitSkipped: result.emitSkipped,
      exitCode,
      options: settings,
      outputFiles: settings.entryPoints.map((entryPoint) =>
        path.join(settings.outputDir, path.basename(entryPoint)),
      ),
      workspaceDir,
    };
  } catch (error) {
    console.error(error);
    return {
      diagnostics: [],
      emitSkipped: true,
      exitCode: 1,
      options: settings,
      outputFiles: [],
      workspaceDir,
    };
  } finally {
    if (settings.preserveCache) {
      console.log(`Preserved gcc-ts-bundler workspace at ${workspaceDir}`);
    } else if (explicitWorkspaceDir) {
      await cleanupDirectories(
        [preCompiledDir, closureExternsDir, closuredDir],
        true,
      );
    } else {
      await fs.promises.rm(workspaceDir, { force: true, recursive: true });
    }
  }
}

export async function runCli(args: string[]): Promise<number> {
  const { options, showHelp } = parseCliArgs(args);
  if (showHelp) {
    return 0;
  }

  const result = await build(options);
  return result.exitCode;
}

export async function main(args: string[]): Promise<number> {
  return runCli(args);
}

if (typeof require === "function" && typeof module !== "undefined") {
  if (require.main === module) {
    void runCli(process.argv.slice(2)).then((exitCode) =>
      process.exit(exitCode),
    );
  }
}
