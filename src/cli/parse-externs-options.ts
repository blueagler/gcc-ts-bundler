import minimist from "minimist";

import type { GenerateExternsOptions } from "../api/externs";

function asStringArray(value: string | string[] | undefined) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function parseExternsCliArgs(args: string[]) {
  const hasIncludeDependenciesFlag =
    args.includes("--include-dependencies") ||
    args.includes("--include_dependencies");
  const hasNoIncludeDependenciesFlag =
    args.includes("--no-include-dependencies") ||
    args.includes("--no-include_dependencies");
  const parsedArgs = minimist(args, {
    alias: {
      e: "entry",
      h: "help",
      o: "output-file",
      p: "project-root",
    },
    boolean: ["help", "include-dependencies"],
    string: [
      "entry",
      "mode",
      "module",
      "output-file",
      "project-root",
      "runtime-entry",
      "src-dir",
      "tsconfig",
    ],
  });

  if (parsedArgs.help) {
    return {
      options: { modules: [] } satisfies GenerateExternsOptions,
      showHelp: true,
    };
  }

  const modules = [
    ...asStringArray(parsedArgs.module ?? parsedArgs.package),
  ];

  return {
    options: {
      appEntryFiles: asStringArray(parsedArgs.entry),
      includeDependencies: hasNoIncludeDependenciesFlag
        ? false
        : hasIncludeDependenciesFlag
          ? true
          : undefined,
      mode: parsedArgs.mode,
      modules,
      outputFile:
        parsedArgs["output-file"] ??
        parsedArgs.output_file ??
        parsedArgs.output,
      projectRoot: parsedArgs["project-root"] ?? parsedArgs.project_root,
      runtimeEntryFiles: asStringArray(
        parsedArgs["runtime-entry"] ?? parsedArgs.runtime_entry,
      ),
      srcDir: parsedArgs["src-dir"] ?? parsedArgs.src_dir,
      tsConfigPath: parsedArgs.tsconfig,
    } satisfies GenerateExternsOptions,
    showHelp: false,
  };
}
