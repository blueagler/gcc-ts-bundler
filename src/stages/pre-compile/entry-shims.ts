import path from "path";

import { BuildEntry } from "../../api/types";
import { writeFileContent } from "../../utils/file-operations";

export async function writeEntryShims({
  entries,
  shimDir,
}: {
  entries: BuildEntry[];
  shimDir: string;
}): Promise<string[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const shimPath = path.join(shimDir, `${entry.chunkName}.ts`);
      const importPath = toImportPath(
        path.relative(path.dirname(shimPath), entry.sourcePath),
      );
      const contents = createEntryShimSource({
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        importPath,
      });
      await writeFileContent(shimPath, contents);
      return shimPath;
    }),
  );
}

function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function createEntryShimSource({
  exportNames,
  hasDefaultExport,
  importPath,
}: {
  exportNames: string[];
  hasDefaultExport: boolean;
  importPath: string;
}) {
  if (!hasDefaultExport && exportNames.length === 0) {
    return `import __entry = require(${JSON.stringify(importPath)});\nvoid __entry;\n`;
  }

  const lines = [
    `import __entry = require(${JSON.stringify(importPath)});`,
    "",
    '((globalThis as Record<string, unknown>)["GCC"] =',
    '  (globalThis as Record<string, unknown>)["GCC"] || {});',
  ];

  for (const exportName of exportNames) {
    lines.push(createGccAssignment(exportName, `__entry.${exportName}`));
  }

  if (hasDefaultExport) {
    lines.push(createGccAssignment("__DEFAULT_EXPORT__", "__entry.default"));
  }

  return `${lines.join("\n")}\n`;
}

function createGccAssignment(exportName: string, expression: string) {
  const property = `[${JSON.stringify(exportName)}]`;

  return `(((globalThis as Record<string, unknown>)["GCC"]) as Record<string, unknown>)${property} = ${expression};`;
}
