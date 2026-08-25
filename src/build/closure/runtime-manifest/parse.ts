import {
  isObjectOf,
  isString,
  isStringArray,
  optional,
  parseJson,
  recordOf,
} from "../../../shared/validation";

export interface GccRuntimeManifestChunk {
  css?: string[];
  deps: string[];
  modules: string[];
  url: string;
}

export interface GccRuntimeManifest {
  baseChunk: string;
  chunks: Record<string, GccRuntimeManifestChunk>;
  loader: string;
  modules: Record<string, string>;
  publicPath: string;
}

export function parseGccRuntimeManifest(text: string, source: string) {
  return parseJson(text, isGccRuntimeManifest, source);
}

const isGccRuntimeManifestChunk = isObjectOf<GccRuntimeManifestChunk>({
  css: optional(isStringArray),
  deps: isStringArray,
  modules: isStringArray,
  url: isString,
});

const isGccRuntimeManifest = isObjectOf<GccRuntimeManifest>({
  baseChunk: isString,
  chunks: recordOf(isGccRuntimeManifestChunk),
  loader: isString,
  modules: recordOf(isString),
  publicPath: isString,
});
