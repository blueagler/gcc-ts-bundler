import fs from "node:fs/promises";
import path from "node:path";

import { hasErrorCode, isRecord } from "../../shared/validation";
import { getCapturedModuleAnalysis } from "./code";
import { isDependencyModuleId, stripQuery } from "../capture/specifiers";
import type { CapturedModule, CapturedModuleFormat } from "../internal-types";

const packageFormatByDirectory = new Map<
  string,
  Promise<CapturedModuleFormat>
>();

export async function resolveCapturedModuleFormat(record: CapturedModule) {
  const syntaxFormat = getCapturedModuleAnalysis(record).moduleFormat;
  if (syntaxFormat !== "unknown") {
    return syntaxFormat;
  }

  const cleanId = stripQuery(record.id);
  const extension = path.extname(cleanId).toLowerCase();
  if (extension === ".mjs" || extension === ".mts") {
    return "esm";
  }
  if (extension === ".cjs" || extension === ".cts") {
    return "cjs";
  }
  if (!isDependencyModuleId(cleanId) || !path.isAbsolute(cleanId)) {
    return "unknown";
  }
  return await resolvePackageModuleFormat(path.dirname(cleanId));
}

async function resolvePackageModuleFormat(
  directory: string,
): Promise<CapturedModuleFormat> {
  const normalizedDirectory = path.normalize(directory);
  const cached = packageFormatByDirectory.get(normalizedDirectory);
  if (cached) {
    return await cached;
  }

  const pending = (async (): Promise<CapturedModuleFormat> => {
    try {
      const packageText = await fs.readFile(
        path.join(normalizedDirectory, "package.json"),
        "utf8",
      );
      const packageJson: unknown = JSON.parse(packageText);
      if (!isRecord(packageJson)) {
        return "cjs";
      }
      return packageJson.type === "module" ? "esm" : "cjs";
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        return "unknown";
      }
    }

    const parent = path.dirname(normalizedDirectory);
    if (
      parent === normalizedDirectory ||
      path.basename(normalizedDirectory) === "node_modules"
    ) {
      return "unknown";
    }
    return await resolvePackageModuleFormat(parent);
  })();
  packageFormatByDirectory.set(normalizedDirectory, pending);
  return await pending;
}
