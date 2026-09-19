import fs from "node:fs/promises";
import path from "node:path";

import type { ChunkMetadata, HookHandler, Plugin, ResolvedConfig } from "vite";
import ts from "@typescript/typescript6";

import { applyTextEdits, type TextEdit } from "../../shared/text-edits";
import { isFunction, isString } from "../../shared/validation";

import type {
  NormalizedOutputOptions,
  OutputChunk,
  PluginContext,
  ViteAssetPlaceholder,
  ViteChunkOutputType,
} from "../internal-types";

/** An emitted chunk being checked for unresolved Vite asset URLs. */
interface UnresolvedAssetFile {
  fileName: string;
  filePath: string;
  source: string;
}

/**
 * The function form of a plugin `renderChunk` hook. Object-form hooks are
 * unwrapped to their `handler` before they land in this list.
 */
type ViteAssetRenderHook = NonNullable<HookHandler<Plugin["renderChunk"]>>;

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
  const placeholders = new Map(
    input.assetPlaceholders
      .filter((placeholder) => placeholder.fileReference !== undefined)
      .map((placeholder) => [placeholder.canonical, placeholder]),
  );
  const resolveFileUrlHooks =
    placeholders.size > 0
      ? input.config["getSortedPluginHooks"]("resolveFileUrl")
      : [];
  const outputOptions: NormalizedOutputOptions = {
    ...input.outputOptions,
    ["format"]:
      input.chunkOutputType === "script" ? "iife" : input.outputOptions.format,
  };
  const hostUrlContext = {
    format: outputOptions.format,
    placeholders,
    pluginContext: input.pluginContext,
    resolveFileUrlHooks,
  };
  let renderChunks: ViteAssetRenderHook[] | undefined;
  let changed = false;

  // Host references and legacy placeholders share one read/write pass. URL
  // resolution still precedes legacy rendering and final content-based naming.
  for (const filePath of input.outputFiles) {
    if (!filePath.endsWith(".js")) continue;
    const originalSource = await fs.readFile(filePath, "utf8");
    const file: UnresolvedAssetFile = {
      fileName: path.relative(input.outDir, filePath).replace(/\\/g, "/"),
      filePath,
      source: originalSource,
    };
    file.source = resolveHostFileUrls(file, hostUrlContext);
    file.source = restoreViteAssetPlaceholders(
      file.source,
      input.assetPlaceholders,
    );
    if (hasViteAssetPlaceholder(file.source)) {
      renderChunks ??= findViteAssetRenderHooks(input.config);
      const templateChunk = input.jsChunks[0];
      if (renderChunks.length === 0 || !templateChunk) {
        throw new Error(
          "gccTsBundler() found unresolved Vite asset URLs but could not find Vite's asset renderers.",
        );
      }
      file.source = await renderViteAssetUrls(file, {
        outputOptions,
        pluginContext: input.pluginContext,
        renderChunks,
        templateChunk,
      });
      if (hasViteAssetPlaceholder(file.source)) {
        throw new Error(
          `gccTsBundler() could not resolve Vite asset URLs in ${file.fileName}.`,
        );
      }
    }
    if (file.source !== originalSource) {
      await fs.writeFile(file.filePath, file.source, "utf8");
      changed = true;
    }
  }
  return changed;
}

function resolveHostFileUrls(
  file: UnresolvedAssetFile,
  input: {
    format: NormalizedOutputOptions["format"];
    placeholders: Map<string, ViteAssetPlaceholder>;
    pluginContext: PluginContext;
    resolveFileUrlHooks: NonNullable<HookHandler<Plugin["resolveFileUrl"]>>[];
  },
) {
  const { source } = file;
  if (
    input.placeholders.size === 0 ||
    !source.includes("__GCC_VITE_FILE_URL__")
  ) {
    return source;
  }
  const sourceFile = ts.createSourceFile(
    file.filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: TextEdit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteralLike(node) &&
      node.text.includes("__GCC_VITE_FILE_URL__")
    ) {
      const parts: string[] = [];
      let offset = 0;
      for (const match of node.text.matchAll(
        /__GCC_VITE_FILE_URL__[a-f0-9]+__/gu,
      )) {
        const placeholder = input.placeholders.get(match[0]);
        const reference = placeholder?.fileReference;
        if (!reference) {
          throw new Error(
            `gccTsBundler() lost emitted file ownership for ${match[0]}.`,
          );
        }
        const fileName = input.pluginContext.getFileName(reference.referenceId);
        let expression: string | undefined;
        // Re-enter the host's URL ownership hook after our chunk placement.
        // In Vite 8 this is where base, renderBuiltUrl and asFileUrl metadata
        // live; copying the old rendered URL would use the wrong chunk path.
        for (const handler of input.resolveFileUrlHooks) {
          // This object crosses a reflective SDK callback boundary; its
          // public keys must survive our own Closure selfbuild unchanged.
          const result = handler.call(input.pluginContext, {
            ["moduleId"]: reference.moduleId,
            ["referenceId"]: reference.referenceId,
            ["urlId"]: reference.urlId,
            ["chunkId"]: file.fileName,
            ["fileName"]: fileName,
            ["format"]: input.format,
            ["relativePath"]: path.posix.relative(
              path.posix.dirname(file.fileName),
              fileName,
            ),
          });
          if (result !== null && result !== undefined) {
            expression = result;
            break;
          }
        }
        if (expression === undefined) {
          throw new Error(
            `gccTsBundler() has no host URL resolver for ${fileName}.`,
          );
        }
        if (match.index > offset) {
          parts.push(JSON.stringify(node.text.slice(offset, match.index)));
        }
        parts.push(`(${expression})`);
        offset = match.index + match[0].length;
      }
      if (offset < node.text.length)
        parts.push(JSON.stringify(node.text.slice(offset)));
      if (parts.length > 0) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: `(${parts.join(" + ")})`,
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edits.length > 0 ? applyTextEdits(source, edits) : source;
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
    if (!placeholder.fileReference) {
      restored = restored.replaceAll(
        placeholder.canonical,
        placeholder.current,
      );
    }
  }
  return restored;
}

function findViteAssetRenderHooks(config: ResolvedConfig) {
  const hooks: ViteAssetRenderHook[] = [];
  for (const plugin of config["getSortedPlugins"]("renderChunk")) {
    if (plugin.name !== "vite:asset" && plugin.name !== "vite:worker") continue;
    const hook = plugin["renderChunk"];
    hooks.push(isViteAssetRenderHook(hook) ? hook : hook["handler"]);
  }
  return hooks;
}

function isViteAssetRenderHook(
  hook: NonNullable<Plugin["renderChunk"]>,
): hook is ViteAssetRenderHook {
  return isFunction(hook);
}

function hasViteAssetPlaceholder(source: string) {
  return (
    source.includes("__VITE_ASSET__") ||
    source.includes("__VITE_PUBLIC_ASSET__") ||
    source.includes("__VITE_WORKER_ASSET__")
  );
}
