import minimist from "minimist";
import path from "path";

import { usage } from "./utils/fileUtils";

export interface Settings {
  compilationLevel: string;
  entryPoints: string[];
  externs: string[];
  fatalWarnings: boolean;
  js: string[];
  languageOut: string;
  outputDir: string;
  preserveCache: boolean;
  srcDir: string;
  verbose: boolean;
}

export function loadSettingsFromArgs(args: string[]): { settings: Settings } {
  const cwd = process.cwd();
  const defaultSettings: Settings = {
    compilationLevel: "ADVANCED",
    entryPoints: [],
    externs: [],
    fatalWarnings: false,
    js: [],
    languageOut: "ECMASCRIPT_NEXT",
    outputDir: path.join(cwd, "./dist"),
    preserveCache: false,
    srcDir: "./src",
    verbose: false,
  };

  const parsedArgs = minimist(args);
  const settings = { ...defaultSettings };

  for (const [flag, value] of Object.entries(parsedArgs)) {
    switch (flag) {
      case "src_dir":
        settings.srcDir = value;
        break;
      case "entry_point": {
        const entryPoints: string[] = Array.isArray(value) ? value : [value];
        for (const entryPoint of entryPoints) {
          settings.entryPoints.push(
            path.join(cwd, "./.closured/", entryPoint.replace(/\.ts$/, ".js")),
          );
        }
        break;
      }
      case "output_dir":
        settings.outputDir = path.join(cwd, String(value));
        break;
      case "language_out":
        settings.languageOut = String(value);
        break;
      case "compilation_level":
        settings.compilationLevel = String(value);
        break;
      case "preserve_cache":
        settings.preserveCache = true;
        break;
      case "verbose":
        settings.verbose = true;
        break;
      case "fatal_warnings":
        settings.fatalWarnings = true;
        break;
      case "h":
      case "help":
        usage();
        process.exit(0);
    }
  }

  return { settings };
}
