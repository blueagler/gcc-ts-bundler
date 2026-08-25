import fs from "node:fs/promises";

import type { MaterializedGraph } from "../../internal-types";
import { createBarrelFlattener } from "../barrels";
import { normalizePath } from "../shared";
import { rewriteModuleImports } from "./rewrite-module";

export async function rewriteDirectEsmImports(input: {
  directDependencyFilePaths: Set<string>;
  materialized: MaterializedGraph;
  prebundleFilePaths: Set<string>;
}) {
  const moduleByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      module,
    ]),
  );
  const flattener = createBarrelFlattener({
    moduleFilePaths: new Set(moduleByFilePath.keys()),
  });

  await Promise.all(
    input.materialized.modules
      .filter((module) => {
        const filePath = normalizePath(module.filePath);
        return (
          input.materialized.authoredFiles.includes(module.filePath) ||
          input.directDependencyFilePaths.has(filePath)
        );
      })
      .map(async (module) => {
        const filePath = normalizePath(module.filePath);
        const sourceText = await fs.readFile(module.filePath, "utf8");
        const rewritten = await rewriteModuleImports({
          // Only a direct dependency module keeps its own import statements in
          // the native graph; an authored module has its atom specifiers
          // rewritten later against its region bundle instead.
          atomFilePaths: input.directDependencyFilePaths.has(filePath)
            ? input.prebundleFilePaths
            : new Set<string>(),
          directDependencyFilePaths: input.directDependencyFilePaths,
          filePath,
          flattener,
          moduleByFilePath,
          sourceText,
        });
        if (rewritten !== sourceText) {
          await fs.writeFile(module.filePath, rewritten, "utf8");
        }
      }),
  );
}
