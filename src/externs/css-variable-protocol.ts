import fs from "fs";
import path from "path";

import ts from "@typescript/typescript6";

import { ModuleGraph } from "./css-protocol/graph";
import { buildModuleInfo } from "./css-protocol/module-info";
import type { ModuleInfo } from "./css-protocol/types";
import { getScriptKindForFile, isRuntimeExternPropertyName } from "./shared";

/**
 * The CSS custom-property protocol: member names that a stylesheet spells out.
 *
 * `@ant-design/cssinjs` turns a token object into CSS variables by enumerating
 * its keys and transliterating each one into a custom-property name:
 *
 * ```js
 * const token2CSSVar = (token, prefix = "") =>
 *   `--${prefix ? `${prefix}-` : ""}${token}`.replace(…).toLowerCase();
 * const transformToken = (token, themeKey, config) => {
 *   Object.entries(token).forEach(([key, value]) => { … token2CSSVar(key, prefix) … });
 * };
 * ```
 *
 * The keys are ordinary dot-defined literal keys spread across three packages,
 * so Closure renames them and the renamed spelling is what lands in the
 * stylesheet: `gap: var(--ant-button-e$)`. A renamed name is not merely ugly —
 * `$` is not valid in a CSS identifier, so the declaration is dropped by the
 * parser, and the `.toLowerCase()` above can collide two renamed keys that
 * differ only in case. A prerendered shell also hashes token *content*, so a
 * renamed key changes the hash and the client render stops matching the shell.
 *
 * No other evidence class reaches this: the enumeration happens on a
 * *parameter*, the names never appear as a string literal, and the object that
 * carries them is assembled by three packages of spreads, dot-writes and
 * higher-order calls. This class is that cross-module dataflow, kept narrow by
 * two things:
 *
 * 1. **The sink signature is the `--` literal head.** A key counts only when it
 *    flows into construction of a string whose literal text contains `--`,
 *    which is what makes it a custom-property *name* rather than a computed
 *    read (`pickAttrs`, `dequal`) or ordinary declaration text (`k:v;` in
 *    antd-style and watermark). No package names anywhere.
 * 2. **The taint is bounded.** Three upward hops, where a hop is one call-site
 *    expansion of a tainted parameter — the only step that fans out. Local
 *    slicing, import resolution and stepping into a resolved function to taint
 *    its `return` expressions do not fan out and are not counted, but carry
 *    their own depth limit.
 */
export interface CssVariableProtocolResult {
  /** Member names that become CSS custom-property names. */
  keyNames: Set<string>;
  /** `file:line` of every sink the scan proved, for reporting. */
  sinkSites: string[];
}

export async function analyzeCssVariableProtocol(
  filePaths: readonly string[],
): Promise<CssVariableProtocolResult> {
  const modules = new Map<string, ModuleInfo>();
  const parsed = await Promise.all(
    [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].map(
      async (filePath) => {
        const sourceText = await fs.promises.readFile(filePath, "utf8");
        return ts.createSourceFile(
          filePath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          getScriptKindForFile(filePath),
        );
      },
    ),
  );
  for (const sourceFile of parsed) {
    modules.set(sourceFile.fileName, buildModuleInfo(sourceFile));
  }
  const result = new ModuleGraph(modules).run();
  for (const sourceFile of parsed) {
    collectSelectorElementKeys(sourceFile, result.keyNames);
  }
  return result;
}

/**
 * Element-name keys in selector position of a style object.
 *
 * cssinjs `parseStyle` prints an identifier key whose value is an object as a
 * nested selector: antd's `svg: { … }` under `.anticon` emits `.anticon svg`.
 * Closure renames the key and the emitted rule selects nothing — and the
 * changed rule text shifts the cssinjs content hash, so a prerendered shell
 * no longer matches the client render (React #418).
 *
 * The evidence is local and shape-based. An object literal is style-shaped
 * when one of its keys is a string or template whose text carries selector
 * syntax (`&`, `.`, `:`, whitespace, `>`, `[`). Inside a style-shaped
 * literal, an identifier key with an object-literal value is a selector
 * element name — unless the value is the `_skip_check_`/`_multi_value_`
 * declaration wrapper, which parseStyle prints as a declaration.
 */
function collectSelectorElementKeys(
  sourceFile: ts.SourceFile,
  keyNames: Set<string>,
) {
  const selectorSyntax = /[&.:\s>[]/u;
  const isSelectorStyleObject = (candidate: ts.ObjectLiteralExpression) =>
    candidate.properties.some((member) => {
      if (!ts.isPropertyAssignment(member)) return false;
      if (ts.isStringLiteralLike(member.name)) {
        return selectorSyntax.test(member.name.text);
      }
      if (!ts.isComputedPropertyName(member.name)) return false;
      const expression = member.name.expression;
      return (
        ts.isTemplateExpression(expression) ||
        ts.isStringLiteralLike(expression)
      );
    });
  const isDeclarationWrapper = (candidate: ts.ObjectLiteralExpression) =>
    candidate.properties.some(
      (member) =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
        (member.name.text === "_skip_check_" ||
          member.name.text === "_multi_value_"),
    );
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && isSelectorStyleObject(node)) {
      for (const member of node.properties) {
        if (
          ts.isPropertyAssignment(member) &&
          ts.isIdentifier(member.name) &&
          ts.isObjectLiteralExpression(member.initializer) &&
          !isDeclarationWrapper(member.initializer) &&
          isRuntimeExternPropertyName(member.name.text)
        ) {
          keyNames.add(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
