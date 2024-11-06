import fs from "fs";
import path from "path";
import * as tsickle from "tsickle";
import ts from "typescript";

import { runClosureCompiler } from "./compiler/closureCompiler";
import { toClosureJS } from "./compiler/tsickleCompiler";
import { loadSettingsFromArgs } from "./settings";
import { ensureDirectoryExistence } from "./utils/fileUtils";
import { loadTscConfig } from "./utils/tsConfigLoader";

export function main(args: string[]): number {
  const { settings } = loadSettingsFromArgs(args);
  const cwd = process.cwd();
  process.chdir(settings.srcDir);
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
  if (fs.existsSync(closuredDir)) {
    fs.readdirSync(closuredDir).forEach((file) => {
      const filePath = path.join(closuredDir, file);
      fs.unlinkSync(filePath);
    });
  }

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

  const closureLibPath = path.join(__dirname, "../closure-lib");
  fs.readdirSync(closureLibPath).forEach((file) => {
    const filePath = path.join(closureLibPath, file);
    settings.js.push(filePath);
  });
  const closureExternsPath = path.join(__dirname, "../closure-externs");
  fs.readdirSync(closureExternsPath).forEach((file) => {
    const filePath = path.join(closureExternsPath, file);
    settings.externs.push(filePath);
  });

  settings.js.push(path.join(cwd, "./.closured/**.js"));
  settings.externs.push(
    path.join(cwd, "./.closure-externs/modules-externs.js"),
  );

  const parentDir = path.dirname(settings.jsOutputFile);
  if (fs.existsSync(parentDir)) {
    fs.readdirSync(parentDir).forEach((file) => {
      const filePath = path.join(parentDir, file);
      fs.unlinkSync(filePath);
    });
  }

  const exitCode = runClosureCompiler(settings);

  if (exitCode !== 0) {
    console.error("Failed to build with Closure Compiler.");
  } else {
    console.log(
      "Build succeeded. You may remove the .closured and .closure-externs directories.",
    );
  }

  return exitCode;
}

process.exit(main(process.argv.slice(2)));
