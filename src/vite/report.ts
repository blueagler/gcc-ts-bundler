import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { accountBarriers } from "../externs/barriers";
import { gzipByteLength } from "../shared/lifecycle-size";
import { isString } from "../shared/validation";
import type { CompilerExternArtifacts } from "./compiler-externs";
import type {
  CapturedModule,
  MaterializedGraph,
  OutputChunk,
} from "./internal-types";
import { stripQuery } from "./capture";
import type { GccTsBundlerVitePluginOptions, ViteBuildReport } from "./types";

export function resolveViteBuildReportFile(
  options: GccTsBundlerVitePluginOptions,
  projectRoot: string,
) {
  if (!options.report) {
    return null;
  }
  return path.resolve(projectRoot, options.report.file ?? "gcc-report.json");
}

async function collectPinnedProperties(renameBarrierFiles: string[]) {
  const pinned = new Set<string>();
  for (const filePath of renameBarrierFiles) {
    const text = await fs.readFile(filePath, "utf8").catch(() => "");
    for (const name of accountBarriers({ label: filePath, text })
      .propertyNames) {
      pinned.add(name);
    }
  }
  return [...pinned].sort((left, right) => left.localeCompare(right));
}

function measureJsBytes(sources: string[]) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const source of sources) {
    rawBytes += Buffer.byteLength(source);
    gzipBytes += gzipByteLength(source);
  }
  return { gzipBytes, rawBytes };
}
/**
 * Measure the Vite JS chunks before compilation: the pipeline later writes
 * the compiled code back into these same bundle chunks (that is how Vite
 * emits them), so a snapshot taken after emit would compare the output with
 * itself.
 */
export function measureViteBaselineJs(jsChunks: OutputChunk[]) {
  return {
    chunkCount: jsChunks.length,
    ...measureJsBytes(jsChunks.map((chunk) => chunk.code)),
  };
}

function deltaPct(baseline: number, output: number) {
  if (baseline === 0) {
    return 0;
  }
  return Math.round(((output - baseline) / baseline) * 1000) / 10;
}

function toReportModuleId(moduleId: string, projectRoot: string) {
  const stripped = stripQuery(moduleId);
  const relative = path.relative(projectRoot, stripped);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/gu, "/");
  }
  // Outside the project root (e.g. extern files in the shared build cache):
  // anchor to the home directory so reports do not embed machine-specific
  // absolute prefixes.
  const home = os.homedir();
  return stripped.startsWith(`${home}${path.sep}`)
    ? `~/${path.relative(home, stripped).replace(/\\/gu, "/")}`
    : stripped;
}

function collectDeadModules(input: {
  capturedModules: Map<string, CapturedModule>;
  materialized: MaterializedGraph;
  projectRoot: string;
}) {
  const compiledSourceIds = new Set(
    input.materialized.modules.flatMap((module) => module.sourceModuleIds),
  );
  const prunedEmptyIds = new Set(input.materialized.prunedEmptyModuleIds);
  const deadModules: Array<{ id: string; renderedBytes: number }> = [];
  for (const [moduleId, record] of input.capturedModules) {
    if (moduleId.startsWith("\0")) {
      continue;
    }
    if (record.renderedLength === undefined || record.renderedLength === 0) {
      continue;
    }
    if (compiledSourceIds.has(moduleId) || prunedEmptyIds.has(moduleId)) {
      continue;
    }
    deadModules.push({
      id: toReportModuleId(moduleId, input.projectRoot),
      renderedBytes: record.renderedLength,
    });
  }
  deadModules.sort(
    (left, right) =>
      right.renderedBytes - left.renderedBytes ||
      left.id.localeCompare(right.id),
  );
  return { compiledSourceIds, deadModules };
}

export async function writeViteBuildReport(input: {
  baseline: ViteBuildReport["javascript"]["baseline"];
  capturedModules: Map<string, CapturedModule>;
  externs: CompilerExternArtifacts;
  finalOutputFiles: string[];
  materialized: MaterializedGraph;
  projectRoot: string;
  reportFile: string;
}) {
  const outputJsFiles = input.finalOutputFiles.filter((filePath) =>
    filePath.endsWith(".js"),
  );
  const output = measureJsBytes(
    await Promise.all(
      outputJsFiles.map((filePath) => fs.readFile(filePath, "utf8")),
    ),
  );
  const { deadModules } = collectDeadModules(input);
  const report: ViteBuildReport = {
    version: 1,
    javascript: {
      baseline: input.baseline,
      output: { fileCount: outputJsFiles.length, ...output },
      deltaPct: {
        gzip: deltaPct(input.baseline.gzipBytes, output.gzipBytes),
        raw: deltaPct(input.baseline.rawBytes, output.rawBytes),
      },
    },
    modules: {
      capturedCount: input.capturedModules.size,
      compiledCount: input.materialized.modules.length,
      deadModules,
      prunedEmptyCount: input.materialized.prunedEmptyModuleIds.length,
    },
    properties: {
      pinned: await collectPinnedProperties(input.externs.renameBarriers),
      renameBarrierFiles: input.externs.renameBarriers.map((filePath) =>
        toReportModuleId(filePath, input.projectRoot),
      ),
      typedExternFiles: input.externs.typedDeclarations.map((extern) =>
        toReportModuleId(
          isString(extern) ? extern : extern.path,
          input.projectRoot,
        ),
      ),
    },
  };
  await fs.mkdir(path.dirname(input.reportFile), { recursive: true });
  await fs.writeFile(
    input.reportFile,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const deadBytes = deadModules.reduce(
    (total, module) => total + module.renderedBytes,
    0,
  );
  const displayPath = path.relative(input.projectRoot, input.reportFile);
  console.warn(
    `gcc-ts-bundler: report ${displayPath.startsWith("..") ? input.reportFile : displayPath} — js raw ${report.javascript.deltaPct.raw}% gzip ${report.javascript.deltaPct.gzip}% vs Vite, dead modules ${deadModules.length} (${deadBytes} B rendered), pinned properties ${report.properties.pinned.length}.`,
  );
  return report;
}
