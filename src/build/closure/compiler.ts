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

export function applyInternalClosureDebugOptions(
  closureOptions: ClosureCompilerOptions,
) {
  if (process.env["GCC_CLOSURE_DEBUG"] === "1") {
    closureOptions["debug"] = true;
    closureOptions["formatting"] = "PRETTY_PRINT";
  }
  if (
    closureOptions["compilationLevel"] === "ADVANCED" &&
    process.env["GCC_USE_TYPES_FOR_OPTIMIZATION"] !== "false"
  ) {
    closureOptions["useTypesForOptimization"] = true;
  } else if (process.env["GCC_USE_TYPES_FOR_OPTIMIZATION"] === "false") {
    closureOptions["useTypesForOptimization"] = false;
  }
}

export function configureClosureCompilerOptions(
  closureOptions: ClosureCompilerOptions,
) {
  applyInternalClosureDebugOptions(closureOptions);
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
        console.error(stdErr);
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
