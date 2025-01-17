import fs from "fs";
import path from "path";
import ts from "typescript";

import { runClosureCompiler } from "./compiler/closureCompiler";
import { customTransform as preCompile } from "./compiler/preCompiler";
import { toClosureJS } from "./compiler/tsickleCompiler";
import { loadSettingsFromArgs } from "./settings";
import * as tsickle from "./tsickle";
import {
  cleanupDirectories,
  copyDirectoryRecursive,
  writeFileContent,
} from "./utils/fileOperations";
import { ensureDirectoryExistence } from "./utils/fileUtils";
import { loadTscConfig } from "./utils/tsConfigLoader";

const PRE_COMPILED_DIR = ".pre-compiled";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function processTsFiles(
  config: ts.ParsedCommandLine,
  srcDir: string,
  preCompiledDir: string,
  closuredDir: string,
  settings: { entryPoints: string[] },
) {
  await Promise.all(
    config.fileNames.map(async (file) => {
      const relativePath = path.relative(srcDir, file);
      const preCompiledPath = path.join(preCompiledDir, relativePath);
      const contents = await fs.promises.readFile(preCompiledPath, "utf-8");
      const isEntryPoint = settings.entryPoints.some((entryPoint: string) =>
        entryPoint
          .replace(/\.[^/.]+$/, "")
          .endsWith(
            relativePath.split(PRE_COMPILED_DIR)[1].replace(/\.[^/.]+$/, ""),
          ),
      );
      const transformed = await preCompile(
        contents,
        preCompiledPath,
        isEntryPoint,
      );
      const closuredPath = path.join(closuredDir, relativePath);
      await writeFileContent(closuredPath, transformed);
    }),
  );
}

export async function main(args: string[]): Promise<number> {
  const { settings } = loadSettingsFromArgs(args);
  const cwd = process.cwd();
  const srcDir = path.join(cwd, settings.srcDir);
  const preCompiledDir = path.join(cwd, PRE_COMPILED_DIR);
  const closuredDir = path.join(cwd, "./.closured");
  const closureExternsDir = path.join(cwd, "./.closure-externs");
  try {
    process.chdir(srcDir);
    await cleanupDirectories([preCompiledDir, closuredDir], false);
    await ensureDirectoryExistence(preCompiledDir);
    await copyDirectoryRecursive(srcDir, preCompiledDir);
    process.chdir(preCompiledDir);
    const config = await loadTscConfig([]);
    if (config.errors.length > 0) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(
          config.errors,
          ts.createCompilerHost(config.options),
        ),
      );
      return 1;
    }
    if (config.options.module !== ts.ModuleKind.CommonJS) {
      console.error(
        'tsickle converts TypeScript modules to Closure modules via CommonJS internally. Set tsconfig.json "module": "commonjs"',
      );
      return 1;
    }
    await processTsFiles(config, srcDir, preCompiledDir, closuredDir, settings);
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
      return 1;
    }
    const modulesExterns = path.join(closureExternsDir, "modules-externs.js");
    await ensureDirectoryExistence(modulesExterns);
    await fs.promises.writeFile(
      modulesExterns,
      tsickle.getGeneratedExterns(result.externs, config.options.rootDir || ""),
    );
    const closureExternsPath = path.join(__dirname, "../closure-externs");
    settings.externs.push(
      ...fs
        .readdirSync(closureExternsPath)
        .map((file) => path.join(closureExternsPath, file)),
    );
    settings.externs.push(modulesExterns);
    settings.js.push(
      path.join(__dirname, "../closure-lib/**.js"),
      path.join(closuredDir, "**.js"),
    );
    console.log("Building with Closure Compiler...");
    const exitCode = await runClosureCompiler(settings);
    if (exitCode !== 0) {
      console.error("Failed to build with Closure Compiler.");
    } else {
      console.log("Build succeeded.");
    }
    return exitCode;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    if (!settings.preserveCache) {
      await cleanupDirectories(
        [preCompiledDir, closureExternsDir, closuredDir],
        true,
      );
    }
  }
}
void main(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
