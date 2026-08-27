import path from "node:path";

import { DEFAULT_BUILD_OPTIONS } from "../../api/types";
import { analyzeRuntimeUsage } from "../../externs/runtime";
import type { RuntimeRenameHazards } from "../../externs/runtime";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../../shared/cache-store";
import { hashFileInput } from "../../shared/files";
import { hashJson } from "../../shared/hash";
import { isObjectOf, isStringArray } from "../../shared/validation";
import type { GccTsBundlerVitePluginOptions } from "../types";

type CachedRuntimeHazards = {
  [Key in keyof RuntimeRenameHazards]: string[];
};

// v3: hazard payload split into evidence classes (see externs/render.ts).
// v5: runtime hazards gained `constructedKeyFragments`.
// v6: runtime hazards gained `selfReferentialKeys`.
// v7: runtime hazards gained `enumeratedKeyNames`.
// v8: `enumeratedKeyNames` resolves const-bound lists and element transforms.
// v9: hyphenated keys also record their underscored identifier alias.
// v10: runtime hazards gained `cssVariableKeyNames`.
// v11: key reads resolve const-bound string literals (`const K = "x"; K in o`).
// v13: includeDependencies is not an input to analyzeRuntimeUsage.
const VITE_EXTERN_PACKAGE_CACHE_VERSION = 13;

export async function loadCachedPackageRuntimeHazards(input: {
  cacheRoot: string;
  filePaths: string[];
  packageName: string;
  packageSignature: string;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
}) {
  const fileHashes = await Promise.all(
    [...input.filePaths].sort().map((filePath) => hashFileInput(filePath)),
  );
  const cacheKey = hashJson({
    cacheVersion: VITE_EXTERN_PACKAGE_CACHE_VERSION,
    fileHashes,
    mode: "runtime-aware",
    packageName: input.packageName,
    packageSignature: input.packageSignature,
    protocolHelpers: input.protocolHelpers,
  });
  const cacheFile = path.join(input.cacheRoot, `${cacheKey}.json`);
  const cached = await readJsonIfExists(cacheFile, isCachedRuntimeHazards);
  if (cached) {
    return {
      cacheHit: true,
      value: toRuntimeHazards(cached),
    };
  }

  const analyzed = await analyzeRuntimeUsage(
    input.filePaths,
    input.protocolHelpers,
  );
  const serialized = serializeRuntimeHazards(analyzed);
  await writeJson(cacheFile, serialized);
  return {
    cacheHit: false,
    value: analyzed,
  };
}

const isCachedRuntimeHazards = isObjectOf<CachedRuntimeHazards>({
  constructedKeyFragments: isStringArray,
  constructedKeyPrefixes: isStringArray,
  cssVariableKeyNames: isStringArray,
  dotAccessed: isStringArray,
  dotDefined: isStringArray,
  enumeratedKeyNames: isStringArray,
  protocolMembers: isStringArray,
  selfReferentialKeys: isStringArray,
  stringDefined: isStringArray,
  stringLiteralRead: isStringArray,
});

function serializeRuntimeHazards(
  hazards: RuntimeRenameHazards,
): CachedRuntimeHazards {
  const sorted = (values: ReadonlySet<string>) => [...values].sort();
  return {
    constructedKeyFragments: sorted(hazards.constructedKeyFragments),
    constructedKeyPrefixes: sorted(hazards.constructedKeyPrefixes),
    cssVariableKeyNames: sorted(hazards.cssVariableKeyNames),
    dotAccessed: sorted(hazards.dotAccessed),
    dotDefined: sorted(hazards.dotDefined),
    enumeratedKeyNames: sorted(hazards.enumeratedKeyNames),
    protocolMembers: sorted(hazards.protocolMembers),
    selfReferentialKeys: sorted(hazards.selfReferentialKeys),
    stringDefined: sorted(hazards.stringDefined),
    stringLiteralRead: sorted(hazards.stringLiteralRead),
  };
}

function toRuntimeHazards(hazards: CachedRuntimeHazards): RuntimeRenameHazards {
  return {
    constructedKeyFragments: new Set(hazards.constructedKeyFragments),
    constructedKeyPrefixes: new Set(hazards.constructedKeyPrefixes),
    cssVariableKeyNames: new Set(hazards.cssVariableKeyNames),
    dotAccessed: new Set(hazards.dotAccessed),
    dotDefined: new Set(hazards.dotDefined),
    enumeratedKeyNames: new Set(hazards.enumeratedKeyNames),
    protocolMembers: new Set(hazards.protocolMembers),
    selfReferentialKeys: new Set(hazards.selfReferentialKeys),
    stringDefined: new Set(hazards.stringDefined),
    stringLiteralRead: new Set(hazards.stringLiteralRead),
  };
}

export function resolvePackageExternCacheRoot(input: {
  captureRoot: string;
  options: GccTsBundlerVitePluginOptions;
}) {
  const cacheMode =
    input.options.compiler?.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode;
  if (cacheMode === "persistent") {
    return path.join(
      path.resolve(
        input.options.compiler?.cache?.dir ?? getDefaultPersistentCacheRoot(),
      ),
      "vite-extern-package-facts",
    );
  }

  return path.join(input.captureRoot, "vite-extern-package-facts");
}
