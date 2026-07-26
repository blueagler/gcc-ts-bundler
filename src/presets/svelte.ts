import type { CompatClassMapCall } from "../api/types";
import type { ExternsProtocolHelpers } from "../externs";
import type { GccTsBundlerVitePluginOptions } from "../vite/types";

/**
 * Svelte 5 runtime knowledge for gcc-ts-bundler. The core compiler is
 * framework-agnostic; everything Svelte-specific lives here:
 *
 * - `set_class(node, kind, hash, next, prev, classMap)` receives a CSS
 *   class-map object whose keys must survive property renaming;
 * - `prop(props, "name", ...)` reads a component prop by string key;
 * - `rest_props(props, ["a", "b"])` / `legacy_rest_props` exclude prop keys
 *   reflectively, so listed names must not be renamed.
 */

export const SVELTE_CLASS_MAP_CALLS: readonly CompatClassMapCall[] = [
  { argIndex: 5, callee: "set_class" },
];

export const SVELTE_PROTOCOL_HELPERS: ExternsProtocolHelpers = {
  keyExclusionListCallees: ["legacy_rest_props", "rest_props"],
  keyReadCallees: ["prop"],
};

export interface SveltePresetOptions {
  /**
   * Extra packages whose public API crosses the compiled boundary (UI kits
   * such as `m3-svelte`). `svelte` itself is always included.
   */
  externModules?: readonly string[] | undefined;
}

/**
 * Vite plugin options preset for Svelte apps:
 *
 * ```ts
 * import { svelte } from "@sveltejs/vite-plugin-svelte";
 * import { gccTsBundler } from "gcc-ts-bundler/vite";
 * import { sveltePreset } from "gcc-ts-bundler/presets/svelte";
 *
 * export default defineConfig({
 *   plugins: [svelte(), gccTsBundler(sveltePreset())],
 * });
 * ```
 */
export function sveltePreset(
  options: SveltePresetOptions & GccTsBundlerVitePluginOptions = {},
): GccTsBundlerVitePluginOptions {
  const { externModules, ...overrides } = options;
  return {
    ...overrides,
    compiler: {
      ...overrides.compiler,
      compat: {
        ...overrides.compiler?.compat,
        classMapCalls: [
          ...SVELTE_CLASS_MAP_CALLS,
          ...(overrides.compiler?.compat?.classMapCalls ?? []),
        ],
      },
    },
    externs: {
      ...overrides.externs,
      generate: {
        mode: "runtime-aware",
        ...overrides.externs?.generate,
        modules: [
          "svelte",
          ...(externModules ?? []),
          ...(overrides.externs?.generate?.modules ?? []),
        ],
        protocolHelpers: {
          keyExclusionListCallees: [
            ...(SVELTE_PROTOCOL_HELPERS.keyExclusionListCallees ?? []),
            ...(overrides.externs?.generate?.protocolHelpers
              ?.keyExclusionListCallees ?? []),
          ],
          keyReadCallees: [
            ...(SVELTE_PROTOCOL_HELPERS.keyReadCallees ?? []),
            ...(overrides.externs?.generate?.protocolHelpers?.keyReadCallees ??
              []),
          ],
        },
      },
    },
  };
}
