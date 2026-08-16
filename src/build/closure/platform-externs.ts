import { getDefaultPersistentCacheRoot } from "../../shared/cache-store";
import { hashContent } from "../../shared/hash";
import { logInternalDetail } from "../../shared/timing";
import { getErrorMessage } from "../../shared/validation";
import { loadPlatformExternArchive } from "./platform-externs/archive";
import {
  getPlatformExternIndex,
  platformExternParserDigest,
} from "./platform-externs/index";
import {
  collectPlatformExternSeeds,
  windowGlobalPropertyAliases,
} from "./platform-externs/seeds";
import {
  collectExpiredEntries,
  digestSliceInputs,
  digestSeedNames,
  readCachedSlice,
  writeCachedSlice,
} from "./platform-externs/slice-cache";
import { slicePlatformExterns } from "./platform-externs/slice";

function platformExternSliceDigest() {
  return hashContent(
    [
      platformExternParserDigest(),
      collectPlatformExternSeeds,
      windowGlobalPropertyAliases,
      slicePlatformExterns,
    ]
      .map(String)
      .join("\0"),
  ).slice(0, 16);
}

/**
 * Builds a typed, dependency-closed platform extern slice from the exact
 * compiler.jar shipped with this package. Returning null deliberately keeps
 * the caller's full-browser fallback authoritative.
 */
export async function generatePlatformExternsText(
  jsFiles: readonly string[],
  typeDependencyFiles: readonly string[] = [],
  options: { cacheRoot?: string; sliceCacheRoot?: string } = {},
): Promise<string | null> {
  try {
    // This is the subsystem's composition root: the one place that names the
    // shared cache, because the entries are keyed by their inputs alone and
    // every project on the machine shares them by design. Callers below this
    // line take the root as a required argument so they cannot reach it by
    // accident; `cacheRoot` here exists so tests can redirect the subsystem.
    const cacheRoot = options.cacheRoot ?? getDefaultPersistentCacheRoot();
    // The unit cache is keyed by (jar, parser) alone, so it is machine-global
    // and tiny — one entry per compiler version. The *slice* cache is keyed by
    // program content, so it is project state: one entry per distinct program
    // ever compiled. Putting that in the shared user cache makes it grow
    // without bound across every project, branch and probe on the machine —
    // the same unbounded-shared-cache defect W2-P2 removed. It therefore lives
    // in the project cache, and is simply disabled when no caller supplies one.
    const sliceCacheRoot = options.sliceCacheRoot;
    void collectExpiredEntries(cacheRoot);
    if (sliceCacheRoot) void collectExpiredEntries(sliceCacheRoot);

    // Archive identity is a stat, not a 49 MB read (see the archive module),
    // and the slice cache is consulted before the index so a hit costs neither
    // the unit load nor the program scan.
    const archive = await loadPlatformExternArchive({ cacheRoot });
    if (!archive) return null;

    const inputDigest = await digestSliceInputs(jsFiles, typeDependencyFiles);
    const cacheKey =
      inputDigest && sliceCacheRoot
        ? {
            cacheRoot: sliceCacheRoot,
            inputDigest,
            jarHash: archive.jarHash,
            schemaDigest: platformExternSliceDigest(),
          }
        : null;
    if (cacheKey) {
      const cached = await readCachedSlice(cacheKey);
      if (cached !== null) return cached;
    }

    const index = await getPlatformExternIndex(archive, { cacheRoot });
    const seeds = await collectPlatformExternSeeds(
      jsFiles,
      index,
      typeDependencyFiles,
    );
    if (!seeds) return null;
    const text = slicePlatformExterns(index, seeds);
    if (text !== null && cacheKey) {
      await writeCachedSlice(
        cacheKey,
        text,
        digestSeedNames([
          ...seeds.globals,
          ...seeds.properties,
          ...seeds.typeNames,
        ]),
      );
    }
    return text;
  } catch (error) {
    logInternalDetail(
      "closure:platform-externs",
      `unavailable: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Diagnostics that mean "the generated platform-extern slice was incomplete",
 * as opposed to "the program is broken".
 *
 * The retry used to fire on *any* non-zero exit under `--env CUSTOM`, so a
 * genuine type error, a syntax error or an OOM all triggered a silent full
 * recompile: double the wall clock before the real error surfaced, and the
 * diagnostic set printed twice. Only a missing *declaration* is the slice's
 * fault, and Closure names those precisely.
 *
 * `JSC_UNDEFINED_VARIABLE` / `JSC_INEXISTENT_PROPERTY` / `JSC_POSSIBLE_INEXISTENT_PROPERTY`
 * are the shapes an under-slice produces (a global or a property the slice
 * dropped). `JSC_STRICT_INEXISTENT_PROPERTY` is the same class under strict
 * missing-property checks. `JSC_BAD_TYPE_ANNOTATION` / `JSC_TYPE_PARSE_ERROR`
 * cover a dropped *type name* still referenced by a kept annotation, which is
 * how a broken dependency closure shows up.
 */
const MISSING_EXTERN_DIAGNOSTICS = [
  "JSC_BAD_TYPE_ANNOTATION",
  "JSC_INEXISTENT_PROPERTY",
  "JSC_POSSIBLE_INEXISTENT_PROPERTY",
  "JSC_STRICT_INEXISTENT_PROPERTY",
  "JSC_TYPE_PARSE_ERROR",
  "JSC_UNDEFINED_VARIABLE",
  "JSC_UNRECOGNIZED_TYPE_ERROR",
] as const;

export function isMissingPlatformExternFailure(stdErr: string): boolean {
  return MISSING_EXTERN_DIAGNOSTICS.some((code) => stdErr.includes(code));
}

export const MISSING_PLATFORM_EXTERN_DIAGNOSTICS: readonly string[] =
  MISSING_EXTERN_DIAGNOSTICS;
