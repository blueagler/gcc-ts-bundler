import { isString } from "../../shared/validation";
import type {
  NormalizedOutputOptions,
  PreRenderedChunk,
} from "../internal-types";
import { normalizeOutputFileName } from "./sanitize";

export type RenderableChunkInfo = PreRenderedChunk;

export function renderPatternFileName(
  pattern:
    | NormalizedOutputOptions["chunkFileNames"]
    | NormalizedOutputOptions["entryFileNames"],
  chunkInfo: RenderableChunkInfo,
  contentHash: string,
  format: NormalizedOutputOptions["format"],
) {
  const rendered = isString(pattern) ? pattern : pattern(chunkInfo);
  return normalizeOutputFileName(
    rendered.replace(/\[(name|format|ext|extname|hash(?::\d+)?)\]/gu, (token) =>
      renderTokenReplacement(token, chunkInfo, contentHash, format),
    ),
  );
}

function renderTokenReplacement(
  token: string,
  chunkInfo: RenderableChunkInfo,
  contentHash: string,
  format: NormalizedOutputOptions["format"],
) {
  if (token === "[name]") {
    return chunkInfo.name;
  }
  if (token === "[format]") {
    return String(format ?? "es");
  }
  if (token === "[ext]") {
    return "js";
  }
  if (token === "[extname]") {
    return ".js";
  }
  const hashMatch = token.match(/^\[hash(?::(\d+))?\]$/u);
  if (hashMatch) {
    const hashLength = Number(hashMatch[1] ?? "8");
    return contentHash.slice(0, hashLength);
  }
  return token;
}
