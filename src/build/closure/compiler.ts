import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import { isDriverForcedOff, runResidentClosureJob } from "./driver";


export type ClosureCompilerOption = string | boolean;
export type ClosureCompilerOptions = Record<
  string,
  ClosureCompilerOption | ClosureCompilerOption[]
>;

type ClosureCompilerInstance = InstanceType<
  typeof closureCompilerPackage.compiler
>;

const MANAGED_CLOSURE_FLAGS = new Set(
  [
    "assumeFunctionWrapper",
    "chunk",
    "chunkOutputPathPrefix",
    "chunkOutputType",
    "compilationLevel",
    "dependencyMode",
    "entryPoint",
    "env",
    "externs",
    "js",
    "jsOutputFile",
    "languageIn",
    "languageOut",
    "propertyMapInputFile",
    "propertyRenamingReport",
    "renamePrefixNamespace",
    "rewritePolyfills",
    "variableMapInputFile",
    "variableRenamingReport",
    "warningLevel",
  ].map(normalizeClosureFlagName),
);

export interface ClosureCompilerEnvironment {
  options: ClosureCompilerOptions;
  typeInferenceDisabled: boolean;
}

export function resolveClosureCompilerEnvironment(): ClosureCompilerEnvironment {
  const options: ClosureCompilerOptions = {};
  if (process.env["GCC_CLOSURE_DEBUG"] === "1") {
    options["debug"] = true;
    options["formatting"] = "PRETTY_PRINT";
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
      const name = flag.slice(2, separator === -1 ? undefined : separator);
      if (MANAGED_CLOSURE_FLAGS.has(normalizeClosureFlagName(name))) {
        throw new TypeError(
          `GCC_CLOSURE_EXTRA_FLAGS may not override managed Closure flag --${name}.`,
        );
      }
      const value = separator === -1 ? true : flag.slice(separator + 1);
      const previous = options[name];
      options[name] =
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [previous, value];
    }
  }

  return {
    options,
    typeInferenceDisabled: process.env["GCC_DISABLE_TYPE_INFERENCE"] === "1",
  };
}

function normalizeClosureFlagName(name: string) {
  return name.replace(/[-_]/gu, "").toLowerCase();
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
 * Restricted to ADVANCED jobs whose native inputs actually delivered type
 * metadata. `GCC_DISABLE_TYPE_INFERENCE=1` is the escape hatch for bisecting
 * a suspected inference-induced break.
 */
export function shouldEnableTypeInference(
  compilationLevel: string,
  hasTypeMetadata: boolean,
  typeInferenceDisabled = process.env["GCC_DISABLE_TYPE_INFERENCE"] === "1",
) {
  return (
    compilationLevel === "ADVANCED" && hasTypeMetadata && !typeInferenceDisabled
  );
}

/** Wrapper camelCase for `--jscomp_warning=checkTypes --hide_warnings_for=/`. */
export const TYPE_INFERENCE_OPTIONS: ClosureCompilerOptions = {
  hideWarningsFor: ["/"],
  jscompWarning: ["checkTypes"],
};

const TYPE_INFERENCE_JSCOMP_WARNING = [
  "checkTypes",
] as const satisfies readonly string[];

function hasHideWarningsFor(
  value: ClosureCompilerOption | ClosureCompilerOption[] | undefined,
): value is ClosureCompilerOption | ClosureCompilerOption[] {
  if (Array.isArray(value)) {
    return value.some((entry) => entry !== false && entry !== "");
  }
  return value !== undefined && value !== false && value !== "";
}

/**
 * Restore `checkTypes` under QUIET. `--hide_warnings_for=/` is the default
 * suppress; an explicit empty hide list (`hideWarningsFor: []`) keeps the
 * warning on and reports diagnostics.
 */
export function applyTypeInferenceOptions(
  closureOptions: ClosureCompilerOptions,
  environmentOptions: ClosureCompilerOptions,
): void {
  const hideWarningsFor = Object.hasOwn(environmentOptions, "hideWarningsFor")
    ? environmentOptions.hideWarningsFor
    : TYPE_INFERENCE_OPTIONS.hideWarningsFor;
  closureOptions.jscompWarning = [...TYPE_INFERENCE_JSCOMP_WARNING];
  if (hasHideWarningsFor(hideWarningsFor)) {
    closureOptions.hideWarningsFor = hideWarningsFor;
  }
}

/** Drop an empty hide list so Closure does not receive `--hide_warnings_for`. */
export function omitEmptyHideWarningsFor(
  closureOptions: ClosureCompilerOptions,
): void {
  if (!hasHideWarningsFor(closureOptions.hideWarningsFor)) {
    delete closureOptions.hideWarningsFor;
  }
}

export function withExplicitHideWarningsFor(
  environment: ClosureCompilerEnvironment,
  hideWarningsFor: readonly string[] | undefined,
): ClosureCompilerEnvironment {
  if (hideWarningsFor === undefined) {
    return environment;
  }
  return {
    ...environment,
    options: {
      ...environment.options,
      hideWarningsFor: [...hideWarningsFor],
    },
  };
}

export function hasStrictCheckTypes(options: ClosureCompilerOptions) {
  return Object.entries(options).some(
    ([name, value]) =>
      normalizeClosureFlagName(name) === "jscomperror" &&
      (Array.isArray(value) ? value : [value]).includes("checkTypes"),
  );
}

export function configureClosureCompilerOptions(
  closureOptions: ClosureCompilerOptions,
  environmentOptions = resolveClosureCompilerEnvironment().options,
) {
  Object.assign(closureOptions, environmentOptions);
}

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
