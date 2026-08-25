import fs from "fs/promises";
import path from "path";

import type {
  ChunkPlanChunk,
  PreservedImport,
  PreservedModule,
} from "../../types";
import type { prepareClosureJobs } from "../../../native/load";
import {
  addPreservedImportClause,
  renderMergedSpecifierImport,
  type OutputImportState,
} from "./imports";

export async function rewritePreservedModulePaths(input: {
  chunkPlan: ChunkPlanChunk[];
  imports: PreservedImport[];
  modules: PreservedModule[];
  outDir: string;
  postprocessActions: ReturnType<
    typeof prepareClosureJobs
  >["postprocessActions"];
}) {
  const moduleById = new Map(
    input.modules.map((module) => [module.moduleId, module]),
  );
  const sourceByOutput = new Map(
    await Promise.all(
      input.postprocessActions.map(
        async (action) =>
          [
            action.outputPath,
            await fs.readFile(action.outputPath, "utf8"),
          ] as const,
      ),
    ),
  );
  const importStateByOutput = new Map<string, OutputImportState>();
  for (const preservedImport of input.imports) {
    const target = preservedImport.externalSpecifier
      ? undefined
      : moduleById.get(preservedImport.targetModuleId);
    if (!preservedImport.externalSpecifier && !target) {
      throw new Error(
        `Missing preserved-module plan for ${preservedImport.targetModuleId}.`,
      );
    }
    const importerPath = normalizeFilePath(preservedImport.importerFilePath);
    const chunkIndex = input.chunkPlan.findIndex((chunk) =>
      [...chunk.files, ...(chunk.entryFiles ?? [])].some((filePath) =>
        importerPath.endsWith(`/${normalizeFilePath(filePath)}`),
      ),
    );
    if (chunkIndex < 0) {
      throw new Error(
        `Could not assign preserved import from ${preservedImport.importerFilePath} to a compiled chunk.`,
      );
    }
    const originOutputPath = input.postprocessActions[chunkIndex]?.outputPath;
    if (!originOutputPath) {
      throw new Error(
        `Missing Closure output action for preserved import from ${preservedImport.importerFilePath}.`,
      );
    }
    const consumerOutputs = new Set([originOutputPath]);
    for (const [outputPath, source] of sourceByOutput) {
      if (
        preservedImport.boundaryNames.some((boundaryName) =>
          source.includes(boundaryName),
        )
      ) {
        consumerOutputs.add(outputPath);
      }
    }
    const targetPath = target
      ? path.resolve(input.outDir, target.outputRelativePath)
      : undefined;
    for (const outputPath of consumerOutputs) {
      const specifier = preservedImport.externalSpecifier
        ? preservedImport.externalSpecifier
        : (() => {
            if (!targetPath) {
              throw new Error("Missing preserved-module target path.");
            }
            const relative = path
              .relative(path.dirname(outputPath), targetPath)
              .replace(/\\/g, "/");
            return relative.startsWith(".") ? relative : `./${relative}`;
          })();
      let state = importStateByOutput.get(outputPath);
      if (!state) {
        state = { order: [], bySpecifier: new Map() };
        importStateByOutput.set(outputPath, state);
      }
      let merged = state.bySpecifier.get(specifier);
      if (!merged) {
        merged = { defaults: [], named: [], namespaces: [] };
        state.bySpecifier.set(specifier, merged);
        state.order.push(specifier);
      }
      addPreservedImportClause(merged, preservedImport.importClause);
    }
  }

  await Promise.all(
    [...importStateByOutput].map(async ([outputPath, state]) => {
      const source = await fs.readFile(outputPath, "utf8");
      const importLines: string[] = [];
      const aliasLines: string[] = [];
      for (const specifier of state.order) {
        const merged = state.bySpecifier.get(specifier);
        if (!merged) continue;
        const rendered = renderMergedSpecifierImport(specifier, merged);
        importLines.push(rendered.importLine);
        aliasLines.push(...rendered.aliasLines);
      }
      await fs.writeFile(
        outputPath,
        `${[...importLines, ...aliasLines].join("\n")}\n${source}`,
        "utf8",
      );
    }),
  );
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//u, "");
}
