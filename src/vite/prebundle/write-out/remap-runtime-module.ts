import path from "node:path";

import type { CapturedRuntimeModule } from "../../internal-types";
import { normalizePath } from "../shared";

export function remapRuntimeModuleToSrcDir(
  module: CapturedRuntimeModule,
  fromSrcDir: string,
  toSrcDir: string,
): CapturedRuntimeModule {
  return {
    ...module,
    filePath: normalizePath(
      path.join(toSrcDir, path.relative(fromSrcDir, module.filePath)),
    ),
    relativePath: path
      .relative(fromSrcDir, module.filePath)
      .replace(/\\/g, "/"),
  };
}
