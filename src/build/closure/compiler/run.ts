import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import {
  isDriverForcedOff,
  resolveClosureCompilerJarPath,
} from "../driver/probe";
import {
  runResidentClosureJob,
  type ResidentJobResult,
} from "../driver/resident";
import type { ClosureCompilerOptions } from "./environment-resolve";

type ClosureCompilerInstance = InstanceType<
  typeof closureCompilerPackage.compiler
> & { commandArguments: string[] };

/**
 * Closure reports a cross-chunk write under ES_MODULES as `JSC_IMPORT_ASSIGN`
 * pointing at the *definition* site, which says nothing about what to do. The
 * cause is always the same: ESM import bindings are immutable in the importing
 * module, so a chunk writing to a name another chunk owns is a hard error --
 * and `CrossChunkCodeMotion` can create the situation from input that had no
 * cross-chunk assignment (google/closure-compiler#4264).
 */
function annotateClosureDiagnostics(stdErr: string) {
  if (!stdErr.includes("JSC_IMPORT_ASSIGN")) {
    return stdErr;
  }
  return (
    `${stdErr}\n` +
    "gcc-ts-bundler: JSC_IMPORT_ASSIGN means one chunk writes to a top-level " +
    "binding that another chunk owns. ES module imports are immutable, so " +
    'chunks.outputType "esm" cannot express shared mutable cross-chunk state. ' +
    'Either move that state behind an accessor in the chunk that owns it, or set chunks.outputType: "script" to go back to GLOBAL_NAMESPACE output.\n'
  );
}

/** Return output to the job owner so discarded retries are never reported. */
export async function runClosureCompiler(options: ClosureCompilerOptions) {
  // The adapter exposes normalized argv, but the package typings omit it.
  const instance = new closureCompilerPackage.compiler(
    options,
  ) as ClosureCompilerInstance;
  const resident = isDriverForcedOff()
    ? undefined
    : await runResidentClosureJob(instance.commandArguments);
  const result = resident ?? (await spawnClosureCompiler(instance));
  return {
    ...result,
    diagnostics: [
      result.stdout,
      annotateClosureDiagnostics(result.stderr),
    ].filter(Boolean),
  };
}

function spawnClosureCompiler(
  instance: ClosureCompilerInstance,
): Promise<ResidentJobResult> {
  const { promise, resolve } = Promise.withResolvers<ResidentJobResult>();
  const nativeImagePath = getNativeImagePath();
  if (nativeImagePath) {
    Object.assign(instance, {
      JAR_PATH: null,
      javaPath: nativeImagePath,
    });
  }
  let result: ResidentJobResult | undefined;
  const child = instance.run((exitCode, stdout, stderr) => {
    // The package can call back on both error and close. Keep the first
    // outcome, but retain ownership until the process and its streams close.
    result ??= { exitCode, stdout, stderr };
  });
  child.once("close", (code) => {
    resolve(result ?? { exitCode: code ?? 1, stdout: "", stderr: "" });
  });
  return promise;
}

export function resolveClosureCompilerVersionTag() {
  return resolveClosureCompilerJarPath() ?? getNativeImagePath() ?? "native";
}
