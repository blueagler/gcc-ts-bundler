import type { CompilerOptions } from "@typescript/typescript6";

import { defineValues } from "./shared/validation";

export const TARGET_NAMES = defineValues(
  "browser",
  "node",
  "bun",
  "workerd",
  "webworker",
);
export type TargetName = (typeof TARGET_NAMES)[number];

export type BuiltinPolicy = "reject" | "external-boundary";
export type TargetEnvelope = "browser" | "server" | "worker";

/**
 * One target contract feeds declaration resolution and native package policy.
 * Browser remains the default row so callers that do not opt in keep byte-for-byte
 * historical resolution behavior.
 */
export interface TargetDescriptor {
  ambientDeclarationRoots: readonly string[];
  builtinPolicy: BuiltinPolicy;
  /** Release ranking. Debug inserts `development` after the first condition. */
  exportConditions: readonly string[];
  envelope: TargetEnvelope;
  name: TargetName;
}

export const TARGET_DESCRIPTORS: ReadonlyMap<TargetName, TargetDescriptor> =
  new Map([
    [
      "browser",
      {
        ambientDeclarationRoots: [],
        builtinPolicy: "reject",
        exportConditions: ["browser", "production", "import", "default"],
        envelope: "browser",
        name: "browser",
      },
    ],
    [
      "node",
      {
        ambientDeclarationRoots: ["@types/node"],
        builtinPolicy: "external-boundary",
        exportConditions: [
          "node",
          "production",
          "import",
          "require",
          "default",
        ],
        envelope: "server",
        name: "node",
      },
    ],
    [
      "bun",
      {
        ambientDeclarationRoots: ["bun-types"],
        builtinPolicy: "external-boundary",
        exportConditions: [
          "bun",
          "node",
          "production",
          "import",
          "require",
          "default",
        ],
        envelope: "server",
        name: "bun",
      },
    ],
    [
      "workerd",
      {
        ambientDeclarationRoots: ["@cloudflare/workers-types"],
        builtinPolicy: "reject",
        exportConditions: [
          "workerd",
          "worker",
          "browser",
          "production",
          "import",
          "default",
        ],
        envelope: "worker",
        name: "workerd",
      },
    ],
    [
      "webworker",
      {
        ambientDeclarationRoots: ["lib.webworker"],
        builtinPolicy: "reject",
        exportConditions: [
          "worker",
          "browser",
          "production",
          "import",
          "default",
        ],
        envelope: "worker",
        name: "webworker",
      },
    ],
  ]);

export function getTargetDescriptor(target: TargetName = "browser") {
  const descriptor = TARGET_DESCRIPTORS.get(target);
  if (!descriptor) {
    throw new TypeError(`Unknown build target ${JSON.stringify(target)}.`);
  }
  return descriptor;
}

export function targetCompilerOptions(
  compilerOptions: CompilerOptions,
  target: TargetName,
): CompilerOptions {
  // Retaining the same object for browser makes the historical resolver path
  // observable and prevents an opt-out target mode from perturbing it.
  if (target === "browser") return compilerOptions;
  const descriptor = getTargetDescriptor(target);
  return {
    ...compilerOptions,
    customConditions: [
      ...new Set([
        ...(compilerOptions.customConditions ?? []),
        ...descriptor.exportConditions,
      ]),
    ],
  };
}
