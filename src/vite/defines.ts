import { isString } from "../shared/validation";
import { loadEsbuildModule } from "./prebundle/esbuild";

type DefineValue =
  | string
  | number
  | boolean
  | null
  | DefineValue[]
  | { [key: string]: DefineValue };

type DefineValues = Record<string, DefineValue>;
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
  define: DefineValues | undefined,
  env: DefineValues | undefined,
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
      isString(value) ? value : JSON.stringify(value),
    ]),
  );
  // Probe the full define key so dotted identifiers such as `import.meta.env`
  // do not match every ESM module that merely contains `import`.
  const probes = entries.map(([key]) => key);

  return async function applyDefines(
    code: string,
    format: "cjs" | "esm" = "esm",
  ): Promise<string> {
    if (!probes.some((probe) => code.includes(probe))) {
      return code;
    }
    const transform = (await loadEsbuildModule()).transform;
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
