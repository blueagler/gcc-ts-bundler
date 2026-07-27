import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { build as esbuildBuild } from "esbuild";

import { isRecord } from "../../shared/validation";

let cachedEsbuildBuild: Promise<EsbuildBuild> | null = null;

export type EsbuildBuild = typeof esbuildBuild;

export async function loadEsbuildBuild() {
  if (cachedEsbuildBuild) {
    return cachedEsbuildBuild;
  }

  cachedEsbuildBuild = (async () => {
    const require = createRequire(import.meta.url);
    const vitePackagePath = require.resolve("vite/package.json");
    const esbuildPath = require.resolve("esbuild", {
      paths: [path.dirname(vitePackagePath)],
    });
    const esbuildModule: unknown = await import(
      pathToFileURL(esbuildPath).href
    );
    if (!isEsbuildModule(esbuildModule)) {
      throw new TypeError(`Invalid esbuild module loaded from ${esbuildPath}.`);
    }
    return esbuildModule.build;
  })();

  return await cachedEsbuildBuild;
}

function isEsbuildModule(value: unknown): value is { build: EsbuildBuild } {
  return isRecord(value) && typeof value.build === "function";
}
