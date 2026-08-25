import fs from "node:fs/promises";

import type { CapturedModule } from "../internal-types";
import {
  getCapturedModuleAnalysis,
  isDependencyModuleId,
  stripQuery,
} from "./format";

export async function restoreEmptyDependencyModuleSource(
  id: string,
  transformedCode: string,
) {
  if (!isDependencyModuleId(id)) {
    return transformedCode;
  }
  const transformedRecord: CapturedModule = { code: transformedCode, id };
  if (!getCapturedModuleAnalysis(transformedRecord).isEffectivelyEmpty) {
    return transformedCode;
  }

  try {
    const sourceCode = await fs.readFile(stripQuery(id), "utf8");
    const sourceRecord: CapturedModule = { code: sourceCode, id };
    const sourceAnalysis = getCapturedModuleAnalysis(sourceRecord);
    return sourceAnalysis.moduleFormat === "esm" &&
      !sourceAnalysis.isEffectivelyEmpty
      ? sourceCode
      : transformedCode;
  } catch {
    return transformedCode;
  }
}
