import type { CompatClassMapCall } from "../api/types";
import type { GccTsBundlerVitePluginOptions } from "../vite/types";

/**
 * Vue 3 runtime knowledge for gcc-ts-bundler. The Vue runtime dispatches on
 * vnode prop keys reflectively (`isOn(key)`, prop/attr fallthrough,
 * `toHandlerKey` string building), so keys of vnode props objects must
 * survive property renaming. Quoting them at the vnode creation calls keeps
 * the rest of the program fully renamable.
 */

export const VUE_VNODE_PROPS_CALLS: readonly CompatClassMapCall[] = [
  { argIndex: 1, callee: "createVNode" },
  { argIndex: 1, callee: "createElementVNode" },
  { argIndex: 1, callee: "createBlock" },
  { argIndex: 1, callee: "createElementBlock" },
  { argIndex: 1, callee: "h" },
  { argIndex: 0, callee: "mergeProps" },
  { argIndex: 1, callee: "mergeProps" },
  { argIndex: 2, callee: "mergeProps" },
  { argIndex: 3, callee: "mergeProps" },
];

export interface VuePresetOptions {
  /**
   * Extra packages whose public API crosses the compiled boundary (UI kits).
   * `vue` itself is always included.
   */
  externModules?: readonly string[] | undefined;
}

/**
 * Vite plugin options preset for Vue apps:
 *
 * ```ts
 * import vue from "@vitejs/plugin-vue";
 * import { gccTsBundler } from "gcc-ts-bundler/vite";
 * import { vuePreset } from "gcc-ts-bundler/presets/vue";
 *
 * export default defineConfig({
 *   plugins: [vue(), gccTsBundler(vuePreset())],
 * });
 * ```
 */
export function vuePreset(
  options: VuePresetOptions & GccTsBundlerVitePluginOptions = {},
): GccTsBundlerVitePluginOptions {
  const { externModules, ...overrides } = options;
  return {
    ...overrides,
    compiler: {
      ...overrides.compiler,
      compat: {
        ...overrides.compiler?.compat,
        classMapCalls: [
          ...VUE_VNODE_PROPS_CALLS,
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
          "vue",
          ...(externModules ?? []),
          ...(overrides.externs?.generate?.modules ?? []),
        ],
      },
    },
  };
}
