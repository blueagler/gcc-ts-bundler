import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import ts from "typescript";
import type { ResolvedConfig } from "vite";
import type { OutputBundle, OutputChunk, PluginContext } from "rollup";

import { generateExterns } from "../api/build";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type {
  CapturedModule,
  CapturedRuntimeModule,
  MaterializedGraph,
} from "./internal-types";

const GCC_CAPTURE_DIR = ".gcc-ts-bundler-vite";

let cachedViteEsbuildTransform: Promise<
  (
    code: string,
    filename: string,
    options: Record<string, unknown>,
  ) => Promise<{ code: string }>
> | null = null;

export async function prepareCaptureRoot(input: {
  debugDir?: string;
  projectRoot: string;
}) {
  const targetDir = path.resolve(
    input.projectRoot,
    input.debugDir ??
      path.join(
        GCC_CAPTURE_DIR,
        createHash("sha256")
          .update(`${input.projectRoot}:${Date.now()}`)
          .digest("hex")
          .slice(0, 12),
      ),
  );
  await fs.rm(targetDir, { force: true, recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  return targetDir;
}

export function shouldCaptureModule(id: string, code: string) {
  if (id.startsWith("\0") || id.startsWith("virtual:")) {
    return true;
  }

  const cleanId = stripQuery(id);
  if (/\.(?:[cm]?[jt]sx?|mjs|cjs|svelte|vue)$/u.test(cleanId)) {
    return true;
  }

  return /\b(?:import|export)\b/u.test(code);
}

export async function normalizeCapturedCode(id: string, code: string) {
  let nextCode = code;

  if (needsClosureCompatibilityDownlevel(nextCode)) {
    const transformWithEsbuild = await loadViteEsbuildTransform();
    const result = await transformWithEsbuild(nextCode, stripQuery(id), {
      format: "esm",
      loader: resolveEsbuildLoader(id),
      sourcemap: false,
      target: "es2018",
    });
    nextCode = result.code;
  }

  if (needsTypeScriptCompatibilityDownlevel(nextCode)) {
    nextCode = ts.transpileModule(nextCode, {
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        importHelpers: false,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
        target: ts.ScriptTarget.ES5,
        useDefineForClassFields: false,
      },
      fileName: stripQuery(id),
      reportDiagnostics: false,
    }).outputText;
  }

  return nextCode;
}

export function resolveEntryModuleIds(
  bundle: OutputBundle,
  chunks: OutputChunk[],
) {
  const chunkByFileName = new Map(
    chunks.map((chunk) => [chunk.fileName, chunk]),
  );
  const moduleIds = new Set<string>();

  for (const asset of Object.values(bundle)) {
    if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) {
      continue;
    }
    const html = readAssetText(asset);
    const entryScripts = [
      ...html.matchAll(
        /<script\b[^>]*type=(["'])module\1[^>]*src=(["'])([^"']+)\2[^>]*><\/script>/giu,
      ),
    ];
    for (const match of entryScripts) {
      const sourcePath = match[3];
      const chunk = [...chunkByFileName.entries()].find(([fileName]) =>
        sourcePath.endsWith(fileName),
      )?.[1];
      if (chunk?.facadeModuleId) {
        moduleIds.add(chunk.facadeModuleId);
      }
    }
  }

  if (moduleIds.size > 0) {
    return [...moduleIds];
  }

  return chunks
    .filter((chunk) => chunk.isEntry && chunk.facadeModuleId)
    .map((chunk) => chunk.facadeModuleId as string);
}

