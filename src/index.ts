import fs from "fs";
import path from "path";
import ts from "typescript";

import { runClosureCompiler } from "./compiler/closureCompiler";
import { customTransform as postCompile } from "./compiler/postCompiler";
import { customTransform as preCompile } from "./compiler/preCompiler";
import { toClosureJS } from "./compiler/tsickleCompiler";
import { loadSettingsFromArgs } from "./settings";
import * as tsickle from "./tsickle";
import {
  cleanDirectory,
  copyDirectoryRecursive,
  writeFileContent,
} from "./utils/fileOperations";
import { ensureDirectoryExistence } from "./utils/fileUtils";
import { loadTscConfig } from "./utils/tsConfigLoader";

const PRE_COMPILED_DIR = ".pre-compiled";

export async function main(args: string[]): Promise<number> {
  const { settings } = loadSettingsFromArgs(args);
  const cwd = process.cwd();

  const srcDir = path.join(cwd, settings.srcDir);
  const preCompiledDir = path.join(cwd, PRE_COMPILED_DIR);

  process.chdir(srcDir);

  cleanDirectory(preCompiledDir);
  ensureDirectoryExistence(preCompiledDir);
  copyDirectoryRecursive(srcDir, preCompiledDir);

  process.chdir(preCompiledDir);

  const config = loadTscConfig([]);

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
      "tsickle converts TypeScript modules to Closure modules via CommonJS internally. " +
        'Set tsconfig.json "module": "commonjs"',
    );
    return 1;
  }

  const closuredDir = path.join(cwd, "./.closured");
  cleanDirectory(closuredDir);

  await Promise.all(
    config.fileNames.map(async (file) => {
      const relativePath = path.relative(srcDir, file);
      const preCompiledPath = path.join(preCompiledDir, relativePath);
      const contents = fs.readFileSync(preCompiledPath, "utf-8");
      const transformed = await preCompile(
        contents,
        settings.entryPoint
          .replace(/\.js$/, ".ts")
          .endsWith(relativePath.split(PRE_COMPILED_DIR)[1]),
      );
      const closuredPath = path.join(closuredDir, relativePath);
      writeFileContent(closuredPath, transformed);
    }),
  );

  const result = toClosureJS(
    config.options,
    config.fileNames,
    settings,
    (filePath: string, contents: string) => {
      ensureDirectoryExistence(filePath);
      fs.writeFileSync(filePath, contents, "utf-8");
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

  const modulesExterns = path.join(
    cwd,
    "./.closure-externs/modules-externs.js",
  );
  ensureDirectoryExistence(modulesExterns);
  fs.writeFileSync(
    modulesExterns,
    tsickle.getGeneratedExterns(result.externs, config.options.rootDir || ""),
  );

  const closureExternsPath = path.join(__dirname, "../closure-externs");
  fs.readdirSync(closureExternsPath).forEach((file) => {
    const filePath = path.join(closureExternsPath, file);
    settings.externs.push(filePath);
  });

  settings.externs.push(
    path.join(cwd, "./.closure-externs/modules-externs.js"),
  );
  settings.js.push(path.join(__dirname, "../closure-lib/**.js"));
  settings.js.push(path.join(cwd, "./.closured/**.js"));

  const parentDir = path.dirname(settings.jsOutputFile);
  cleanDirectory(parentDir);
  ensureDirectoryExistence(parentDir);

  console.log("Building with Closure Compiler...");

  let exitCode = 0;

  try {
    exitCode = await runClosureCompiler(settings);
    if (exitCode === 0) {
      writeFileContent(
        settings.jsOutputFile,
        await postCompile(fs.readFileSync(settings.jsOutputFile, "utf-8")),
      );
    }
  } catch (error) {
    exitCode = 1;
    console.error(error);
  }

  if (exitCode !== 0) {
    console.error("Failed to build with Closure Compiler.");
  } else {
    console.log(
      "Build succeeded. You may remove the .closured and .closure-externs directories.",
    );
  }

  return exitCode;
}

main(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
});
