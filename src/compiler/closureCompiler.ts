import fs from "fs/promises";
import { compiler } from "google-closure-compiler";
import path from "path";

import { Settings } from "../settings";
import { customTransform } from "./postCompiler";

const GCC_ENTRY = "globalThis.GCC";

interface EntryPointState {
  isLocked: boolean;
  originalContent: string;
  path: string;
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
    for (const entryPoint of settings.entryPoints) {
      const baseName = path.basename(entryPoint);
      const outputPath = path.join(settings.outputDir, baseName);
      const tempPath = path.join(settings.outputDir, `${baseName}.tmp`);

      try {
        await updateEntryPointStates(entryPointStates, entryPoint);
        await new Promise<void>((resolve, reject) => {
          new compiler({
            ...options,
            entryPoint,
            jsOutputFile: tempPath,
          }).run((exitCode, stdOut, stdErr) => {
            if (exitCode === 0) {
              console.log(`Compilation of ${baseName} successful.`);
              if (stdOut) console.log(stdOut);
              fs.readFile(tempPath, "utf-8")
                .then((compiledCode) => customTransform(compiledCode))
                .then((transformedCode) => {
                  const lockedCode = lockGCCAssignments(transformedCode);
                  return fs.writeFile(outputPath, lockedCode);
                })
                .then(() => fs.unlink(tempPath))
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
