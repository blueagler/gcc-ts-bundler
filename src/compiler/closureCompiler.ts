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
    // /\/\/globalThis\.GCC\.([\w]+)\s*=\s*([^;]+);/g,
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
    externs: settings.externs,
    js: settings.js,
    languageIn: "UNSTABLE",
    languageOut: settings.languageOut,
    warningLevel: settings.verbose ? "VERBOSE" : "DEFAULT",
  };
  let entryPointStates: EntryPointState[] = [];
  try {
    entryPointStates = await prepareEntryPoints(settings.entryPoints);
    for (const entryPoint of settings.entryPoints) {
      const baseName = path.basename(entryPoint);
      const outputPath = path.join(settings.outputDir, baseName);
      try {
        await updateEntryPointStates(entryPointStates, entryPoint);
        await new Promise<void>((resolve, reject) => {
          new compiler({
            ...options,
            entryPoint,
            jsOutputFile: outputPath,
          }).run(async (exitCode, stdOut, stdErr) => {
            if (exitCode === 0) {
              console.log(`Compilation of ${baseName} successful.`);
              if (stdOut) console.log(stdOut);
              const compiledCode = await fs.readFile(outputPath, "utf-8");
              const transformedCode = await customTransform(compiledCode);
              const lockedCode = lockGCCAssignments(transformedCode);
              await fs.writeFile(outputPath, lockedCode);
              resolve();
            } else {
              console.error(`Compilation of ${baseName} failed.`);
              if (stdErr) console.error(stdErr);
              reject(new Error(`Compilation failed for ${baseName}`));
            }
          });
        });
      } catch (error) {
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
