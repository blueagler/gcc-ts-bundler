import fs from "fs";
import { compiler } from "google-closure-compiler";
import path from "path";

import { Settings } from "../settings";
import { writeFileContent } from "../utils/fileOperations";
import { customTransform } from "./postCompiler";

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

  try {
    await Promise.all(
      settings.entryPoints.map(
        (entryPoint) =>
          new Promise((resolve, reject) => {
            const baseName = path.basename(entryPoint);
            const outputPath = path.join(settings.outputDir, baseName);
            new compiler({
              ...options,
              entryPoint,
              jsOutputFile: outputPath,
            }).run(async (exitCode, stdOut, stdErr) => {
              if (exitCode === 0) {
                console.log(`Compilation of ${baseName} successful.`);
                if (stdOut) {
                  console.log(stdOut);
                }
                writeFileContent(
                  outputPath,
                  await customTransform(fs.readFileSync(outputPath, "utf-8")),
                );
                resolve(exitCode);
              } else {
                console.error(`Compilation of ${baseName} failed.`);
                if (stdErr) {
                  console.error(stdErr);
                }
                reject(new Error(`Compilation failed for ${baseName}`));
              }
            });
          }),
      ),
    );
    return 0;
  } catch (error) {
    console.error("Compilation process encountered an error:", error);
    return 1;
  }
}
