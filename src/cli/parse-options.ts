import { parseArgs } from "node:util";

import type { BuildOptions } from "../api/types";
import {
  CACHE_MODES,
  CHUNK_MODES,
  CHUNK_OUTPUT_TYPES,
  COMPILATION_LEVELS,
  DIAGNOSTICS_PREFLIGHT_MODES,
  LANGUAGE_OUTPUTS,
  PACKAGE_MODES,
  PLATFORM_EXTERNS_MODES,
  TARGET_NAMES,
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
      "chunk-output-type": { type: "string" },
      chunks: { type: "string" },
      "compilation-level": { type: "string" },
      entry: { multiple: true, type: "string" },
      external: { multiple: true, type: "string" },
      extern: { multiple: true, type: "string" },
      "typed-extern": { multiple: true, type: "string" },
      help: { short: "h", type: "boolean" },
      js: { multiple: true, type: "string" },
      "language-out": { type: "string" },
      "out-dir": { type: "string" },
      packages: { type: "string" },
      "platform-externs": { type: "string" },
      "preserve-module": { multiple: true, type: "string" },
      preflight: { type: "string" },
      "project-root": { type: "string" },
      "src-dir": { type: "string" },
      target: { type: "string" },
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
      outputType: parseChoice(
        values["chunk-output-type"],
        CHUNK_OUTPUT_TYPES,
        "--chunk-output-type",
      ),
      publicPath: values["chunk-public-path"],
    },
    compilationLevel: parseChoice(
      values["compilation-level"],
      COMPILATION_LEVELS,
      "--compilation-level",
    ),
    diagnostics: {
      preflight: parseChoice(
        values.preflight,
        DIAGNOSTICS_PREFLIGHT_MODES,
        "--preflight",
      ),
      verbose: values.verbose,
    },
    entries: values.entry ?? [],
    externals: values.external,
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
    preserveModules: values["preserve-module"],
    projectRoot: values["project-root"],
    srcDir: values["src-dir"],
    target: parseChoice(values.target, TARGET_NAMES, "--target"),
    typedExterns: values["typed-extern"],
  };

  return { options, showHelp: false };
}
