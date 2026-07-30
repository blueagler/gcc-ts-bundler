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

/**
 * plugin-vue attaches options a template-only SFC cannot carry in `setup` -
 * `render`, `__scopeId` - through its export helper:
 *
 * ```js
 * export default _export_sfc(_sfc_main, [["render", _sfc_render], ["__scopeId", "data-v-…"]]);
 * ```
 *
 * The helper's body is `target[key] = value`, so the *definition* goes through
 * the string while the Vue runtime reads `component.render` as a dot property.
 * Under ADVANCED the dot side renames and the string side cannot, so the
 * component silently loses its render function: it mounts and produces nothing.
 * `<script setup>` SFCs never hit this because their render is inlined into
 * setup; template-only SFCs (a plain `<template>` with no script, and every
 * vapor slot child that shape produces) do. Measured in the vapor example:
 * 890 rendered characters instead of 8912, no console or page error
 * (report: /tmp/gcc-e1-examples.md).
 *
 * The rule is call-shape evidence, not a name list: whatever key strings the
 * helper is given are the keys that must survive, and the callee is resolved by
 * import identity because `_export_sfc` is a local alias for a virtual module's
 * default export.
 */
export const VUE_SFC_EXPORT_HELPER_CALLS: readonly CompatClassMapCall[] = [
  {
    argIndex: 1,
    callee: "default",
    calleeModulePattern: "plugin-vue[:-]export-helper",
    keySource: "pairArray",
  },
];

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
          ...VUE_SFC_EXPORT_HELPER_CALLS,
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
