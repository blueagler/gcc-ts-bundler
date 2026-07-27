import fs from "node:fs/promises";
import path from "node:path";

import type {
  OutputAsset,
  OutputBundle,
  OutputChunk,
  PluginContext,
  ViteChunkOutputType,
} from "./internal-types";

export function listJavaScriptChunks(bundle: OutputBundle) {
  return Object.values(bundle).filter(
    (item): item is OutputChunk => item.type === "chunk",
  );
}

export function removeRollupJavaScript(bundle: OutputBundle) {
  for (const [fileName, item] of Object.entries(bundle)) {
    if (item.type === "chunk" || fileName.endsWith(".js")) {
      delete bundle[fileName];
    }
  }
}

export async function emitCompiledOutputs(
  pluginContext: PluginContext,
  outputFiles: string[],
  outDir: string,
) {
  for (const outputFile of outputFiles) {
    const source = await fs.readFile(outputFile, "utf8");
    const fileName = path.relative(outDir, outputFile).replace(/\\/g, "/");
    pluginContext.emitFile({
      fileName,
      source,
      type: "asset",
    });
  }
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
      typeof item.source === "string"
        ? Buffer.byteLength(item.source)
        : item.source.byteLength;
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

/**
 * No `<link rel="modulepreload">` is emitted for ES module output, by design.
 * The base chunk has no static imports at all — it is the whole eager graph —
 * so there is no second-level module to preload, and lazy chunks are fetched
 * through the runtime manifest, which already issues a chunk and every one of
 * its dependencies in a single parallel round (measured identical to script
 * output in docs/research/es-modules-output.md §5). Preload links would only
 * become load-bearing if the manifest-driven dependency prefetch were ever
 * removed in favour of the browser's own static-import discovery.
 */
export function rewriteHtmlAssets(input: {
  baseScriptFileName: string;
  bundle: OutputBundle;
  chunkOutputType: ViteChunkOutputType;
  publicPath: string;
  removedChunkFileNames: Set<string>;
}) {
  for (const asset of Object.values(input.bundle)) {
    if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) {
      continue;
    }

    let html = readAssetText(asset);
    html = html.replace(
      /<link\b[^>]*rel=(["'])modulepreload\1[^>]*href=(["'])([^"']+)\2[^>]*\/?>/giu,
      (match: string, _quote: string, _hrefQuote: string, href: string) =>
        endsWithAnyFileName(href, input.removedChunkFileNames) ? "" : match,
    );
    html = html.replace(
      /<script\b[^>]*type=(["'])module\1[^>]*src=(["'])([^"']+)\2[^>]*><\/script>/giu,
      (match: string, _quote: string, _srcQuote: string, src: string) =>
        endsWithAnyFileName(src, input.removedChunkFileNames) ? "" : match,
    );

    const entryUrl = joinPublicPath(input.publicPath, input.baseScriptFileName);
    // Module scripts are deferred by definition, and are always fetched in
    // CORS mode: a cross-origin publicPath now needs Access-Control-Allow-Origin
    // headers that a classic `defer` script never required.
    const scriptTag =
      input.chunkOutputType === "esm"
        ? `<script type="module" crossorigin src="${entryUrl}"></script>`
        : `<script defer src="${entryUrl}"></script>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", `    ${scriptTag}\n  </head>`);
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", `    ${scriptTag}\n  </body>`);
    } else {
      html += `\n${scriptTag}\n`;
    }

    asset.source = html;
  }
}

export function joinPublicPath(base: string, fileName: string) {
  if (base === "./") {
    return `./${fileName}`;
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
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");
}

function endsWithAnyFileName(value: string, fileNames: Set<string>) {
  for (const fileName of fileNames) {
    if (value.endsWith(fileName)) {
      return true;
    }
  }
  return false;
}
