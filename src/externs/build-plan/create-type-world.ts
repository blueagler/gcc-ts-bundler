import ts from "@typescript/typescript6";

import { uniqueSortedStrings } from "../../shared/files";
import { loadCompilerOptions } from "../../build/resolve/compiler-options";
import type { ResolvedBuildOptions } from "../../build/types";
import {
  collectReachableTypeFiles,
  isPlatformBuiltin,
  resolveModuleTypeEntries,
} from "../compiler";
import { createTypeWorld, type TypeWorld } from "../context";

export async function createBuildTypeWorld(input: {
  emitFileNames: string[];
  options: ResolvedBuildOptions;
  specifiers: string[];
  tsConfigPath: string;
  tsxRuntimeSourceFiles: string[];
  workspaceDir: string;
}): Promise<TypeWorld> {
  const compilerOptions = await loadCompilerOptions(input.tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: input.workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const packageSpecifiers = [...new Set(input.specifiers)].filter(
    (specifier) => !isPlatformBuiltin(specifier),
  );
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot: input.options.projectRoot,
    specifiers: packageSpecifiers,
    target: input.options.target,
    tolerateMissing: true,
  });
  const scannedDecls =
    typeEntryFiles.length === 0
      ? []
      : await collectReachableTypeFiles({
          compilerOptions,
          entryFiles: typeEntryFiles,
          includeDependencies: false,
        });
  return createTypeWorld(
    uniqueSortedStrings([
      ...input.emitFileNames,
      ...input.tsxRuntimeSourceFiles,
      ...scannedDecls,
    ]),
    compilerOptions,
  );
}
