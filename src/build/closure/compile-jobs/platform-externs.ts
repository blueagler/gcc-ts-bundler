import fs from "fs/promises";
import path from "path";

import type { NodeAmbientGlobalsRenderer } from "../../../externs/ambient-globals";
import { ensureParentDirectory } from "../../../shared/files";
import { logInternalDetail } from "../../../shared/timing";
import type { ResolvedBuildOptions } from "../../types";
import { getCompileJobOutputFiles } from "../cache";
import type { PreparedCompileJob } from "./types";
import {
  generatePlatformExternsText,
  isMissingPlatformExternFailure,
} from "../platform-externs";

/**
 * Swaps Closure's full browser externs for a dependency-closed platform slice
 * (`--env CUSTOM`) on ADVANCED jobs. Polyfill jobs stay on the full set because
 * injected polyfills reference names absent from the program scan.
 *
 * Eligibility deliberately does *not* require type metadata. The slice is built
 * by scanning the same program text Closure is about to compile, which is
 * exactly as available for a JS-input job as for a typed one — the seeds
 * collector parses with `ScriptKind.JS` and every failure path (unparseable
 * file, unseedable property, unresolvable dependency) already returns null and
 * falls back to the full browser set. Requiring metadata only mirrored
 * `shouldEnableTypeInference`, and the cost of that coupling was measured: a
 * JS-input job paid 903 ms of externs parsing against ~214 ms for a slice of
 * comparable breadth, 74% of that example's whole closure phase
 * (`/tmp/gcc-w2-closurejs.md`).
 *
 * What the slice does *not* do is change renaming: it declares the same names
 * the program mentions, so an extern-pinned name stays pinned. The one hazard
 * it cannot see is a platform property reached only through a runtime-computed
 * key, and that hazard is identical under the full set — it is boundary D's
 * job (runtime-aware externs), not this gate's, and it predates this change.
 */
export async function applyMinimalPlatformExterns(
  job: PreparedCompileJob,
  platformExterns: string,
  target: ResolvedBuildOptions["target"],
  packageRoot: string,
  typeInferenceDisabled: boolean,
  projectCacheDir: string,
  warnPlatformExternFallback: () => void,
  renderNodeAmbientGlobals: NodeAmbientGlobalsRenderer,
): Promise<PreparedCompileJob> {
  if (target !== "browser") {
    const externs = job.externs.filter(
      (filePath) =>
        !["browser-extra.js", "worker.js"].includes(path.basename(filePath)),
    );
    if (target !== "node") {
      return { ...job, env: "CUSTOM", externs };
    }
    const rendered = await renderNodeAmbientGlobals(job.js);
    if (!rendered || rendered.text.length === 0) {
      return { ...job, env: "CUSTOM", externs };
    }
    const firstOutput = getCompileJobOutputFiles(job)[0];
    if (!firstOutput) {
      throw new Error("Node ambient globals require a Closure output path");
    }
    const externsPath = path.join(
      path.dirname(firstOutput),
      `node-global-externs.${path.basename(firstOutput, ".js")}.js`,
    );
    await ensureParentDirectory(externsPath);
    await fs.writeFile(externsPath, rendered.text, "utf8");
    logInternalDetail(
      "closure:node-global-externs",
      `globals=${rendered.globalNames.join(",")} bytes=${rendered.text.length}`,
    );
    return {
      ...job,
      env: "CUSTOM",
      externs: [...externs, externsPath],
    };
  }
  if (
    platformExterns !== "minimal" ||
    job.compilationLevel !== "ADVANCED" ||
    typeInferenceDisabled ||
    job.rewritePolyfills ||
    job.env !== undefined
  ) {
    return job;
  }
  const closureLibDir = path.join(packageRoot, "closure-lib");
  const closureLibFiles: string[] = [];
  const programJs = job.js.filter((filePath) => {
    const relative = path.relative(closureLibDir, path.resolve(filePath));
    const isClosureLib =
      !relative.startsWith("..") && !path.isAbsolute(relative);
    if (isClosureLib) closureLibFiles.push(filePath);
    return !isClosureLib;
  });
  const externsText = await generatePlatformExternsText(
    programJs,
    [...closureLibFiles, ...job.externs],
    // Program-keyed, so it belongs to the project rather than the machine.
    { sliceCacheRoot: projectCacheDir },
  );
  if (externsText === null) {
    warnPlatformExternFallback();
    logInternalDetail(
      "closure:platform-externs",
      "unavailable, using full browser externs",
    );
    return job;
  }
  const outputFiles = getCompileJobOutputFiles(job);
  const firstOutput = outputFiles[0];
  if (!firstOutput) {
    return job;
  }
  const externsPath = path.join(
    path.dirname(firstOutput),
    `platform-externs.${path.basename(firstOutput, ".js")}.js`,
  );
  await ensureParentDirectory(externsPath);
  await fs.writeFile(externsPath, externsText, "utf-8");
  logInternalDetail(
    "closure:platform-externs",
    `bytes=${externsText.length} metadata=${job.hasTypeMetadata}`,
  );
  return {
    ...job,
    env: "CUSTOM",
    externs: [...job.externs, externsPath],
    browserExternSlice: externsPath,
  };
}

/** Retry with full browser externs only when the slice was incomplete. */
export function preparedJobForPlatformExternRetry(
  job: PreparedCompileJob,
  capturedStdErr: string,
): PreparedCompileJob | null {
  if (
    !job.browserExternSlice ||
    !isMissingPlatformExternFailure(capturedStdErr)
  ) {
    return null;
  }
  const fullJob = { ...job };
  delete fullJob.env;
  delete fullJob.browserExternSlice;
  return {
    ...fullJob,
    externs: fullJob.externs.filter(
      (externPath) => externPath !== job.browserExternSlice,
    ),
  };
}
