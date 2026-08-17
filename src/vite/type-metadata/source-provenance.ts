import type { CapturedRuntimeModule } from "../internal-types";
import type { RuntimeModuleTypeProvenance } from "./types";

const TYPESCRIPT_RUNTIME_EXTENSION = /\.(?:cts|mts|tsx?|svelte|vue)$/u;
const JAVASCRIPT_RUNTIME_EXTENSION = /\.(?:cjs|js|jsx|mjs)$/u;
const EXPLICIT_JSDOC_TYPE_SIGNAL =
  /(?:\/\/\s*@ts-check\b|\/\*\*[\s\S]*?@(type|param|returns?|template|typedef|implements|extends|satisfies)\b)/u;

export type TypeMetadataSourceEligibility =
  | "js-jsdoc"
  | "ts-runtime"
  | "untyped";

export function classifyTypeMetadataSource(
  moduleId: string,
  sourceText?: string,
): TypeMetadataSourceEligibility {
  const cleanId = moduleId.replace(/[?#].*$/u, "");
  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return "untyped";
  }
  if (TYPESCRIPT_RUNTIME_EXTENSION.test(cleanId)) {
    return "ts-runtime";
  }
  if (
    JAVASCRIPT_RUNTIME_EXTENSION.test(cleanId) &&
    sourceText !== undefined &&
    EXPLICIT_JSDOC_TYPE_SIGNAL.test(sourceText)
  ) {
    return "js-jsdoc";
  }
  return "untyped";
}

export function shouldBypassTypeMetadataFusion(
  module: Pick<CapturedRuntimeModule, "sourceModuleIds">,
) {
  const sourceModuleId = module.sourceModuleIds[0];
  return (
    module.sourceModuleIds.length === 1 &&
    sourceModuleId !== undefined &&
    classifyTypeMetadataSource(sourceModuleId) === "ts-runtime"
  );
}

export function withOneToOneTypeProvenance(
  module: CapturedRuntimeModule,
): CapturedRuntimeModule {
  const sourceModuleId = module.sourceModuleIds[0];
  if (module.sourceModuleIds.length !== 1 || sourceModuleId === undefined) {
    return module;
  }
  const sourceMappings = [sourceModuleId];
  const typeMetadata = {
    exportFacades: [],
    kind: "one-to-one",
    sourceMappings,
  } satisfies RuntimeModuleTypeProvenance;
  return { ...module, typeMetadata };
}
