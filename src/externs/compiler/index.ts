import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import { loadCompilerOptions } from "../../build/resolve/compiler-options";
import { hasErrorCode } from "../../shared/validation";
import { targetCompilerOptions, type TargetName } from "../../api/targets";
import { isRecoverableExternConfigError } from "../shared";
import { uniqueSortedStrings } from "../../shared/files";
import { resolveModuleTypeEntry } from "./target";

export { collectReachableTypeFiles } from "./reachable";
export {
  isNodeBuiltin,
  isPlatformBuiltin,
  resolveModuleTypeEntry,
} from "./target";

export async function loadExternCompilerOptions({
  projectRoot,
  target = "browser",
  tsConfigPath,
}: {
  projectRoot: string;
  target?: TargetName | undefined;
  tsConfigPath: string | undefined;
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  } satisfies ts.CompilerOptions;
  const resolvedConfigPath =
    tsConfigPath ?? path.join(projectRoot, "tsconfig.json");
  try {
    await fs.promises.access(resolvedConfigPath, fs.constants.R_OK);
    try {
      return targetCompilerOptions(
        await loadCompilerOptions(resolvedConfigPath, {
          allowJs: true,
          rootDir: projectRoot,
        }),
        target,
      );
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  return targetCompilerOptions(fallbackOptions, target);
}

export async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  resolutionCache = ts.createModuleResolutionCache(
    projectRoot,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    compilerOptions,
  ),
  specifiers,
  target = "browser",
  tolerateMissing,
}: {
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  resolutionCache?: ts.ModuleResolutionCache | undefined;
  specifiers: string[];
  target?: TargetName | undefined;
  tolerateMissing: boolean;
}) {
  const resolvedEntries: string[] = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(
        await resolveModuleTypeEntry({
          compilerOptions,
          projectRoot,
          resolutionCache,
          specifier,
          target,
        }).then((entry) => entry.declarationEntry),
      );
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueSortedStrings(resolvedEntries);
}

export function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir,
}: {
  entryFiles: string[];
  projectRoot: string;
  srcDir: string;
}) {
  return entryFiles.map((entry) => {
    if (path.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path.resolve(srcDir, entry);
    if (ts.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path.resolve(projectRoot, entry);
  });
}
