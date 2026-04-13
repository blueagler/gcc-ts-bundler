import fs from "fs";
import path from "path";

import { writeFileIfChanged } from "../internal/files";
import { createExternAnalysisContext } from "./externs/context";
import {
  collectReachableTypeFiles,
  loadExternCompilerOptions,
  resolveAnalysisEntryFiles,
  resolveModuleTypeEntries,
} from "./externs/compiler";
import {
  renderBoundaryAwareExterns,
  renderCandidateExterns,
  renderRuntimeAwareExterns,
} from "./externs/render";

export type GenerateExternsMode =
  | "boundary-aware"
  | "candidates"
  | "runtime-aware";

export interface GenerateExternsOptions {
  appEntryFiles?: string[];
  includeDependencies?: boolean;
  mode?: GenerateExternsMode;
  modules: string[];
  outputFile?: string;
  projectRoot?: string;
  runtimeEntryFiles?: string[];
  srcDir?: string;
  tsConfigPath?: string;
}

export interface GenerateExternsResult {
  mode: GenerateExternsMode;
  modules: string[];
  outputFile?: string;
  scannedFiles: string[];
  text: string;
}

export async function generateExterns(
  options: GenerateExternsOptions,
): Promise<GenerateExternsResult> {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }

  const mode = options.mode ?? "boundary-aware";
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath =
    options.tsConfigPath && path.resolve(projectRoot, options.tsConfigPath);
  const compilerOptions = await loadExternCompilerOptions({
    projectRoot,
    tsConfigPath,
  });
  const includeDependencies = options.includeDependencies ?? true;
  const resolvedAppEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: options.appEntryFiles ?? [],
    projectRoot,
    srcDir,
  });
  const resolvedRuntimeEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: options.runtimeEntryFiles ?? [],
    projectRoot,
    srcDir,
  });

  if (mode === "boundary-aware" && (options.appEntryFiles?.length ?? 0) === 0) {
    throw new Error(
      "generateExterns in boundary-aware mode requires appEntryFiles.",
    );
  }
  if (
    mode === "runtime-aware" &&
    (options.runtimeEntryFiles?.length ?? 0) === 0
  ) {
    throw new Error(
      "generateExterns in runtime-aware mode requires runtimeEntryFiles.",
    );
  }

  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot,
    specifiers: options.modules,
    tolerateMissing: mode === "runtime-aware",
  });
  const scannedFiles =
    typeEntryFiles.length === 0
      ? []
      : await collectReachableTypeFiles({
          compilerOptions,
          entryFiles: typeEntryFiles,
          includeDependencies,
        });
  const analysis = createExternAnalysisContext({
    appEntryFiles: resolvedAppEntryFiles,
    compilerOptions,
    projectRoot,
    scannedFiles,
  });
  const text =
    mode === "candidates"
      ? renderCandidateExterns({
          analysis,
          modules: options.modules,
        })
      : mode === "boundary-aware"
        ? renderBoundaryAwareExterns({
            analysis,
            modules: options.modules,
          })
        : await renderRuntimeAwareExterns({
            analysis,
            modules: options.modules,
            runtimeEntryFiles: resolvedRuntimeEntryFiles,
          });

  const outputFile =
    options.outputFile && path.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    await writeFileIfChanged(outputFile, text);
  }

  return {
    mode,
    modules: [...options.modules],
    outputFile,
    scannedFiles,
    text,
  };
}
