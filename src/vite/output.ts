import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";
import type { ChunkMetadata, ResolvedConfig } from "vite";

import { applyTextEdits } from "../shared/text-edits";
import { buildChunkModuleIdLookup } from "./chunk-modules";
import type { Validator } from "../shared/validation";
import { isString, recordOf } from "../shared/validation";

import type {
  GccRuntimeManifest,
  MaterializedGraph,
  OutputAsset,
  OutputBundle,
  OutputChunk,
  NormalizedOutputOptions,
  PluginContext,
  ViteChunkOutputType,
} from "./internal-types";

const isRuntimeModuleSourceMap: Validator<Record<string, string>> =
  recordOf<string>(isString);

export function listJavaScriptChunks(bundle: OutputBundle) {
  return Object.values(bundle).filter(
    (item): item is OutputChunk => item.type === "chunk",
  );
}

export async function rewritePreservedImportSpecifiers(input: {
  outDir: string;
  outputFiles: string[];
}) {
  await Promise.all(
    input.outputFiles
      .filter((filePath) => filePath.endsWith(".js"))
      .map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        const sourceFile = ts.createSourceFile(
          filePath,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const edits: Array<{ end: number; start: number; text: string }> = [];
        const visit = (node: ts.Node) => {
          const literal =
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
              ? node.moduleSpecifier
              : undefined;
          if (literal) {
            const markerIndex = literal.text.indexOf("__gcc_preserved/");
            if (markerIndex >= 0) {
              const targetPath = path.join(
                input.outDir,
                literal.text.slice(markerIndex),
              );
              const relative = path
                .relative(path.dirname(filePath), targetPath)
                .replace(/\\/g, "/");
              edits.push({
                end: literal.getEnd() - 1,
                start: literal.getStart(sourceFile) + 1,
                text: relative.startsWith(".") ? relative : `./${relative}`,
              });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        if (edits.length > 0) {
          await fs.writeFile(filePath, applyTextEdits(source, edits), "utf8");
        }
      }),
  );
}

export async function preserveCompiledChunkIdentities(input: {
  bundle: OutputBundle;
  jsChunks: OutputChunk[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
  materialized: MaterializedGraph;
  outDir: string;
  outputFiles: string[];
  pluginContext: PluginContext;
  publicPath: string;
  runtimeModuleSourceMapFilePath: string;
}) {
  const parsedRuntimeSourceMap: unknown = JSON.parse(
    await fs.readFile(input.runtimeModuleSourceMapFilePath, "utf8"),
  );
  if (!isRuntimeModuleSourceMap(parsedRuntimeSourceMap)) {
    throw new Error("gccTsBundler() found an invalid runtime source map.");
  }
  const chunkModuleIds = buildChunkModuleIdLookup({
    jsChunks: input.jsChunks,
    manifest: input.manifest,
    materialized: input.materialized,
    runtimeModuleSourceMap: parsedRuntimeSourceMap,
  });
  const compiledChunks = Object.entries(input.manifest.chunks).map(
    ([chunkId, chunk]) => ({
      chunkId,
      fileName: stripPublicPath(chunk.url, input.publicPath),
      moduleIds: chunkModuleIds.get(chunkId) ?? new Set<string>(),
    }),
  );
  const base =
    compiledChunks.find(
      (chunk) => chunk.chunkId === input.manifest.baseChunk,
    ) ?? compiledChunks[0];
  if (!base) {
    throw new Error("gccTsBundler() emitted no runtime chunks.");
  }

  const targetByRollupChunk = new Map<
    OutputChunk,
    (typeof compiledChunks)[number]
  >();
  for (const chunk of input.jsChunks) {
    let target = chunk.isEntry ? base : undefined;
    if (!target && chunk.facadeModuleId) {
      target = compiledChunks.find((candidate) =>
        candidate.moduleIds.has(chunk.facadeModuleId ?? ""),
      );
    }
    target ??= [...compiledChunks].sort(
      (left, right) =>
        overlap(right.moduleIds, new Set(Object.keys(chunk.modules))) -
        overlap(left.moduleIds, new Set(Object.keys(chunk.modules))),
    )[0];
    targetByRollupChunk.set(chunk, target ?? base);
  }

  const rollupChunksByTarget = new Map<string, OutputChunk[]>();
  for (const [chunk, target] of targetByRollupChunk) {
    const chunks = rollupChunksByTarget.get(target.chunkId) ?? [];
    chunks.push(chunk);
    rollupChunksByTarget.set(target.chunkId, chunks);
  }
  const ownerByTarget = new Map<string, OutputChunk>();
  for (const target of compiledChunks) {
    const candidates = rollupChunksByTarget.get(target.chunkId) ?? [];
    const owner = candidates.sort((left, right) => {
      if (left.isEntry !== right.isEntry) return left.isEntry ? -1 : 1;
      if (left.isDynamicEntry !== right.isDynamicEntry) {
        return left.isDynamicEntry ? -1 : 1;
      }
      return (
        overlap(target.moduleIds, new Set(Object.keys(right.modules))) -
        overlap(target.moduleIds, new Set(Object.keys(left.modules)))
      );
    })[0];
    if (owner) ownerByTarget.set(target.chunkId, owner);
  }

  const renameMap = new Map<string, string>();
  for (const target of compiledChunks) {
    const owner = ownerByTarget.get(target.chunkId);
    if (owner) renameMap.set(target.fileName, owner.fileName);
  }
  await rewriteAndRenameCompiledFiles(
    input.outDir,
    input.outputFiles,
    renameMap,
  );
  for (const target of compiledChunks) {
    const renamed = renameMap.get(target.fileName);
    const manifestChunk = input.manifest.chunks[target.chunkId];
    if (renamed && manifestChunk) {
      manifestChunk.url = `${input.publicPath}${renamed}`;
    }
  }
  await fs.writeFile(
    input.manifestFilePath,
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );

  const claimedFiles = new Set(renameMap.values());
  for (const [chunk, target] of targetByRollupChunk) {
    const owner = ownerByTarget.get(target.chunkId);
    if (!owner) continue;
    if (chunk === owner) {
      chunk.code = await fs.readFile(
        path.join(input.outDir, owner.fileName),
        "utf8",
      );
      applyChunkMetadata(chunk);
      continue;
    }
    const specifier = relativeSpecifier(chunk.fileName, owner.fileName);
    chunk.code = `export * from ${JSON.stringify(specifier)};\n`;
    chunk.imports = [owner.fileName];
    chunk.dynamicImports = [];
  }

  const emittedPrivateFiles: string[] = [];
  for (const outputFile of input.outputFiles) {
    const oldFileName = path
      .relative(input.outDir, outputFile)
      .replace(/\\/g, "/");
    const fileName = renameMap.get(oldFileName) ?? oldFileName;
    if (claimedFiles.has(fileName)) continue;
    const filePath = path.join(input.outDir, fileName);
    const source = await fs.readFile(filePath);
    input.pluginContext.emitFile({ fileName, source, type: "asset" });
    emittedPrivateFiles.push(filePath);
  }
  const finalOutputFiles = input.outputFiles.map((outputFile) => {
    const oldFileName = path
      .relative(input.outDir, outputFile)
      .replace(/\\/g, "/");
    return path.join(input.outDir, renameMap.get(oldFileName) ?? oldFileName);
  });
  return {
    baseScriptFileName:
      ownerByTarget.get(input.manifest.baseChunk)?.fileName ?? base.fileName,
    emittedPrivateFiles,
    finalOutputFiles,
  };
}

async function rewriteAndRenameCompiledFiles(
  outDir: string,
  outputFiles: string[],
  renameMap: Map<string, string>,
) {
  for (const outputFile of outputFiles.filter((file) => file.endsWith(".js"))) {
    const oldName = path.relative(outDir, outputFile).replace(/\\/g, "/");
    const newName = renameMap.get(oldName) ?? oldName;
    let source = await fs.readFile(outputFile, "utf8");
    for (const [oldTarget, newTarget] of renameMap) {
      const oldSpecifier = relativeSpecifier(oldName, oldTarget);
      const newSpecifier = relativeSpecifier(newName, newTarget);
      for (const candidate of [
        oldSpecifier,
        oldSpecifier.replace(/^\.\//u, ""),
      ]) {
        source = source.replaceAll(
          JSON.stringify(candidate),
          JSON.stringify(newSpecifier),
        );
        source = source.replaceAll(`'${candidate}'`, `'${newSpecifier}'`);
        // Final minification runs before this pass and re-quotes with
        // backticks, and the runtime manifest's chunk urls are ordinary
        // strings inside the base chunk: miss this spelling and a renamed
        // lazy chunk keeps a url that no longer exists.
        source = source.replaceAll(`\`${candidate}\``, `\`${newSpecifier}\``);
      }
    }
    await fs.writeFile(outputFile, source, "utf8");
  }
  for (const [oldName, newName] of renameMap) {
    if (oldName === newName) continue;
    await fs.mkdir(path.dirname(path.join(outDir, newName)), {
      recursive: true,
    });
    await fs.rename(path.join(outDir, oldName), path.join(outDir, newName));
  }
}

function relativeSpecifier(importer: string, target: string) {
  const relative = path.posix.relative(path.posix.dirname(importer), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function overlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function stripPublicPath(url: string, publicPath: string) {
  return url.startsWith(publicPath)
    ? url.slice(publicPath.length)
    : url.replace(/^\/+/, "");
}

function applyChunkMetadata(chunk: OutputChunk) {
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
    const literal =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier
        : undefined;
    if (literal?.text.startsWith(".")) {
      imports.add(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(chunk.fileName), literal.text),
        ),
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".")
    ) {
      dynamicImports.add(
        path.posix.normalize(
          path.posix.join(
            path.posix.dirname(chunk.fileName),
            node.arguments[0].text,
          ),
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  chunk.imports = [...imports].sort();
  chunk.dynamicImports = [...dynamicImports].sort();
}

export async function resolveViteAssetUrls(input: {
  chunkOutputType: ViteChunkOutputType;
  config: ResolvedConfig;
  jsChunks: OutputChunk[];
  outDir: string;
  outputFiles: string[];
  outputOptions: NormalizedOutputOptions;
  pluginContext: PluginContext;
}) {
  const filesWithPlaceholders: Array<{
    fileName: string;
    filePath: string;
    source: string;
  }> = [];
  for (const filePath of input.outputFiles) {
    if (!filePath.endsWith(".js")) {
      continue;
    }
    const source = await fs.readFile(filePath, "utf8");
    if (!hasViteAssetPlaceholder(source)) {
      continue;
    }
    filesWithPlaceholders.push({
      fileName: path.relative(input.outDir, filePath).replace(/\\/g, "/"),
      filePath,
      source,
    });
  }
  if (filesWithPlaceholders.length === 0) {
    return false;
  }

  const renderChunks = findViteAssetRenderHooks(input.config);
  const templateChunk = input.jsChunks[0];
  if (renderChunks.length === 0 || !templateChunk) {
    throw new Error(
      "gccTsBundler() found unresolved Vite asset URLs but could not find Vite's asset renderers.",
    );
  }
  const outputOptions = {
    ...input.outputOptions,
    format:
      input.chunkOutputType === "script" ? "iife" : input.outputOptions.format,
  };

  for (const file of filesWithPlaceholders) {
    const viteMetadata: ChunkMetadata = {
      __modules: {},
      importedAssets: new Set<string>(),
      importedCss: new Set<string>(),
    };
    const chunk: OutputChunk = {
      ...templateChunk,
      fileName: file.fileName,
      viteMetadata,
    };
    let source = file.source;
    for (const renderChunk of renderChunks) {
      const rendered = await renderChunk.call(
        input.pluginContext,
        source,
        chunk,
        outputOptions,
        { chunks: {} },
      );
      if (isString(rendered)) {
        source = rendered;
        continue;
      }
      if (rendered === null || rendered === undefined) {
        continue;
      }
      if ("code" in rendered) {
        source = rendered.code.toString();
      } else {
        source = rendered.toString();
      }
    }
    if (hasViteAssetPlaceholder(source)) {
      throw new Error(
        `gccTsBundler() could not resolve Vite asset URLs in ${file.fileName}.`,
      );
    }
    await fs.writeFile(file.filePath, source, "utf8");
  }

  return true;
}

export async function collectOutputByteBreakdown(input: {
  bundle: OutputBundle;
  emittedOutputFiles: string[];
}) {
  let js = 0;
  let css = 0;
  let fonts = 0;
  let assets = 0;

  for (const outputFile of input.emittedOutputFiles) {
    if (outputFile.endsWith(".js")) {
      js += (await fs.stat(outputFile)).size;
    } else {
      assets += (await fs.stat(outputFile)).size;
    }
  }

  for (const item of Object.values(input.bundle)) {
    if (item.type !== "asset") {
      continue;
    }
    const size =
      item.source instanceof Uint8Array
        ? item.source.byteLength
        : Buffer.byteLength(item.source);
    if (item.fileName.endsWith(".css")) {
      css += size;
      continue;
    }
    if (/\.(?:woff2?|ttf|otf|eot)$/u.test(item.fileName)) {
      fonts += size;
      continue;
    }
    assets += size;
  }

  return { assets, css, fonts, js };
}

export function joinPublicPath(
  base: string,
  fileName: string,
  hostFileName?: string,
) {
  if (base === "./") {
    if (!hostFileName) {
      return `./${fileName}`;
    }
    const relativePath = path.posix.relative(
      path.posix.dirname(hostFileName.replace(/\\/g, "/")),
      fileName.replace(/\\/g, "/"),
    );
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }
  return `${base}${fileName}`;
}

export function stripPublicPathPrefix(url: string, publicPath: string) {
  if (publicPath === "./") {
    return url.startsWith("./") ? url.slice(2) : url;
  }
  if (url.startsWith(publicPath)) {
    return url.slice(publicPath.length);
  }
  return url.replace(/^\/+/u, "");
}

export function readAssetText(asset: OutputAsset) {
  return asset.source instanceof Uint8Array
    ? Buffer.from(asset.source).toString("utf8")
    : asset.source;
}

function findViteAssetRenderHooks(config: ResolvedConfig) {
  return config.plugins.flatMap((plugin) => {
    if (plugin.name !== "vite:asset" && plugin.name !== "vite:worker") {
      return [];
    }
    const hook = plugin.renderChunk;
    if (hook === undefined) {
      return [];
    }
    if ("handler" in hook) {
      return [hook.handler];
    }
    return [hook];
  });
}

function hasViteAssetPlaceholder(source: string) {
  return (
    source.includes("__VITE_ASSET__") ||
    source.includes("__VITE_PUBLIC_ASSET__") ||
    source.includes("__VITE_WORKER_ASSET__")
  );
}
