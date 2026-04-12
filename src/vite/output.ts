import fs from "node:fs/promises";
import path from "node:path";

import type {
  OutputAsset,
  OutputBundle,
  OutputChunk,
  PluginContext,
} from "rollup";

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

export function rewriteHtmlAssets(input: {
  baseScriptFileName: string;
  bundle: OutputBundle;
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
      (match, _quote, _hrefQuote, href) =>
        endsWithAnyFileName(href, input.removedChunkFileNames) ? "" : match,
    );
    html = html.replace(
      /<script\b[^>]*type=(["'])module\1[^>]*src=(["'])([^"']+)\2[^>]*><\/script>/giu,
      (match, _quote, _srcQuote, src) =>
        endsWithAnyFileName(src, input.removedChunkFileNames) ? "" : match,
    );

    const scriptTag = `<script defer src="${joinPublicPath(
      input.publicPath,
      input.baseScriptFileName,
    )}"></script>`;
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
