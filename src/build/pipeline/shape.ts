import fs from "fs/promises";
import path from "path";

import type { BuildDiagnostic, BuildFailure } from "../../api/types";
import { writeEntryShims } from "../../native/load";
import { createBuildDiagnostic, toImportPath } from "../helpers";
import { resolveChunkOutputType } from "../resolve/options";
import type { BuildContext, ResolvedBuild } from "../types";

/**
 * Diagnostics reference the workspace overlay (workspace/src/...), which
 * mirrors srcDir. Map them back so callers see paths they can open.
 */
export function createAuthoredPathMapper(
  context: BuildContext,
  resolved: ResolvedBuild,
) {
  const sourceRoot = path.join(resolved.workspaceDir, "src");
  return (filePath: string) =>
    filePath.startsWith(sourceRoot)
      ? path.join(context.options.srcDir, path.relative(sourceRoot, filePath))
      : filePath;
}

export function validateBuildShape(
  context: BuildContext,
  resolved: ResolvedBuild,
): BuildFailure | null {
  const outputType = resolveChunkOutputType({
    chunkMode: context.options.chunks.mode,
    languageOut: context.options.languageOut,
    outputType: context.options.chunks.outputType,
  });
  if (
    resolved.externalBoundaries.length > 0 &&
    context.options.chunks.mode !== "off"
  ) {
    return failedBuild([
      createBuildDiagnostic(
        "External runtime imports are supported only by the standalone basic build path in this phase.",
      ),
    ]);
  }
  if (resolved.externalBoundaries.length > 0 && outputType !== "esm") {
    return failedBuild([
      createBuildDiagnostic(
        'External runtime imports require ESM output. Set chunks.outputType to "esm".',
      ),
    ]);
  }
  if (resolved.preservedModules.length > 0 && outputType !== "esm") {
    return failedBuild([
      createBuildDiagnostic(
        'Preserved modules require ESM output. Set chunks.outputType to "esm".',
      ),
    ]);
  }
  if (
    context.options.chunks.mode !== "off" &&
    resolved.entryFiles.some(
      (entry) => entry.exportNames.length > 0 || entry.hasDefaultExport,
    )
  ) {
    return failedBuild([
      createBuildDiagnostic(
        "Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.",
      ),
    ]);
  }

  if (
    context.options.chunks.mode === "off" &&
    resolved.lazyImports.length > 0
  ) {
    return failedBuild([
      createBuildDiagnostic(
        'Dynamic import() requires chunks.mode = "bundler-runtime" or "split".',
      ),
    ]);
  }
  return null;
}

export async function collectEntryShebangs(
  entries: ResolvedBuild["entryFiles"],
) {
  const shebangs = await Promise.all(
    entries.map(async (entry) => {
      const source = await fs.readFile(entry.sourcePath, "utf8");
      const shebang = source.match(/^#![^\r\n]*/u)?.[0];
      return shebang ? { shebang, sourcePath: entry.sourcePath } : null;
    }),
  );
  return shebangs.filter(
    (entry): entry is { shebang: string; sourcePath: string } => entry !== null,
  );
}

export function writeBuildEntryShims(
  context: BuildContext,
  resolved: ResolvedBuild,
) {
  if (context.options.chunks.mode !== "off") {
    return;
  }
  writeEntryShims({
    entries: resolved.entryFiles.map((entry) => ({
      constEnumExportNames: entry.constEnumExportNames,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      importPath: toImportPath(
        path.relative(
          path.dirname(path.join(resolved.shimDir, `${entry.chunkName}.ts`)),
          entry.sourcePath,
        ),
      ),
      shimPath: path.join(resolved.shimDir, `${entry.chunkName}.ts`),
    })),
  });
}

export function failedBuild(
  diagnostics: readonly BuildDiagnostic[],
): BuildFailure {
  return { diagnostics, ok: false };
}
