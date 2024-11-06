import { spawnSync } from "child_process";

import { Settings } from "../settings";

export function runClosureCompiler(settings: Settings): number {
  const closureCompilerArgs = [
    "--entry_point",
    settings.entryPoint,
    "--js_output_file",
    settings.jsOutputFile,
    "--language_in",
    "UNSTABLE",
    "--language_out",
    settings.languageOut,
    "--compilation_level",
    settings.compilationLevel,
    ...settings.externs.flatMap((externFile) => ["--externs", externFile]),
    ...settings.js.flatMap((jsFile) => ["--js", jsFile]),
    "--assume_function_wrapper",
    "--warning_level",
    settings.verbose ? "VERBOSE" : "DEFAULT",
  ];

  const ccProcess = spawnSync("google-closure-compiler", closureCompilerArgs);

  if (ccProcess.stderr.length > 0) {
    console.error(ccProcess.stderr.toString());
  }

  if (ccProcess.stdout.length > 0) {
    console.log(ccProcess.stdout.toString());
  }

  return ccProcess.status || 0;
}
