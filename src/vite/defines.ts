import { transformWithOxc, type OxcOptions } from "vite";

/**
 * Apply the host's final native define table to code captured before Rolldown
 * substitutes it. Keeping the same define engine preserves lexical shadowing,
 * optional member access, object values, and Vite's wildcard env fallback.
 */
export function createDefineApplier(define: OxcOptions["define"]) {
  if (!define || Object.keys(define).length === 0) {
    return null;
  }

  return async function applyDefines(
    code: string,
    fileName: string,
    format: "cjs" | "esm",
  ): Promise<string> {
    const result = await transformWithOxc(code, fileName, {
      ["define"]: define,
      ["lang"]: "js",
      ["sourceType"]: format === "cjs" ? "commonjs" : "module",
      // Substitution only: no tsconfig lookup, helper imports or lowering.
      ["target"]: "esnext",
      ["tsconfig"]: false,
      ["sourcemap"]: false,
    });
    return result["code"];
  };
}
