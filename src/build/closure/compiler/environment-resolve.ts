import os from "os";

export type ClosureCompilerOption = string | boolean;
export type ClosureCompilerOptions = Record<
  string,
  ClosureCompilerOption | ClosureCompilerOption[]
>;

export interface ClosureCompilerEnvironment {
  options: ClosureCompilerOptions;
  typeInferenceDisabled: boolean;
}

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

export function resolveClosureCompilerEnvironment(): ClosureCompilerEnvironment {
  const options: ClosureCompilerOptions = {};
  options["numParallelThreads"] = String(
    Math.min(4, os.availableParallelism()),
  );
  if (process.env["GCC_CLOSURE_DEBUG"] === "1") {
    options["debug"] = true;
    options["formatting"] = "PRETTY_PRINT";
  }

  // Space-separated `--flag[=value]` pairs for measuring candidate Closure
  // flags without a rebuild (see docs/development/workflows.md).
  const extraFlags = process.env["GCC_CLOSURE_EXTRA_FLAGS"];
  if (extraFlags) {
    for (const flag of extraFlags.split(/\s+/u)) {
      if (!flag.startsWith("--")) {
        continue;
      }
      const separator = flag.indexOf("=");
      const name = flag.slice(2, separator === -1 ? undefined : separator);
      const normalizedName = normalizeClosureFlagName(name);
      if (MANAGED_CLOSURE_FLAGS.has(normalizedName)) {
        throw new TypeError(
          `GCC_CLOSURE_EXTRA_FLAGS may not override managed Closure flag --${name}.`,
        );
      }
      const value = separator === -1 ? true : flag.slice(separator + 1);
      if (normalizedName === "numparallelthreads") {
        // This scalar override replaces the default regardless of spelling.
        options["numParallelThreads"] = value;
        continue;
      }
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

export function normalizeClosureFlagName(name: string) {
  return name.replace(/[-_]/gu, "").toLowerCase();
}

export function configureClosureCompilerOptions(
  closureOptions: ClosureCompilerOptions,
  environmentOptions = resolveClosureCompilerEnvironment().options,
) {
  Object.assign(closureOptions, environmentOptions);
}
