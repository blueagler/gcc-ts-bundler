import { defineValues, isFunction } from "../../shared/validation";
import type { NativeBinding } from "../abi";
import { loadNativeBinding, type NativeAddonCandidate } from "../index";

let cachedBinding: NativeBinding | null = null;

const NATIVE_BINDING_METHODS = defineValues(
  "closureCompilerCapabilities",
  "collectFileStates",
  "matchFileStates",
  "minifyJavaScript",
  "planChunks",
  "prepareClosureJobs",
  "resolveGraph",
  "resolveViteTargetLanguageOut",
  "rewriteGccExports",
  "emitPreservedModule",
  "transpileSources",
  "writeEntryShims",
) satisfies ReadonlyArray<keyof NativeBinding>;

export function loadBinding(): NativeBinding {
  if (cachedBinding) {
    return cachedBinding;
  }
  const nativeBinding = loadNativeBinding();
  if (!isNativeBinding(nativeBinding)) {
    throw new TypeError("Loaded native addon has an invalid API surface.");
  }

  cachedBinding = nativeBinding;
  return cachedBinding;
}

function isNativeBinding<Value extends NativeAddonCandidate>(
  value: Value,
): value is Value & NativeBinding {
  return NATIVE_BINDING_METHODS.every((methodName) =>
    isFunction(value[methodName]),
  );
}
