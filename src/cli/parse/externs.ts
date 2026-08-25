import { parseArgs } from "node:util";

import type { GenerateExternsOptions } from "../../externs";
import { EXTERN_MODES } from "../../externs";
import { TARGET_NAMES } from "../../api/targets";
import { parseChoice } from "../../shared/validation";

export function parseExternsCliArgs(args: string[]) {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      entry: { multiple: true, short: "e", type: "string" },
      help: { short: "h", type: "boolean" },
      "include-dependencies": { type: "boolean" },
      mode: { type: "string" },
      module: { multiple: true, type: "string" },
      "output-file": { short: "o", type: "string" },
      "project-root": { short: "p", type: "string" },
      "runtime-entry": { multiple: true, type: "string" },
      "src-dir": { type: "string" },
      target: { type: "string" },
      tsconfig: { type: "string" },
    },
    strict: true,
  });

  if (values.help) {
    return {
      options: { modules: [] } satisfies GenerateExternsOptions,
      showHelp: true,
    };
  }

  const options: GenerateExternsOptions = {
    appEntryFiles: values.entry,
    includeDependencies: values["include-dependencies"],
    mode: parseChoice(values.mode, EXTERN_MODES, "--mode"),
    modules: values.module ?? [],
    outputFile: values["output-file"],
    projectRoot: values["project-root"],
    runtimeEntryFiles: values["runtime-entry"],
    srcDir: values["src-dir"],
    target: parseChoice(values.target, TARGET_NAMES, "--target"),
    tsConfigPath: values.tsconfig,
  };

  return { options, showHelp: false };
}
