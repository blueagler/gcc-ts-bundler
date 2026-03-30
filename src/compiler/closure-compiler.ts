import fs from "fs/promises";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
import path from "path";

import { Settings } from "../entry/options";
import { customTransform } from "./post-compiler";

const GCC_ENTRY = "globalThis.GCC";

interface EntryPointState {
  isLocked: boolean;
  originalContent: string;
  path: string;
}

type ClosureCompilerClass = (typeof closureCompilerPackage)["compiler"] & {
  COMPILER_PATH?: unknown;
  JAR_PATH?: unknown;
};

type ClosureCompilerPackageShape = typeof closureCompilerPackage & {
  JAR_PATH?: unknown;
};

function getDefaultString(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "string"
  ) {
    return value.default;
  }

  return undefined;
}

type ClosureCompilerInstance = InstanceType<ClosureCompilerClass> & {
  JAR_PATH?: null | string;
  javaPath?: string;
};

function resolveClosureCompilerJarPath(): string | undefined {
  const closureCompilerModule =
    closureCompilerPackage as ClosureCompilerPackageShape;
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;
  const jarPath =
    typeof closureCompiler.JAR_PATH === "string"
      ? closureCompiler.JAR_PATH
      : typeof closureCompilerModule.JAR_PATH === "string"
        ? closureCompilerModule.JAR_PATH
        : (getDefaultString(closureCompiler.JAR_PATH) ??
          getDefaultString(closureCompilerModule.JAR_PATH));

  return jarPath;
}

function configureClosureCompilerInstance(
  instance: ClosureCompilerInstance,
): ClosureCompilerInstance {
  const nativeImagePath = getNativeImagePath();
  if (nativeImagePath) {
    instance.JAR_PATH = null;
    instance.javaPath = nativeImagePath;
    return instance;
  }

  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    instance.JAR_PATH = jarPath;
  }

  return instance;
}

function unlockGCCAssignments(code: string): string {
  return code.replace(
    new RegExp(`//${GCC_ENTRY}.([\\w]+)\\s*=\\s*([^;]+);`, "g"),
    `${GCC_ENTRY}.$1 = $2;`,
  );
}
function lockGCCAssignments(code: string): string {
  return code.replace(
    new RegExp(`${GCC_ENTRY}.([\\w]+)\\s*=\\s*([^;]+);`, "g"),
    `//${GCC_ENTRY}.$1 = $2;`,
  );
}
async function prepareEntryPoints(
  entryPoints: string[],
): Promise<EntryPointState[]> {
  const reads = entryPoints.map(async (path) => ({
    isLocked: false,
    originalContent: await fs.readFile(path, "utf-8"),
    path,
  }));
  return Promise.all(reads);
}
async function updateEntryPointStates(
  states: EntryPointState[],
  currentPath: string,
): Promise<void> {
  const writes = states
    .filter((state) => {
      const shouldBeLocked = state.path !== currentPath;
      return shouldBeLocked !== state.isLocked;
    })
    .map(async (state) => {
      const content =
        state.path === currentPath
          ? unlockGCCAssignments(state.originalContent)
          : lockGCCAssignments(state.originalContent);
      await fs.writeFile(state.path, content);
      state.isLocked = state.path !== currentPath;
    });
  await Promise.all(writes);
}
export async function runClosureCompiler(settings: Settings): Promise<number> {
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;
  const options = {
    assumeFunctionWrapper: true,
    compilationLevel: settings.compilationLevel,
    dependencyMode: "PRUNE",
    externs: settings.externs,
    js: settings.js,
    languageIn: "UNSTABLE",
    languageOut: settings.languageOut,
    moduleResolution: "NODE",
    processCommonJsModules: true,
    rewritePolyfills: false,
    warningLevel: settings.verbose ? "VERBOSE" : "DEFAULT",
  };
  let entryPointStates: EntryPointState[] = [];
  try {
    entryPointStates = await prepareEntryPoints(settings.entryPoints);
    for (const [index, entryPoint] of settings.entryPoints.entries()) {
      const compilerEntryPoint = settings.compilerEntryPoints[index];
      const baseName = path.basename(entryPoint);
      const outputPath = path.join(settings.outputDir, baseName);
      const tempPath = path.join(settings.outputDir, `${baseName}.tmp`);

      try {
        await updateEntryPointStates(entryPointStates, entryPoint);
        await new Promise<void>((resolve, reject) => {
          const compilerProcess = configureClosureCompilerInstance(
            new closureCompiler({
              ...options,
              entryPoint: compilerEntryPoint,
              jsOutputFile: tempPath,
            }),
          );
          compilerProcess.run((exitCode, stdOut, stdErr) => {
            if (exitCode === 0) {
              console.log(`Compilation of ${baseName} successful.`);
              if (stdOut) console.log(stdOut);
              fs.readFile(tempPath, "utf-8")
                .then((compiledCode) => customTransform(compiledCode))
                .then((transformedCode) => {
                  const lockedCode = lockGCCAssignments(transformedCode);
                  return fs.writeFile(outputPath, lockedCode);
                })
                .then(() =>
                  settings.preserveCache
                    ? undefined
                    : fs
                        .unlink(tempPath)
                        .catch((error: NodeJS.ErrnoException) =>
                          error.code === "ENOENT"
                            ? undefined
                            : Promise.reject(error),
                        ),
                )
                .then(() => resolve())
                .catch((error) =>
                  reject(new Error(`Failed to write file: ${error}`)),
                );
            } else {
              console.error(`Compilation of ${baseName} failed.`);
              if (stdErr) console.error(stdErr);
              reject(new Error(`Compilation failed for ${baseName}`));
            }
          });
        });
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    }
    const finalRestores = entryPointStates
      .filter((state: EntryPointState) => state.isLocked)
      .map((state: EntryPointState) =>
        fs.writeFile(state.path, state.originalContent),
      );
    await Promise.all(finalRestores);
    return 0;
  } catch (error) {
    console.error("Compilation process encountered an error:", error);
    try {
      await Promise.all(
        entryPointStates.map((state: EntryPointState) =>
          fs.writeFile(state.path, state.originalContent),
        ),
      );
    } catch (restoreError) {
      console.error("Failed to restore files:", restoreError);
    }
    return 1;
  }
}
