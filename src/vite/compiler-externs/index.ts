import fs from "node:fs/promises";
import path from "node:path";

import { generateExterns } from "../../externs";
import { resolvePropertyPolicy } from "../../externs/property-policy";
import { writeFileIfChanged } from "../../shared/files";
import { generateViteRuntimeAwareExterns } from "./runtime";
import type { MaterializedGraph } from "../internal-types";
import type {
  GccTsBundlerGeneratedExternsOptions,
  GccTsBundlerVitePluginOptions,
} from "../types";

export interface CompilerExternArtifacts {
  renameBarriers: string[];
  typedDeclarations: string[];
}

/** Resolve caller-supplied extern paths against the project root, in order. */
function resolveExplicitExternFiles(
  filePaths: readonly string[] | undefined,
  projectRoot: string,
) {
  const resolved: string[] = [];
  for (const filePath of filePaths ?? []) {
    resolved.push(path.resolve(projectRoot, filePath));
  }
  return resolved;
}

/**
 * Write the generated extern file, either through the Vite runtime-aware
 * path (the default) or the generic `generateExterns` path.
 *
 * The generic path still rejects typed external-runtime declarations: Vite
 * does not supply the compiled runtime bridge those declarations require.
 */
async function writeGeneratedExternFile(input: {
  captureRoot: string;
  generatedExternFile: string;
  generateOptions: GccTsBundlerGeneratedExternsOptions;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  postPrebundleMaterialized: Promise<MaterializedGraph>;
  projectRoot: string;
}) {
  const protocolHelpers = {
    keyExclusionListCallees: [
      ...(input.generateOptions.protocolHelpers?.keyExclusionListCallees ?? []),
    ],
    keyReadCallees: [
      ...(input.generateOptions.protocolHelpers?.keyReadCallees ?? []),
    ],
  };
  const propertyPolicy = resolvePropertyPolicy(
    input.generateOptions.propertyPolicy,
  );
  if ((input.generateOptions.mode ?? "runtime-aware") === "runtime-aware") {
    await generateViteRuntimeAwareExterns({
      captureRoot: input.captureRoot,
      generatedExternFile: input.generatedExternFile,
      modules: [...input.generateOptions.modules],
      options: input.options,
      postPrebundleMaterialized: input.postPrebundleMaterialized,
      propertyPolicy,
      protocolHelpers,
    });
    return;
  }
  const result = await generateExterns({
    appEntryFiles: input.materialized.entries,
    includeDependencies: input.generateOptions.includeDependencies,
    mode: input.generateOptions.mode ?? "runtime-aware",
    modules: [...input.generateOptions.modules],
    outputFile: input.generatedExternFile,
    projectRoot: input.projectRoot,
    propertyPolicy,
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

/**
 * Append caller-supplied lines to a generated extern file, skipping the write
 * when the file already ends with that suffix.
 */
async function appendGeneratedExternLines(
  generatedExternFile: string,
  appendLines: readonly string[],
) {
  if (appendLines.length === 0) {
    return;
  }
  const currentText = await fs.readFile(generatedExternFile, "utf8");
  await writeFileIfChanged(
    generatedExternFile,
    applyGeneratedExternAppendLines(currentText, appendLines),
  );
}

export async function resolveCompilerExterns(input: {
  captureRoot: string;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  /**
   * The graph Closure actually compiles. Every extern scan waits for this:
   * esbuild's class-field lowering is what *creates* the string-keyed
   * definitions (`__publicField(this, "name")`), and prebundling rewrites
   * authored files in place, so a scan overlapping it is not a pure function
   * of the graph. Kept as a promise so the caller can start prebundling
   * without waiting for this function to be entered.
   */
  postPrebundleMaterialized: Promise<MaterializedGraph>;
  projectRoot: string;
}) {
  const explicitExterns = resolveExplicitExternFiles(
    input.options.compiler?.externs,
    input.projectRoot,
  );
  const explicitTypedExterns = resolveExplicitExternFiles(
    input.options.compiler?.typedExterns,
    input.projectRoot,
  );
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

  await writeGeneratedExternFile({
    captureRoot: input.captureRoot,
    generatedExternFile,
    generateOptions,
    materialized: input.materialized,
    options: input.options,
    postPrebundleMaterialized: input.postPrebundleMaterialized,
    projectRoot: input.projectRoot,
  });

  await appendGeneratedExternLines(
    generatedExternFile,
    generateOptions.appendLines ?? [],
  );

  return {
    renameBarriers: [...new Set([...explicitExterns, generatedExternFile])],
    typedDeclarations: [...new Set(explicitTypedExterns)],
  } satisfies CompilerExternArtifacts;
}

function applyGeneratedExternAppendLines(
  currentText: string,
  appendLines: readonly string[],
) {
  const suffix = appendLines.join("\n");
  const base = currentText.replace(/\s*$/u, "");
  if (base.endsWith(suffix)) {
    return `${base}\n`;
  }
  return `${base}\n${suffix}\n`;
}
