import { spawnSync } from "child_process";

import { Settings } from "../settings";

export function runClosureCompiler(settings: Settings): number {
  const closureCompilerArgs = [
    ...settings.js.flatMap((jsFile) => ["--js", jsFile]),
    ...settings.externs.flatMap((externFile) => ["--externs", externFile]),
    "--compilation_level",
    settings.compilationLevel,
    "--js_output_file",
    settings.jsOutputFile,
    "--language_out",
    settings.languageOut,
    "--entry_point",
    settings.entryPoint,
    "--assume_function_wrapper",
    "--warning_level",
    settings.verbose ? "VERBOSE" : "DEFAULT",
    "--language_in",
    "UNSTABLE",
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
