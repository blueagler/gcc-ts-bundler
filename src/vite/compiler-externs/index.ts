import fs from "node:fs/promises";
import path from "node:path";

import { generateExterns } from "../../externs";
import { writeFileIfChanged } from "../../shared/files";
import { generateViteRuntimeAwareExterns } from "./runtime";
import type { MaterializedGraph } from "../internal-types";
import type { GccTsBundlerVitePluginOptions } from "../types";

export interface CompilerExternArtifacts {
  renameBarriers: string[];
  typedDeclarations: string[];
}

export async function resolveCompilerExterns(input: {
  captureRoot: string;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  /**
   * The graph Closure actually compiles. Dependency hazards must be read from
   * here: esbuild's class-field lowering is what *creates* the string-keyed
   * definitions (`__publicField(this, "name")`), so they do not exist yet in
   * the pre-prebundle graph. Kept as a promise so the app-side scans still run
   * concurrently with prebundling.
   */
  postPrebundleMaterialized: Promise<MaterializedGraph>;
  projectRoot: string;
}) {
  const explicitExterns = [...(input.options.compiler?.externs ?? [])].map(
    (filePath) => path.resolve(input.projectRoot, filePath),
  );
  const explicitTypedExterns = [
    ...(input.options.compiler?.typedExterns ?? []),
  ].map((filePath) => path.resolve(input.projectRoot, filePath));
  const generateOptions = input.options.externs?.generate;
  if (!generateOptions) {
    return {
      renameBarriers: explicitExterns,
      typedDeclarations: explicitTypedExterns,
    } satisfies CompilerExternArtifacts;
  }

  const generatedExternFile = path.resolve(
    input.projectRoot,
    generateOptions.outputFile ??
      path.join(input.captureRoot, "generated.externs.js"),
  );

  const protocolHelpers = {
    keyExclusionListCallees: [
      ...(generateOptions.protocolHelpers?.keyExclusionListCallees ?? []),
    ],
    keyReadCallees: [
      ...(generateOptions.protocolHelpers?.keyReadCallees ?? []),
    ],
  };
  if ((generateOptions.mode ?? "runtime-aware") === "runtime-aware") {
    await generateViteRuntimeAwareExterns({
      captureRoot: input.captureRoot,
      generatedExternFile,
      materialized: input.materialized,
      modules: [...generateOptions.modules],
      options: input.options,
      postPrebundleMaterialized: input.postPrebundleMaterialized,
      projectRoot: input.projectRoot,
      protocolHelpers,
    });
  } else {
    const result = await generateExterns({
      appEntryFiles: input.materialized.entries,
      includeDependencies: generateOptions.includeDependencies,
      mode: generateOptions.mode ?? "runtime-aware",
      modules: [...generateOptions.modules],
      outputFile: generatedExternFile,
      projectRoot: input.projectRoot,
      protocolHelpers,
      runtimeEntryFiles: input.materialized.runtimeEntries,
      srcDir: input.materialized.srcDir,
    });
    for (const warning of result.barrierWarnings) {
      console.warn(`gcc-ts-bundler: ${warning.message}`);
    }
    if (result.typedDeclarations.moduleExports.length > 0) {
      throw new Error(
        "Vite-generated external-runtime declarations require a compiled runtime bridge, which the Vite integration does not provide. Generate them separately and add the declaration file through compiler.typedExterns only after supplying that bridge.",
      );
    }
  }

  const appendLines = generateOptions.appendLines ?? [];
  if (appendLines.length > 0) {
    const currentText = await fs.readFile(generatedExternFile, "utf8");
    const appendedText = `${currentText.replace(/\s*$/u, "\n")}${appendLines.join("\n")}\n`;
    await writeFileIfChanged(generatedExternFile, appendedText);
  }

  return {
    renameBarriers: [...new Set([...explicitExterns, generatedExternFile])],
    typedDeclarations: [...new Set(explicitTypedExterns)],
  } satisfies CompilerExternArtifacts;
}
