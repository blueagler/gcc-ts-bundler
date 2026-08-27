import fs from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";

import {
  JAVASCRIPT_OUTPUT_FILE,
  minifyFinalJavaScriptText,
} from "../../build/closure/final-minify";
import { dynamicImportSpecifier } from "../../shared/typescript";
import type { OutputChunk } from "../internal-types";
import {
  rewritePreservedImportSpecifiers,
  staticModuleSpecifier,
} from "../output/rewrite";
import { applyFileRenames, relativeSpecifier } from "./helpers";

/**
 * Rewrites relative chunk specifiers after a rename. Must observe POST-minify
 * text: final minification re-quotes strings with backticks, and the runtime
 * manifest's chunk urls are ordinary strings inside the base chunk. Miss that
 * spelling and a renamed lazy chunk keeps a url that no longer exists.
 */
function rewriteCompiledChunkIdentitiesInText(input: {
  code: string;
  newName: string;
  oldName: string;
  renameMap: Map<string, string>;
}) {
  let source = input.code;
  for (const [oldTarget, newTarget] of input.renameMap) {
    const oldSpecifier = relativeSpecifier(input.oldName, oldTarget);
    const newSpecifier = relativeSpecifier(input.newName, newTarget);
    for (const candidate of [
      oldSpecifier,
      oldSpecifier.replace(/^\.\//u, ""),
    ]) {
      source = source.replaceAll(
        JSON.stringify(candidate),
        JSON.stringify(newSpecifier),
      );
      source = source.replaceAll(`'${candidate}'`, `'${newSpecifier}'`);
      // Final minification re-quotes with backticks, and the runtime
      // manifest's chunk urls are ordinary strings inside the base chunk:
      // miss this spelling and a renamed lazy chunk keeps a url that no
      // longer exists.
      source = source.replaceAll(`\`${candidate}\``, `\`${newSpecifier}\``);
    }
  }
  return source;
}

export async function rewriteAndRenameCompiledFiles(
  outDir: string,
  outputFiles: string[],
  renameMap: Map<string, string>,
) {
  await Promise.all(
    outputFiles
      .filter((filePath) => JAVASCRIPT_OUTPUT_FILE.test(filePath))
      .map(async (outputFile) => {
        const oldName = path.relative(outDir, outputFile).replace(/\\/g, "/");
        const newName = renameMap.get(oldName) ?? oldName;
        const source = await fs.readFile(outputFile, "utf8");
        const isJs = outputFile.endsWith(".js");
        const afterPreserved = isJs
          ? rewritePreservedImportSpecifiers({
              code: source,
              filePath: outputFile,
              outDir,
            })
          : source;
        const minified = minifyFinalJavaScriptText(outputFile, afterPreserved);
        const afterIdentities = isJs
          ? rewriteCompiledChunkIdentitiesInText({
              code: minified,
              newName,
              oldName,
              renameMap,
            })
          : minified;
        await fs.writeFile(outputFile, afterIdentities, "utf8");
      }),
  );
  await applyFileRenames(outDir, renameMap);
}

export function applyChunkMetadata(chunk: OutputChunk) {
  const sourceFile = ts.createSourceFile(
    chunk.fileName,
    chunk.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = new Set<string>();
  const dynamicImports = new Set<string>();
  const visit = (node: ts.Node) => {
    const literal = staticModuleSpecifier(node);
    if (literal?.text.startsWith(".")) {
      imports.add(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(chunk.fileName), literal.text),
        ),
      );
    }
    const imported = dynamicImportSpecifier(node);
    if (imported?.startsWith(".")) {
      dynamicImports.add(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(chunk.fileName), imported),
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  chunk.imports = [...imports].sort();
  chunk.dynamicImports = [...dynamicImports].sort();
}
