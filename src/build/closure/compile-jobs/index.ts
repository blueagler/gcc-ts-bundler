import path from "path";

import { createNodeAmbientGlobalsRenderer } from "../../../externs/ambient-globals";
import type { TypeWorld } from "../../../externs/context";
import { logInternalDetail } from "../../../shared/timing";
import type { ResolvedBuildOptions } from "../../types";
import type { prepareClosureJobs } from "../../../native/load";
import { applyStableRenamingMaps, persistRenamingMaps } from "./cache";
import { invokePreparedClosureJob } from "./invoke";
import {
  applyMinimalPlatformExterns,
  preparedJobForPlatformExternRetry,
} from "./platform-externs";
import type { PreparedCompileJob } from "./types";
import {
  getCompileJobArtifactFiles,
  persistCachedClosureJob,
  prepareClosureJobCache,
  tryRestoreCachedClosureJob,
} from "../cache";
import {
  resolveClosureCompilerVersionTag,
  shouldEnableTypeInference,
  type ClosureCompilerEnvironment,
} from "../compiler";
import { determineClosureConcurrency } from "../concurrency";
import { runWithConcurrency } from "../../../shared/concurrency";

function createPlatformExternFallbackWarning() {
  let warned = false;
  return () => {
    if (warned) return;
    warned = true;
    console.warn(
      'gcc-ts-bundler: platform extern slicing fell back to full browser externs. Set platformExterns: "full" to use full externs intentionally.',
    );
  };
}

export async function compilePreparedClosureJobs({
  closureCompilerEnvironment,
  platformExterns,
  target,
  packageRoot,
  projectRoot,
  prepared,
  projectCacheDir,
  typeWorld,
  usesPersistentCache,
}: {
  closureCompilerEnvironment: ClosureCompilerEnvironment;
  platformExterns: string;
  target: ResolvedBuildOptions["target"];
  packageRoot: string;
  projectRoot: string;
  prepared: ReturnType<typeof prepareClosureJobs>;
  projectCacheDir: string;
  typeWorld?: TypeWorld | undefined;
  usesPersistentCache: boolean;
}) {
  const cacheDir = usesPersistentCache
    ? path.join(projectCacheDir, "closure-jobs")
    : null;
  const concurrency = determineClosureConcurrency(prepared.compileJobs.length);
  const warnPlatformExternFallback = createPlatformExternFallbackWarning();
  const renderNodeAmbientGlobals = createNodeAmbientGlobalsRenderer({
    jsFiles:
      target === "node" ? prepared.compileJobs.flatMap((job) => job.js) : [],
    packageRoot,
    projectRoot,
    typeWorld,
  });
  const results = await runWithConcurrency(
    prepared.compileJobs,
    concurrency,
    async (job) =>
      runPreparedClosureJob({
        compilerEnvironment: closureCompilerEnvironment,
        cacheDir,
        job: await applyStableRenamingMaps(
          await applyMinimalPlatformExterns(
            applyTypeInference(
              job,
              closureCompilerEnvironment.typeInferenceDisabled,
            ),
            platformExterns,
            target,
            packageRoot,
            closureCompilerEnvironment.typeInferenceDisabled,
            projectCacheDir,
            warnPlatformExternFallback,
            renderNodeAmbientGlobals,
          ),
          cacheDir,
        ),
        warnPlatformExternFallback,
      }),
  );
  if (cacheDir) {
    const hits = results.filter((result) => result.cacheHit).length;
    logInternalDetail(
      "cache:closure-jobs",
      `hits=${hits} misses=${results.length - hits} jobs=${results.length}`,
    );
  }
  return results;
}

/** Records the inference decision on the job so it reaches the cache key
 * as well as the compiler; see `shouldEnableTypeInference`. */
function applyTypeInference(
  job: PreparedCompileJob,
  typeInferenceDisabled: boolean,
): PreparedCompileJob {
  const enabled = shouldEnableTypeInference(
    job.compilationLevel,
    job.typeMetadataCounts,
    typeInferenceDisabled,
  );
  logInternalDetail(
    "closure:type-metadata-job",
    `metadata=${job.hasTypeMetadata} annotations=${job.typeMetadataCounts.annotationCount} members=${job.typeMetadataCounts.memberAnnotationCount} declarations=${job.typeMetadataCounts.typeDeclarationCount} enums=${job.typeMetadataCounts.enumDeclarationCount} unresolved=${job.typeMetadataCounts.unresolvedTypeReferenceCount} inference=${enabled}`,
  );
  return enabled ? { ...job, typeInference: true } : job;
}

async function runPreparedClosureJob({
  compilerEnvironment,
  cacheDir,
  job,
  warnPlatformExternFallback,
}: {
  compilerEnvironment: ClosureCompilerEnvironment;
  cacheDir: string | null;
  job: PreparedCompileJob;
  warnPlatformExternFallback: () => void;
}) {
  const cacheRequest = cacheDir
    ? await prepareClosureJobCache({
        artifactFiles: getCompileJobArtifactFiles(job),
        cacheDir,
        compilerVersion: resolveClosureCompilerVersionTag(),
        job: {
          ...job,
          compilerEnvironment: compilerEnvironment.options,
        },
      })
    : null;
  if (cacheRequest && (await tryRestoreCachedClosureJob(cacheRequest))) {
    await persistRenamingMaps(job, cacheDir);
    return { cacheHit: true, exitCode: 0, diagnostics: [] as string[] };
  }

  const { exitCode, stderr, stdout, diagnostics } =
    await invokePreparedClosureJob(job, compilerEnvironment);
  if (exitCode !== 0) {
    // Retry with the full browser externs only when the diagnostics say the
    // slice was incomplete. Retrying on *any* non-zero exit made every real
    // compile error cost two full Closure runs and print itself twice.
    const retryJob = preparedJobForPlatformExternRetry(job, stderr);
    if (retryJob) {
      warnPlatformExternFallback();
      logInternalDetail(
        "closure:platform-externs",
        "fallback to full browser externs",
      );
      return runPreparedClosureJob({
        compilerEnvironment,
        cacheDir,
        warnPlatformExternFallback,
        job: retryJob,
      });
    }
    return {
      cacheHit: false,
      exitCode,
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [`Closure compilation failed with exit code ${exitCode}.`],
    };
  }

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  if (cacheRequest) {
    await persistCachedClosureJob(cacheRequest);
  }
  await persistRenamingMaps(job, cacheDir);
  return {
    cacheHit: false,
    exitCode: 0,
    diagnostics: [] as string[],
  };
}