export async function materializeCapturedGraph(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    entryModuleIds: string[];
    moduleIds: string[];
    srcDir: string;
  },
): Promise<MaterializedGraph> {
  if (input.entryModuleIds.length === 0) {
    this.error("gccTsBundler() could not determine a Vite entry facade.");
  }

  await fs.mkdir(input.srcDir, { recursive: true });
  const filePathByModuleId = new Map<string, string>();
  const modules: CapturedRuntimeModule[] = [];
  for (const moduleId of input.moduleIds) {
    const relativePath = toMaterializedRelativePath(
      input.config.root,
      moduleId,
    );
    const filePath = path.join(input.srcDir, relativePath);
    filePathByModuleId.set(moduleId, filePath);
    modules.push({
      filePath,
      id: moduleId,
      relativePath,
    });
  }

  for (const moduleId of input.moduleIds) {
    const record = input.capturedModules.get(moduleId);
    if (!record) {
      this.error(
        `gccTsBundler() could not capture transformed code for ${moduleId}.`,
      );
    }

    const outputPath = filePathByModuleId.get(moduleId);
    if (!outputPath) {
      this.error(`Missing materialized output path for ${moduleId}.`);
    }

    const rewritten = await rewriteModuleImports.call(this, {
      code: record.code,
      filePathByModuleId,
      importerId: moduleId,
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, rewritten, "utf8");
  }

  const entryFiles = input.entryModuleIds.map((moduleId) => {
    const filePath = filePathByModuleId.get(moduleId);
    if (!filePath) {
      this.error(`Missing captured entry module ${moduleId}.`);
    }
    return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
  });

  return {
    entries: entryFiles,
    modules,
    runtimeEntries: input.moduleIds
      .map((moduleId) => {
        const filePath = filePathByModuleId.get(moduleId);
        if (!filePath) {
          this.error(`Missing captured runtime module ${moduleId}.`);
        }
        return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
      })
      .sort((left, right) => left.localeCompare(right)),
    srcDir: input.srcDir,
  };
}

export async function resolveCompilerExterns(input: {
  captureRoot: string;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  const explicitExterns = [...(input.options.compiler?.externs ?? [])].map(
    (filePath) => path.resolve(input.projectRoot, filePath),
  );
  const generateOptions = input.options.externs?.generate;
  if (!generateOptions) {
    return explicitExterns;
  }

  const generatedExternFile = path.resolve(
    input.projectRoot,
    generateOptions.outputFile ??
      path.join(input.captureRoot, "generated.externs.js"),
  );
  await generateExterns({
    appEntryFiles: input.materialized.entries,
    includeDependencies: generateOptions.includeDependencies,
    mode: generateOptions.mode ?? "runtime-aware",
    modules: [...generateOptions.modules],
    outputFile: generatedExternFile,
    projectRoot: input.projectRoot,
    runtimeEntryFiles: input.materialized.runtimeEntries,
    srcDir: input.materialized.srcDir,
  });

  if ((generateOptions.appendLines?.length ?? 0) > 0) {
    await fs.appendFile(
      generatedExternFile,
      `\n${generateOptions.appendLines!.join("\n")}\n`,
      "utf8",
    );
  }

  return [...new Set([...explicitExterns, generatedExternFile])];
}

async function rewriteModuleImports(
  this: PluginContext,
  input: {
    code: string;
    filePathByModuleId: Map<string, string>;
    importerId: string;
  },
) {
  const sourceFile = ts.createSourceFile(
    input.importerId,
    input.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const pendingEdits: Promise<void>[] = [];

  const addSpecifierEdit = async (
    literal: ts.StringLiteralLike,
    node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
  ) => {
    const specifier = literal.text;
    const resolved = await this.resolve(specifier, input.importerId, {
      skipSelf: true,
    });
    if (!resolved || resolved.external) {
      if (isSupportedExternalSpecifier(specifier)) {
        return;
      }
      this.error(
        `gccTsBundler() could not materialize ${specifier} imported from ${input.importerId}. ` +
          "Ensure Vite/plugins lower the resource to a JS module before gccTsBundler() runs.",
      );
    }

    const targetFile = input.filePathByModuleId.get(resolved.id);
    if (!targetFile) {
      if (shouldOmitSideEffectAssetImport(node, resolved.id)) {
        edits.push({
          end: node.getEnd(),
          start: node.getStart(sourceFile),
          text: "",
        });
        return;
      }
      this.error(
        `gccTsBundler() resolved ${specifier} from ${input.importerId} to ${resolved.id}, ` +
          "but that transformed module was not captured in the final Vite JS graph.",
      );
    }

    const importerFile = input.filePathByModuleId.get(input.importerId);
    if (!importerFile) {
      this.error(`Missing importer file path for ${input.importerId}.`);
    }

    edits.push({
      end: literal.getEnd() - 1,
      start: literal.getStart() + 1,
      text: toRelativeImportSpecifier(importerFile, targetFile),
    });
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pendingEdits.push(addSpecifierEdit(node.moduleSpecifier, node));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      pendingEdits.push(addSpecifierEdit(node.arguments[0], node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  await Promise.all(pendingEdits);

  if (edits.length === 0) {
    return input.code;
  }

  let rewritten = input.code;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return rewritten;
}

function shouldOmitSideEffectAssetImport(
  node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
  resolvedId: string,
) {
  if (!ts.isImportDeclaration(node) || node.importClause) {
    return false;
  }
  const cleanId = stripQuery(resolvedId);
  return /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/u.test(cleanId);
}

function isSupportedExternalSpecifier(specifier: string) {
  return specifier.startsWith("node:");
}

function toRelativeImportSpecifier(fromFile: string, toFile: string) {
  const relativePath = path.relative(path.dirname(fromFile), toFile);
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function toMaterializedRelativePath(projectRoot: string, moduleId: string) {
  const cleanId = stripQuery(moduleId);
  const extension = path.extname(cleanId).replace(/^\./u, "");
  const queryHash =
    cleanId === moduleId ? "" : `__${hashText(moduleId).slice(0, 8)}`;

  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return path.posix.join(
      "__virtual__",
      `${sanitizeSegment(cleanId)}${queryHash}.js`,
    );
  }

  if (path.isAbsolute(cleanId) && cleanId.startsWith(projectRoot)) {
    const relative = path.relative(projectRoot, cleanId).replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`;
    }
    return `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`;
  }

  const nodeModulesIndex = cleanId.lastIndexOf(
    `${path.sep}node_modules${path.sep}`,
  );
  if (nodeModulesIndex >= 0) {
    const relative = cleanId
      .slice(nodeModulesIndex + `${path.sep}node_modules${path.sep}`.length)
      .replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return path.posix.join(
        "__deps__",
        `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`,
      );
    }
    return path.posix.join(
      "__deps__",
      `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`,
    );
  }

  return path.posix.join(
    "__modules__",
    `${sanitizeSegment(cleanId)}${queryHash}.js`,
  );
}

function sanitizeSegment(value: string) {
  return value.replace(/[^\w./-]+/gu, "-").replace(/^-+/u, "");
}

function stripQuery(id: string) {
  return id.replace(/[?#].*$/u, "");
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function readAssetText(asset: { source: string | Uint8Array }) {
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");
}

function resolveEsbuildLoader(id: string) {
  const cleanId = stripQuery(id);
  if (cleanId.endsWith(".tsx")) {
    return "tsx";
  }
  if (cleanId.endsWith(".ts")) {
    return "ts";
  }
  if (cleanId.endsWith(".jsx")) {
    return "jsx";
  }
  return "js";
}

function needsClosureCompatibilityDownlevel(code: string) {
  return /(^|[^\w$])#[$A-Z_a-z]/u.test(code) || /\bstatic\s*\{/u.test(code);
}

function needsTypeScriptCompatibilityDownlevel(code: string) {
  return (
    code.includes("new.target") ||
    /\bsuper(?:\.|\[)/u.test(code) ||
    /\b(?:get|set)\s*\[[^\]]+\]\s*\(/u.test(code)
  );
}

async function loadViteEsbuildTransform() {
  if (!cachedViteEsbuildTransform) {
    type ViteEsbuildModule = {
      transformWithEsbuild: (
        code: string,
        filename: string,
        options: Record<string, unknown>,
      ) => Promise<{ code: string }>;
    };
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier);",
    ) as (specifier: string) => Promise<ViteEsbuildModule>;
    cachedViteEsbuildTransform = dynamicImport("vite").then(
      (module) => module.transformWithEsbuild,
    );
  }
  return cachedViteEsbuildTransform;
}
