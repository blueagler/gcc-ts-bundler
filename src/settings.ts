import minimist from "minimist";
import path from "path";

import { usage } from "./utils/fileUtils";

export interface Settings {
  compilationLevel: string;
  entryPoint: string;
  externs: string[];
  fatalWarnings: boolean;
  js: string[];
  jsOutputFile: string;
  languageOut: string;
  srcDir: string;
  verbose: boolean;
}

export function loadSettingsFromArgs(args: string[]): { settings: Settings } {
  const cwd = process.cwd();
  const defaultSettings: Settings = {
    compilationLevel: "ADVANCED",
    entryPoint: "",
    externs: [],
    fatalWarnings: false,
    js: [],
    jsOutputFile: "",
    languageOut: "ES5",
    srcDir: "./",
    verbose: false,
  };

  const parsedArgs = minimist(args);
  const settings = { ...defaultSettings };

  for (const [flag, value] of Object.entries(parsedArgs)) {
    switch (flag) {
      case "h":
      case "help":
        usage();
        process.exit(0);
      case "verbose":
        settings.verbose = true;
        break;
      case "fatalWarnings":
        settings.fatalWarnings = true;
        break;
      case "language_out":
        settings.languageOut = String(value);
        break;
      case "entry_point":
        settings.entryPoint = path.join(
          cwd,
          "./.closured/",
          value.replace(/\.ts$/, ".js"),
        );
        break;
      case "js_output_file":
        settings.jsOutputFile = path.join(cwd, value);
        break;
      case "compilation_level":
        settings.compilationLevel = String(value);
        break;
      case "src-dir":
        settings.srcDir = value;
        break;
    }
  }

  return { settings };
}
