import fs from "fs";
import path from "path";

import { writeFileIfChanged } from "../internal/files";
import {
  assertNever,
  defineValues,
  requireChoice,
} from "../internal/validation";
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

export const EXTERN_MODES = defineValues(
  "boundary-aware",
  "candidates",
  "runtime-aware",
);
export type GenerateExternsMode = (typeof EXTERN_MODES)[number];

export interface GenerateExternsOptions {
  appEntryFiles?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly string[];
  outputFile?: string | undefined;
  projectRoot?: string | undefined;
  runtimeEntryFiles?: readonly string[] | undefined;
  srcDir?: string | undefined;
  tsConfigPath?: string | undefined;
}

export interface GenerateExternsResult {
  mode: GenerateExternsMode;
  modules: readonly string[];
  outputFile: string | undefined;
  scannedFiles: readonly string[];
  text: string;
}

interface ResolvedExternOptions {
  appEntryFiles: string[];
  compilerOptions: Awaited<ReturnType<typeof loadExternCompilerOptions>>;
  includeDependencies: boolean;
  mode: GenerateExternsMode;
  modules: string[];
  outputFile: string | undefined;
  projectRoot: string;
  runtimeEntryFiles: string[];
  srcDir: string;
}

export async function generateExterns(
  options: GenerateExternsOptions,
): Promise<GenerateExternsResult> {
  const resolved = await resolveExternOptions(options);
  const scannedFiles = await resolveScannedFiles(resolved);
  const analysis = createExternAnalysisContext({
    appEntryFiles: resolved.appEntryFiles,
    compilerOptions: resolved.compilerOptions,
    projectRoot: resolved.projectRoot,
    scannedFiles,
  });
  const text = await renderExterns(resolved, analysis);

  if (resolved.outputFile !== undefined) {
    await fs.promises.mkdir(path.dirname(resolved.outputFile), {
      recursive: true,
    });
    await writeFileIfChanged(resolved.outputFile, text);
  }

  return {
    mode: resolved.mode,
    modules: resolved.modules,
    outputFile: resolved.outputFile,
    scannedFiles,
    text,
  };
}

async function resolveExternOptions(
  options: GenerateExternsOptions,
): Promise<ResolvedExternOptions> {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }

  const mode = requireChoice(
    options.mode ?? "boundary-aware",
    EXTERN_MODES,
    "mode",
  );
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? ".");
  const appEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: [...(options.appEntryFiles ?? [])],
    projectRoot,
    srcDir,
  });
  const runtimeEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: [...(options.runtimeEntryFiles ?? [])],
    projectRoot,
    srcDir,
  });

  validateModeInputs(mode, appEntryFiles, runtimeEntryFiles);

  return {
    appEntryFiles,
    compilerOptions: await loadExternCompilerOptions({
      projectRoot,
      tsConfigPath:
        options.tsConfigPath === undefined
          ? undefined
          : path.resolve(projectRoot, options.tsConfigPath),
    }),
    includeDependencies: options.includeDependencies ?? true,
    mode,
    modules: [...options.modules],
    outputFile:
      options.outputFile === undefined
        ? undefined
        : path.resolve(projectRoot, options.outputFile),
    projectRoot,
    runtimeEntryFiles,
    srcDir,
  };
}

function validateModeInputs(
  mode: GenerateExternsMode,
  appEntryFiles: readonly string[],
  runtimeEntryFiles: readonly string[],
) {
  if (mode === "boundary-aware" && appEntryFiles.length === 0) {
    throw new Error(
      "generateExterns in boundary-aware mode requires appEntryFiles.",
    );
  }
  if (mode === "runtime-aware" && runtimeEntryFiles.length === 0) {
    throw new Error(
      "generateExterns in runtime-aware mode requires runtimeEntryFiles.",
    );
  }
}

async function resolveScannedFiles(options: ResolvedExternOptions) {
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions: options.compilerOptions,
    projectRoot: options.projectRoot,
    specifiers: options.modules,
    tolerateMissing: options.mode === "runtime-aware",
  });
  if (typeEntryFiles.length === 0) {
    return [];
  }
  return collectReachableTypeFiles({
    compilerOptions: options.compilerOptions,
    entryFiles: typeEntryFiles,
    includeDependencies: options.includeDependencies,
  });
}

async function renderExterns(
  options: ResolvedExternOptions,
  analysis: ReturnType<typeof createExternAnalysisContext>,
) {
  switch (options.mode) {
    case "boundary-aware":
      return renderBoundaryAwareExterns({
        analysis,
        modules: options.modules,
      });
    case "candidates":
      return renderCandidateExterns({
        analysis,
        modules: options.modules,
      });
    case "runtime-aware":
      return renderRuntimeAwareExterns({
        analysis,
        modules: options.modules,
        runtimeEntryFiles: options.runtimeEntryFiles,
      });
    default:
      return assertNever(options.mode);
  }
}
