import { loadEsbuildTransform } from "./prebundle/esbuild";

/**
 * Applies Vite's resolved `define` replacements to captured module code.
 *
 * Vite (rolldown) substitutes `define` values while bundling, which is after
 * this plugin captures transformed modules, so framework feature flags that
 * ship as bare globals (`__VUE_OPTIONS_API__`, `__VUE_PROD_DEVTOOLS__`) and any
 * user `define` would otherwise survive into the Closure job as undeclared
 * variables. esbuild performs the same identifier-safe substitution Vite used
 * before rolldown, so the flags fold to constants and their dead branches drop.
 */
export function createDefineApplier(
  define: Record<string, unknown> | undefined,
  env: Record<string, unknown> | undefined,
) {
  const entries = [
    ...(env ? [["import.meta.env", env] as const] : []),
    ...Object.entries(define ?? {}),
  ].filter(([key]) => key.length > 0);
  if (entries.length === 0) {
    return null;
  }
  const esbuildDefine = Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  // The first segment is what appears verbatim in source for dotted keys such
  // as `process.env.NODE_ENV`, so it is the cheapest correct prefilter.
  const probes = entries.map(([key]) => key.split(".")[0] ?? key);

  return async function applyDefines(
    code: string,
    format: "cjs" | "esm" = "esm",
  ): Promise<string> {
    if (!probes.some((probe) => code.includes(probe))) {
      return code;
    }
    const transform = await loadEsbuildTransform();
    const result = await transform(code, {
      define: esbuildDefine,
      format,
      loader: "js",
      logLevel: "silent",
      // Substitution only: no syntax lowering, no minification.
      target: "esnext",
    });
    return result.code;
  };
}
