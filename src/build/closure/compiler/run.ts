import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import { isDriverForcedOff } from "../driver/probe";
import { runResidentClosureJob } from "../driver/resident";
import type { ClosureCompilerOptions } from "./environment-resolve";

type ClosureCompilerInstance = InstanceType<
  typeof closureCompilerPackage.compiler
>;

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

/**
 * `onStderr` observes the diagnostics without changing how they are reported.
 * The platform-extern slice needs to tell "the slice was incomplete" (retry
 * with the full browser externs) apart from "the program is broken" (report
 * it), and the exit code alone cannot: both are non-zero.
 */
export async function runClosureCompiler(
  options: ClosureCompilerOptions,
  onStderr?: (stdErr: string) => void,
): Promise<number> {
  if (!isDriverForcedOff()) {
    const resident = await runResidentClosureJob(
      closureCompilerCliArgs(options),
    );
    if (resident) {
      reportClosureCompilerOutput(resident.stdout, resident.stderr, onStderr);
      return resident.exitCode;
    }
  }

  return spawnClosureCompiler(options, onStderr);
}

function closureCompilerCliArgs(options: ClosureCompilerOptions) {
  const instance = new closureCompilerPackage.compiler(options) as unknown as {
    commandArguments: string[];
  };
  return [...instance.commandArguments];
}
function spawnClosureCompiler(
  options: ClosureCompilerOptions,
  onStderr?: (stdErr: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(
      new closureCompilerPackage.compiler(options),
    );
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      reportClosureCompilerOutput(stdOut, stdErr, onStderr);
      resolve(exitCode);
    });
  });
}

function reportClosureCompilerOutput(
  stdOut: string,
  stdErr: string,
  onStderr?: (stdErr: string) => void,
) {
  if (stdOut) {
    console.log(stdOut);
  }
  if (stdErr) {
    onStderr?.(stdErr);
    console.error(annotateClosureDiagnostics(stdErr));
  }
}

export function resolveClosureCompilerVersionTag() {
  return resolveClosureCompilerJarPath() ?? getNativeImagePath() ?? "native";
}

function resolveClosureCompilerJarPath(): string | undefined {
  const jarPath = closureCompilerPackage.compiler.JAR_PATH;
  return typeof jarPath === "string" ? jarPath : undefined;
}

function configureClosureCompilerInstance(
  instance: ClosureCompilerInstance,
): ClosureCompilerInstance {
  const nativeImagePath = getNativeImagePath();
  if (nativeImagePath) {
    Object.assign(instance, {
      JAR_PATH: null,
      javaPath: nativeImagePath,
    });
    return instance;
  }

  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    Object.assign(instance, { JAR_PATH: jarPath });
  }
  return instance;
}
