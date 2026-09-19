import ts from "@typescript/typescript6";

import { uniqueSortedStrings } from "../../shared/files";
import { logInternalDetail } from "../../shared/timing";
import {
  loadCompilerOptions,
  loadTsConfigDeclarationFiles,
  parseTsConfig,
  type ParsedTsConfig,
} from "../../build/resolve/compiler-options";
import type { ResolvedBuildOptions } from "../../build/types";
import {
  collectReachableTypeFiles,
  isPlatformBuiltin,
  resolveModuleTypeEntries,
} from "../compiler";
import { createTypeWorld, type TypeWorld } from "../context";

export async function loadBuildTypeWorldOptions(input: {
  emitFileNames: string[];
  tsConfig?: ParsedTsConfig | undefined;
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<{
  compilerOptions: ts.CompilerOptions;
  declarationRoots: string[];
}> {
  const tsConfig =
    input.tsConfig ?? parseTsConfig(input.tsConfigPath, input.emitFileNames);
  const compilerOptions = await loadCompilerOptions(
    input.tsConfigPath,
    {
      allowJs: true,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      rootDir: input.workspaceDir,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
    tsConfig,
  );
  return {
    compilerOptions,
    declarationRoots: await loadTsConfigDeclarationFiles(
      input.tsConfigPath,
      tsConfig,
    ),
  };
}

export async function createBuildTypeWorld(input: {
  compilerOptions: ts.CompilerOptions;
  declarationRoots: readonly string[];
  emitFileNames: string[];
  options: ResolvedBuildOptions;
  specifiers: string[];
  tsxRuntimeSourceFiles: string[];
}): Promise<TypeWorld> {
  const { compilerOptions, declarationRoots } = input;
  const packageSpecifiers = [...new Set(input.specifiers)].filter(
    (specifier) =>
      input.options.target !== "browser" || !isPlatformBuiltin(specifier),
  );
  // Node ambient globals (`process`, `Buffer`) are derived from `@types/node`
  // even when nothing imports a builtin, so the declaration root has to be in
  // this program or the ambient scan sees zero declaration files.
  if (input.options.target === "node") {
    packageSpecifiers.push("node:process");
  }
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
  logInternalDetail(
    "externs:type-world-roots",
    `specifiers=${packageSpecifiers.length} entries=${typeEntryFiles.length} declarations=${scannedDecls.length}`,
  );
  return createTypeWorld(
    uniqueSortedStrings([
      ...input.emitFileNames,
      ...input.tsxRuntimeSourceFiles,
      ...declarationRoots,
      ...scannedDecls,
    ]),
    compilerOptions,
  );
}
