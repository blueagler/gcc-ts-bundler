import type { CompatClassMapCall } from "../api/types";
import type { GccTsBundlerVitePluginOptions } from "../vite/types";

/**
 * React runtime knowledge for gcc-ts-bundler.
 *
 * Element factories (`React.createElement`, the automatic-runtime `jsx`
 * family) receive props as an object literal. For **host** elements — the
 * ones whose type is a string literal, `createElement("button", {...})` —
 * React's DOM renderer walks those keys as runtime strings: it compares
 * `propKey` against `"children"`, `"style"`, `"dangerouslySetInnerHTML"`,
 * and resolves event handlers through the registration-name tables. Renamed
 * keys therefore stop matching and every handler silently goes dead, with a
 * clean build and an empty console.
 *
 * **Component** elements are the opposite case: the creation site and the
 * component body that reads `props.foo` rename together, so quoting them
 * would only block optimization. Only `key` and `ref` are read reflectively
 * by React itself.
 */

/**
 * `children` is excluded deliberately: React reads it with dot access
 * (`nextProps.children` in the reconciler), so it renames consistently with
 * an unquoted creation site and quoting it strands the subtree. Same for
 * `key`/`ref` under the classic runtime, where `createElement` reads
 * `config.key` / `config.ref` with dot access inside the compilation unit.
 */
const HOST_ELEMENT_EXCLUDED_KEYS = "^(?:children|key|ref)$";

/** Factories whose first argument is the element type. */
const ELEMENT_FACTORIES = ["createElement", "jsx", "jsxs", "jsxDEV"] as const;

const hostPropsRule = (callee: string): CompatClassMapCall => ({
  argIndex: 1,
  callee,
  keyExcludePattern: HOST_ELEMENT_EXCLUDED_KEYS,
  stringLiteralArgIndex: 0,
});

export const REACT_ELEMENT_PROPS_CALLS: readonly CompatClassMapCall[] = [
  ...ELEMENT_FACTORIES.map(hostPropsRule),
  // cloneElement receives an element value rather than a tag. The generic
  // literal-contract analysis follows immutable results from the configured
  // factories above, so only clones proven to remain host elements qualify.
  hostPropsRule("cloneElement"),
];

export interface ReactPresetOptions {
  /**
   * Extra packages whose public API crosses the compiled boundary (UI kits,
   * router libraries). `react` and `react-dom` are always included.
   */
  externModules?: readonly string[] | undefined;
}

/**
 * Vite plugin options preset for React apps:
 *
 * ```ts
 * import react from "@vitejs/plugin-react";
 * import { gccTsBundler } from "gcc-ts-bundler/vite";
 * import { reactPreset } from "gcc-ts-bundler/presets/react";
 *
 * export default defineConfig({
 *   plugins: [react(), gccTsBundler(reactPreset())],
 * });
 * ```
 *
 * Standalone builds use the same knowledge through the compat option:
 *
 * ```ts
 * build({ compat: { classMapCalls: [...REACT_ELEMENT_PROPS_CALLS] }, ... });
 * ```
 */
export function reactPreset(
  options: ReactPresetOptions & GccTsBundlerVitePluginOptions = {},
): GccTsBundlerVitePluginOptions {
  const { externModules, ...overrides } = options;
  return {
    ...overrides,
    compiler: {
      ...overrides.compiler,
      compat: {
        ...overrides.compiler?.compat,
        classMapCalls: [
          ...REACT_ELEMENT_PROPS_CALLS,
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
          "react",
          "react-dom",
          ...(externModules ?? []),
          ...(overrides.externs?.generate?.modules ?? []),
        ],
      },
    },
  };
}
