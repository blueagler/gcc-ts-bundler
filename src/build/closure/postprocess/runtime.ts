/**
 * Script-mode chunks reference Closure's `--rename_prefix_namespace` symbols
 * through `$gcc`; every wrapped chunk shares the object via `globalThis`.
 *
 * This is the only bundler-runtime output rewrite left. The alias
 * canonicalisation that used to run beside it ran `String.replaceAll` over
 * minified JavaScript and rewrote string literals and unrelated property
 * accesses along with the aliases it was aiming at (`"tab.js"` -> `"taG.js"`,
 * `o.b.c` -> `o.G.c`). It only ever fired for the post-Closure ES5 helper bag,
 * which no longer exists: helper pooling happens before Closure, so no chunk
 * grows a second runtime-root alias to collapse.
 */
export function wrapBundlerRuntimeOutputFile(code: string) {
  const trimmed = code.trimEnd();
  return `!function(){\nvar $gcc=globalThis.$gcc=globalThis.$gcc||{};\n${trimmed}\n}();\n`;
}
