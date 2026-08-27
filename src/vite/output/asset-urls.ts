import fs from "node:fs/promises";
import path from "node:path";

import type { ChunkMetadata, Plugin, ResolvedConfig } from "vite";

import { isString } from "../../shared/validation";

import type {
  NormalizedOutputOptions,
  OutputChunk,
  PluginContext,
  ViteAssetPlaceholder,
  ViteChunkOutputType,
} from "../internal-types";

/** An emitted chunk file whose source still names Vite asset placeholders. */
interface UnresolvedAssetFile {
  fileName: string;
  filePath: string;
  source: string;
}

/**
 * The function form of a plugin `renderChunk` hook. Object-form hooks are
 * unwrapped to their `handler` before they land in this list.
 */
type ViteAssetRenderHook =
  NonNullable<Plugin["renderChunk"]> extends infer Hook
    ? Hook extends { handler: infer Handler }
      ? Handler
      : Hook
    : never;

export async function resolveViteAssetUrls(input: {
  assetPlaceholders: ViteAssetPlaceholder[];
  chunkOutputType: ViteChunkOutputType;
  config: ResolvedConfig;
  jsChunks: OutputChunk[];
  outDir: string;
  outputFiles: string[];
  outputOptions: NormalizedOutputOptions;
  pluginContext: PluginContext;
}) {
  const filesWithPlaceholders = await collectUnresolvedAssetFiles(input);
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
    const source = await renderViteAssetUrls(file, {
      outputOptions,
      pluginContext: input.pluginContext,
      renderChunks,
      templateChunk,
    });
    if (hasViteAssetPlaceholder(source)) {
      throw new Error(
        `gccTsBundler() could not resolve Vite asset URLs in ${file.fileName}.`,
      );
    }
    await fs.writeFile(file.filePath, source, "utf8");
  }

  return true;
}

/**
 * The emitted `.js` files whose restored source still names an asset
 * placeholder, read one at a time in `outputFiles` order.
 */
async function collectUnresolvedAssetFiles(input: {
  assetPlaceholders: ViteAssetPlaceholder[];
  outDir: string;
  outputFiles: string[];
}) {
  const files: UnresolvedAssetFile[] = [];
  for (const filePath of input.outputFiles) {
    const file = await readUnresolvedAssetFile(
      filePath,
      input.outDir,
      input.assetPlaceholders,
    );
    if (file) {
      files.push(file);
    }
  }
  return files;
}

/**
 * `filePath` with its canonical placeholders restored, or `null` when the file
 * is not an emitted chunk or holds no placeholder left to resolve.
 */
async function readUnresolvedAssetFile(
  filePath: string,
  outDir: string,
  assetPlaceholders: ViteAssetPlaceholder[],
): Promise<UnresolvedAssetFile | null> {
  if (!filePath.endsWith(".js")) {
    return null;
  }
  const source = restoreViteAssetPlaceholders(
    await fs.readFile(filePath, "utf8"),
    assetPlaceholders,
  );
  if (!hasViteAssetPlaceholder(source)) {
    return null;
  }
  return {
    fileName: path.relative(outDir, filePath).replace(/\\/g, "/"),
    filePath,
    source,
  };
}

/**
 * `file.source` after every asset renderer has had its turn, in hook order,
 * each one seeing the previous renderer's output.
 */
async function renderViteAssetUrls(
  file: UnresolvedAssetFile,
  context: {
    outputOptions: NormalizedOutputOptions;
    pluginContext: PluginContext;
    renderChunks: ViteAssetRenderHook[];
    templateChunk: OutputChunk;
  },
) {
  const viteMetadata: ChunkMetadata = {
    __modules: {},
    importedAssets: new Set<string>(),
    importedCss: new Set<string>(),
  };
  const chunk: OutputChunk = {
    ...context.templateChunk,
    fileName: file.fileName,
    viteMetadata,
  };
  let source = file.source;
  for (const renderChunk of context.renderChunks) {
    const rendered = await renderChunk.call(
      context.pluginContext,
      source,
      chunk,
      context.outputOptions,
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
  return source;
}

function restoreViteAssetPlaceholders(
  source: string,
  assetPlaceholders: ViteAssetPlaceholder[],
) {
  let restored = source;
  for (const placeholder of assetPlaceholders) {
    restored = restored.replaceAll(placeholder.canonical, placeholder.current);
  }
  return restored;
}

function findViteAssetRenderHooks(config: ResolvedConfig) {
  const hooks: ViteAssetRenderHook[] = [];
  for (const plugin of config.plugins) {
    const hook = viteAssetRenderHookOf(plugin);
    if (hook) {
      hooks.push(hook);
    }
  }
  return hooks;
}

function viteAssetRenderHookOf(
  plugin: Plugin,
): ViteAssetRenderHook | undefined {
  if (plugin.name !== "vite:asset" && plugin.name !== "vite:worker") {
    return undefined;
  }
  const hook = plugin.renderChunk;
  if (hook === undefined) {
    return undefined;
  }
  if ("handler" in hook) {
    return hook.handler;
  }
  return hook;
}

function hasViteAssetPlaceholder(source: string) {
  return (
    source.includes("__VITE_ASSET__") ||
    source.includes("__VITE_PUBLIC_ASSET__") ||
    source.includes("__VITE_WORKER_ASSET__")
  );
}
