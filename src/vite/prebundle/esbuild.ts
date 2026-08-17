import { createRequire } from "node:module";
import path from "node:path";

import type {
  build as esbuildBuild,
  transform as esbuildTransform,
} from "esbuild";

import { isRecord, type RuntimeValue } from "../../shared/validation";

let cachedEsbuildModule: Promise<EsbuildModule> | null = null;

export type EsbuildBuild = typeof esbuildBuild;
type EsbuildTransform = typeof esbuildTransform;
type Callable = (...arguments_: never[]) => void;
interface EsbuildModuleCandidate {
  build?: RuntimeValue;
  transform?: RuntimeValue;
}
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
    if (!isRecord(loadedEsbuildModule)) {
      throw new TypeError(`Invalid esbuild module loaded from ${esbuildPath}.`);
    }
    const esbuildModule: EsbuildModuleCandidate = loadedEsbuildModule;
    if (!isEsbuildModule(esbuildModule)) {
      throw new TypeError(`Invalid esbuild module loaded from ${esbuildPath}.`);
    }
    return esbuildModule;
  })();

  return await cachedEsbuildModule;
}

function isEsbuildModule<Value extends EsbuildModuleCandidate>(
  value: Value,
): value is Value & EsbuildModule {
  return (
    isCallable(value.build) &&
    isEsbuildBuild(value.build) &&
    isCallable(value.transform) &&
    isEsbuildTransform(value.transform)
  );
}

function isCallable<Value>(value: Value): value is Value & Callable {
  return value instanceof Function;
}

function isEsbuildBuild(value: Callable): value is Callable & EsbuildBuild {
  return value instanceof Function;
}

function isEsbuildTransform(
  value: Callable,
): value is Callable & EsbuildTransform {
  return value instanceof Function;
}
