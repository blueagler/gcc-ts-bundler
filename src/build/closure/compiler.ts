import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

export type ClosureCompilerOption = string | boolean;
export type ClosureCompilerOptions = Record<
  string,
  ClosureCompilerOption | ClosureCompilerOption[]
>;

type ClosureCompilerInstance = InstanceType<
  typeof closureCompilerPackage.compiler
>;

function applyInternalClosureDebugOptions(
  closureOptions: ClosureCompilerOptions,
) {
  if (process.env["GCC_CLOSURE_DEBUG"] === "1") {
    closureOptions["debug"] = true;
    closureOptions["formatting"] = "PRETTY_PRINT";
  }
  // Space-separated `--flag[=value]` pairs appended verbatim, for measuring
  // candidate Closure flags without a rebuild (see docs/development.md).
  const extraFlags = process.env["GCC_CLOSURE_EXTRA_FLAGS"];
  if (extraFlags) {
    for (const flag of extraFlags.split(/\s+/u)) {
      if (!flag.startsWith("--")) {
        continue;
      }
      const separator = flag.indexOf("=");
      if (separator === -1) {
        closureOptions[flag.slice(2)] = true;
      } else {
        closureOptions[flag.slice(2, separator)] = flag.slice(separator + 1);
      }
    }
  }
}

/**
 * Whether a job should run Closure's type inference *silently*.
 *
 * `--warning_level QUIET` disables the `checkTypes` pass outright, so every
 * type-based optimization pass has been running on an empty type graph and
 * `--use_types_for_optimization` has measured nothing (see the Addendum in
 * docs/research/typed-input.md). `--jscomp_warning=checkTypes` restores the
 * pass and `--hide_warnings_for=/` suppresses every diagnostic it would
 * emit, because inference over third-party bundles produces noise that is
 * never the user's to fix. Measured on a real chunk job with untyped input:
 * -38 B gzip, +183 ms.
 *
 * Restricted to bundler-runtime ADVANCED: that is the only combination whose
 * input carries the typed annotations this exists to feed and that runs the
 * passes consuming them. `GCC_DISABLE_TYPE_INFERENCE=1` is the escape hatch
 * for bisecting a suspected inference-induced break.
 */
export function shouldEnableTypeInference(
  chunkMode: string,
  compilationLevel: string,
) {
  return (
    chunkMode === "bundler-runtime" &&
    compilationLevel === "ADVANCED" &&
    process.env["GCC_DISABLE_TYPE_INFERENCE"] !== "1"
  );
}

/** Wrapper camelCase for `--jscomp_warning=checkTypes --hide_warnings_for=/`. */
export const TYPE_INFERENCE_OPTIONS: ClosureCompilerOptions = {
  hideWarningsFor: ["/"],
  jscompWarning: ["checkTypes"],
};

export function configureClosureCompilerOptions(
  closureOptions: ClosureCompilerOptions,
) {
  applyInternalClosureDebugOptions(closureOptions);
}

/**
 * Closure reports a cross-chunk write under ES_MODULES as `JSC_IMPORT_ASSIGN`
 * pointing at the *definition* site, which says nothing about what to do. The
 * cause is always the same: ESM import bindings are immutable in the importing
 * module, so a chunk writing to a name another chunk owns is a hard error --
 * and `CrossChunkCodeMotion` can create the situation from input that had no
 * cross-chunk assignment (google/closure-compiler#4264).
 */
export function annotateClosureDiagnostics(stdErr: string) {
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

export async function runClosureCompiler(
  options: ClosureCompilerOptions,
): Promise<number> {
  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(
      new closureCompilerPackage.compiler(options),
    );
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      if (stdOut) {
        console.log(stdOut);
      }
      if (stdErr) {
        console.error(annotateClosureDiagnostics(stdErr));
      }
      resolve(exitCode);
    });
  });
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
