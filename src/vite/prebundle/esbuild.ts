import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  build as esbuildBuild,
  transform as esbuildTransform,
} from "esbuild";

import { isRecord } from "../../shared/validation";

let cachedEsbuildModule: Promise<EsbuildModule> | null = null;

export type EsbuildBuild = typeof esbuildBuild;
export type EsbuildTransform = typeof esbuildTransform;

interface EsbuildModule {
  build: EsbuildBuild;
  transform: EsbuildTransform;
}

async function loadEsbuildModule() {
  if (cachedEsbuildModule) {
    return await cachedEsbuildModule;
  }

  cachedEsbuildModule = (async () => {
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
    return esbuildModule;
  })();

  return await cachedEsbuildModule;
}

export async function loadEsbuildBuild() {
  return (await loadEsbuildModule()).build;
}

export async function loadEsbuildTransform() {
  return (await loadEsbuildModule()).transform;
}

function isEsbuildModule(value: unknown): value is EsbuildModule {
  return (
    isRecord(value) &&
    typeof value.build === "function" &&
    typeof value.transform === "function"
  );
}
