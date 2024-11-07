import { compiler } from "google-closure-compiler";

import { Settings } from "../settings";

const NAMESPACE_VARIABLE = "$";

export async function runClosureCompiler(settings: Settings): Promise<number> {
  const closureCompiler = new compiler({
    assumeFunctionWrapper: true,
    compilationLevel: settings.compilationLevel,
    dependencyMode: "PRUNE",
    entryPoint: settings.entryPoint,
    externs: settings.externs,
    js: settings.js,
    jsOutputFile: settings.jsOutputFile,
    languageIn: "UNSTABLE",
    languageOut: settings.languageOut,
    renamePrefixNamespace: NAMESPACE_VARIABLE,
    rewritePolyfills: true,
    warningLevel: settings.verbose ? "VERBOSE" : "DEFAULT",
  });

  return new Promise((resolve) => {
    closureCompiler.run((exitCode, stdOut, stdErr) => {
      if (stdErr) {
        console.error(stdErr);
      }
      if (stdOut) {
        console.log(stdOut);
      }
      resolve(exitCode);
    });
  });
}
