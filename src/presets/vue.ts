import type { CompatClassMapCall } from "../api/types";
import type { GccTsBundlerVitePluginOptions } from "../vite/types";

/**
 * Vue 3 runtime knowledge for gcc-ts-bundler.
 *
 * DOM element vnode props are dispatched by literal key at runtime
 * (`patchProp` string switches, `isOn(key)` regex, `setAttribute`), so keys
 * on element vnode creations must survive renaming entirely. Component
 * vnode props stay renamable (Closure renames the creation site, the
 * component's `props` options, and accesses consistently) except for the
 * string-derived surfaces: `on*` handler keys built via `toHandlerKey`, and
 * the reserved vnode keys.
 */

const COMPONENT_VNODE_KEY_PATTERN =
  "^(?:on[A-Z$_].*|key|ref|ref_for|ref_key|class|style)$";

export const VUE_VNODE_PROPS_CALLS: readonly CompatClassMapCall[] = [
  { argIndex: 1, callee: "createElementVNode" },
  { argIndex: 1, callee: "createElementBlock" },
  {
    argIndex: 1,
    callee: "createVNode",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
  {
    argIndex: 1,
    callee: "createBlock",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
  { argIndex: 1, callee: "h", keyPattern: COMPONENT_VNODE_KEY_PATTERN },
  {
    argIndex: 0,
    callee: "mergeProps",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
  {
    argIndex: 1,
    callee: "mergeProps",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
  {
    argIndex: 2,
    callee: "mergeProps",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
  {
    argIndex: 3,
    callee: "mergeProps",
    keyPattern: COMPONENT_VNODE_KEY_PATTERN,
  },
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
