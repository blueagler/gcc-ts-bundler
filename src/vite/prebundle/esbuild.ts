import { createRequire } from "node:module";
import path from "node:path";

import type {
  build as esbuildBuild,
  transform as esbuildTransform,
} from "esbuild";

import { isRecord } from "../../shared/validation";

let cachedEsbuildModule: Promise<EsbuildModule> | null = null;

export type EsbuildBuild = typeof esbuildBuild;
type EsbuildTransform = typeof esbuildTransform;
interface EsbuildModule {
  build: EsbuildBuild;
  transform: EsbuildTransform;
}

export async function loadEsbuildModule() {
  if (cachedEsbuildModule) {
    return await cachedEsbuildModule;
  }

  cachedEsbuildModule = (async () => {
    const requireFromVite = createRequire(import.meta.url);
    const vitePackagePath = requireFromVite.resolve("vite/package.json");
    const esbuildPath = requireFromVite.resolve("esbuild", {
      paths: [path.dirname(vitePackagePath)],
    });
    const loadedEsbuildModule: unknown = requireFromVite(esbuildPath);
    if (!isEsbuildModule(loadedEsbuildModule)) {
      throw new TypeError(`Invalid esbuild module loaded from ${esbuildPath}.`);
    }
    return loadedEsbuildModule;
  })();

  return await cachedEsbuildModule;
}

function isEsbuildModule(value: unknown): value is EsbuildModule {
  return (
    isRecord(value) &&
    value["build"] instanceof Function &&
    value["transform"] instanceof Function
  );
}
