import path from "node:path";

import type { OutputAsset, OutputBundle, OutputChunk } from "../internal-types";

export function listJavaScriptChunks(bundle: OutputBundle) {
  return Object.values(bundle).filter(
    (item): item is OutputChunk => item.type === "chunk",
  );
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
