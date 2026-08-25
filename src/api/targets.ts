import type { CompilerOptions } from "@typescript/typescript6";

import { defineValues } from "../shared/validation";

export const TARGET_NAMES = defineValues(
  "browser",
  "node",
  "bun",
  "workerd",
  "webworker",
);
export type TargetName = (typeof TARGET_NAMES)[number];

/**
 * One target contract feeds declaration resolution.
 * Browser remains the default row so callers that do not opt in keep byte-for-byte
 * historical resolution behavior.
 */
interface TargetDescriptor {
  ambientDeclarationRoots: readonly string[];
  /** Release ranking. Debug inserts `development` after the first condition. */
  exportConditions: readonly string[];
}

const TARGET_DESCRIPTORS: ReadonlyMap<TargetName, TargetDescriptor> = new Map([
  [
    "browser",
    {
      ambientDeclarationRoots: [],
      exportConditions: ["browser", "production", "import", "default"],
    },
  ],
  [
    "node",
    {
      ambientDeclarationRoots: ["@types/node"],
      exportConditions: ["node", "production", "import", "require", "default"],
    },
  ],
  [
    "bun",
    {
      ambientDeclarationRoots: ["bun-types"],
      exportConditions: [
        "bun",
        "node",
        "production",
        "import",
        "require",
        "default",
      ],
    },
  ],
  [
    "workerd",
    {
      ambientDeclarationRoots: ["@cloudflare/workers-types"],
      exportConditions: [
        "workerd",
        "worker",
        "browser",
        "production",
        "import",
        "default",
      ],
    },
  ],
  [
    "webworker",
    {
      ambientDeclarationRoots: ["lib.webworker"],
      exportConditions: [
        "worker",
        "browser",
        "production",
        "import",
        "default",
      ],
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
