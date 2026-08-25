import fs from "fs/promises";

import type { ResolvedBuildOptions } from "../../build/types";
import { generateExterns } from "../index";
import { isPlatformBuiltin } from "../compiler";
import type { TypeWorld } from "../context";
import { renderTypedBoundaryDeclaration } from "../typed-render";

type GeneratedExternalExterns = Awaited<ReturnType<typeof generateExterns>>;

export interface ExternalExternPlan {
  opaqueSpecifiers: string[];
  typedResolutions: Array<{
    generated: GeneratedExternalExterns;
    specifier: string;
  }>;
}

export async function deriveExternalExternPlan(input: {
  options: ResolvedBuildOptions;
  specifiers: string[];
  typeWorld: TypeWorld;
}): Promise<ExternalExternPlan> {
  const specifiers = [...new Set(input.specifiers)]
    .filter((specifier) => !isPlatformBuiltin(specifier))
    .sort((left, right) => left.localeCompare(right));
  if (specifiers.length === 0) {
    return { opaqueSpecifiers: [], typedResolutions: [] };
  }

  const opaqueSpecifiers: string[] = [];
  const typedResolutions: ExternalExternPlan["typedResolutions"] = [];
  try {
    const generated = await generateExterns({
      appEntryFiles: input.options.entries.map((entry) => entry.file),
      includeDependencies: false,
      mode: "boundary-aware",
      modules: specifiers.map((specifier) => ({
        exports: "used",
        runtime: "external",
        specifier,
      })),
      projectRoot: input.options.projectRoot,
      srcDir: input.options.srcDir,
      target: input.options.target,
      typeWorld: input.typeWorld,
    });
    for (const specifier of specifiers) {
      if (
        !generated.typedDeclarations.moduleExports.some(
          (module) => module.specifier === specifier,
        )
      ) {
        opaqueSpecifiers.push(specifier);
        console.warn(
          `gcc-ts-bundler: using opaque externs for external module ${JSON.stringify(specifier)} because declarations could not be resolved: no declaration module surface was produced`,
        );
      } else {
        typedResolutions.push({ generated, specifier });
      }
    }
    for (const warning of generated.warnings) {
      console.warn(`gcc-ts-bundler: ${warning}`);
    }
    for (const warning of generated.barrierWarnings) {
      console.warn(`gcc-ts-bundler: ${warning.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const specifier of specifiers) {
      opaqueSpecifiers.push(specifier);
      console.warn(
        `gcc-ts-bundler: using opaque externs for external module ${JSON.stringify(specifier)} because declarations could not be resolved: ${message}`,
      );
    }
  }
  return { opaqueSpecifiers, typedResolutions };
}

export async function appendExternalTypedExterns(input: {
  externsPath: string;
  imports: Array<{
    boundaryExports: string[];
    boundaryNames: string[];
    externalSpecifier?: string | undefined;
  }>;
  typedResolutions: ExternalExternPlan["typedResolutions"];
}) {
  const typedTexts = input.typedResolutions.map(({ generated, specifier }) => {
    const moduleSurface = generated.typedDeclarations.moduleExports.find(
      (module) => module.specifier === specifier,
    );
    const boundaryLines = input.imports
      .filter((item) => item.externalSpecifier === specifier)
      .flatMap((item) =>
        item.boundaryExports.flatMap((exportName, index) => {
          const boundaryName = item.boundaryNames[index];
          if (!boundaryName || !moduleSurface) return [];
          if (exportName === "*") {
            return moduleSurface.exports
              .filter(({ exportName: name }) =>
                /^[$A-Z_a-z][$\w]*$/u.test(name),
              )
              .flatMap((exported) =>
                renderTypedBoundaryDeclaration(
                  generated.typedDeclarations.text,
                  exported.qualifiedName,
                  `${boundaryName}.${exported.exportName}`,
                  false,
                ),
              );
          }
          const exported = moduleSurface.exports.find(
            (item) => item.exportName === exportName,
          );
          return exported
            ? renderTypedBoundaryDeclaration(
                generated.typedDeclarations.text,
                exported.qualifiedName,
                boundaryName,
              )
            : [];
        }),
      );
    return `${generated.typedDeclarations.text}\n// Exact typed external boundaries.\n${boundaryLines.join("\n")}\n`;
  });
  if (typedTexts.length > 0) {
    await fs.appendFile(
      input.externsPath,
      `\n// Typed external runtime declarations.\n${typedTexts.join("\n")}`,
      "utf8",
    );
  }
}
