import { parseArgs } from "node:util";

import type { BuildOptions } from "../api/types";
import {
  CACHE_MODES,
  CHUNK_MODES,
  COMPILATION_LEVELS,
  DIAGNOSTICS_PREFLIGHT_MODES,
  LANGUAGE_OUTPUTS,
  PACKAGE_MODES,
  PLATFORM_EXTERNS_MODES,
} from "../api/types";
export interface CliParseResult {
  options: BuildOptions;
  showHelp: boolean;
}
import { parseChoice } from "../shared/validation";

export function parseCliArgs(args: string[]): CliParseResult {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "cache-dir": { type: "string" },
      "cache-mode": { type: "string" },
      "chunk-base-name": { type: "string" },
      "chunk-manifest": { type: "string" },
      "chunk-public-path": { type: "string" },
      chunks: { type: "string" },
      "compilation-level": { type: "string" },
      entry: { multiple: true, type: "string" },
      extern: { multiple: true, type: "string" },
      "fatal-warnings": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      js: { multiple: true, type: "string" },
      "language-out": { type: "string" },
      "out-dir": { type: "string" },
      packages: { type: "string" },
      "platform-externs": { type: "string" },
      preflight: { type: "string" },
      "project-root": { type: "string" },
      "src-dir": { type: "string" },
      verbose: { type: "boolean" },
    },
    strict: true,
  });

  if (values.help) {
    return { options: { entries: [] }, showHelp: true };
  }

  const options: BuildOptions = {
    cache: {
      dir: values["cache-dir"],
      mode: parseChoice(values["cache-mode"], CACHE_MODES, "--cache-mode"),
    },
    chunks: {
      baseChunkName: values["chunk-base-name"],
      manifestFile: values["chunk-manifest"],
      mode: parseChoice(values.chunks, CHUNK_MODES, "--chunks"),
      publicPath: values["chunk-public-path"],
    },
    compilationLevel: parseChoice(
      values["compilation-level"],
      COMPILATION_LEVELS,
      "--compilation-level",
    ),
    diagnostics: {
      fatalWarnings: values["fatal-warnings"],
      preflight: parseChoice(
        values.preflight,
        DIAGNOSTICS_PREFLIGHT_MODES,
        "--preflight",
      ),
      verbose: values.verbose,
    },
    entries: values.entry ?? [],
    externs: values.extern,
    js: values.js,
    languageOut: parseChoice(
      values["language-out"],
      LANGUAGE_OUTPUTS,
      "--language-out",
    ),
    outDir: values["out-dir"],
    packages: parseChoice(values.packages, PACKAGE_MODES, "--packages"),
    platformExterns: parseChoice(
      values["platform-externs"],
      PLATFORM_EXTERNS_MODES,
      "--platform-externs",
    ),
    projectRoot: values["project-root"],
    srcDir: values["src-dir"],
  };

  return { options, showHelp: false };
}
