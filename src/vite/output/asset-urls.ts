import fs from "node:fs/promises";
import path from "node:path";

import type { ChunkMetadata, ResolvedConfig } from "vite";

import { isString } from "../../shared/validation";

import type {
  NormalizedOutputOptions,
  OutputChunk,
  PluginContext,
  ViteChunkOutputType,
} from "../internal-types";

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
