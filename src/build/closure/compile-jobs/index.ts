import path from "path";

import type { TypeWorld } from "../../../externs/context";
import { logInternalDetail } from "../../../shared/timing";
import type { ResolvedBuildOptions } from "../../types";
import type { prepareClosureJobs } from "../../../native/load";
import {
  applyStableRenamingMaps,
  persistPreparedClosureJob,
  restorePreparedClosureJob,
} from "./cache";
import { invokePreparedClosureJob } from "./invoke";
import {
  applyMinimalPlatformExterns,
  preparedJobForPlatformExternRetry,
} from "./platform-externs";
import type { PreparedCompileJob } from "./types";
import {
  shouldEnableTypeInference,
  type ClosureCompilerEnvironment,
} from "../compiler";
import {
  determineClosureConcurrency,
  runWithConcurrency,
} from "../concurrency";

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
            projectRoot,
            closureCompilerEnvironment.typeInferenceDisabled,
            projectCacheDir,
            warnPlatformExternFallback,
            typeWorld,
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
  return results.map((result) => result.exitCode);
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
  const restored = await restorePreparedClosureJob({
    compilerEnvironment,
    cacheDir,
    job,
  });
  if (restored) {
    return restored;
  }

  const { exitCode, capturedStdErr } = await invokePreparedClosureJob(
    job,
    compilerEnvironment,
  );
  if (exitCode !== 0) {
    // Retry with the full browser externs only when the diagnostics say the
    // slice was incomplete. Retrying on *any* non-zero exit made every real
    // compile error cost two full Closure runs and print itself twice.
    const retryJob = preparedJobForPlatformExternRetry(job, capturedStdErr);
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
    };
  }

  await persistPreparedClosureJob({
    compilerEnvironment,
    cacheDir,
    job,
  });
  return {
    cacheHit: false,
    exitCode: 0,
  };
}
