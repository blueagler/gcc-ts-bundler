import fs from "node:fs/promises";
import zlib from "node:zlib";

export interface JsGraphStats {
  entryCount: number;
  forwardingModuleCount: number;
  lazyRootCount: number;
  moduleCount: number;
  totalBytes: number;
}

export interface OutputChunkStats {
  entryFactoryCount: number;
  entryGzipBytes: number;
  entryRawBytes: number;
  lazyFactoryCount: number;
  lazyGzipBytes: number;
  lazyRawBytes: number;
  totalFactoryCount: number;
  totalGzipBytes: number;
  totalRawBytes: number;
}

export async function collectJsGraphStats(input: {
  entryCount: number;
  filePaths: string[];
  forwardingModuleIds?: Iterable<string>;
  lazyRootCount: number;
}) {
  const totalBytes = (
    await Promise.all(
      input.filePaths.map(async (filePath) => {
        try {
          return (await fs.stat(filePath)).size;
        } catch {
          return 0;
        }
      }),
    )
  ).reduce((sum, size) => sum + size, 0);

  return {
    entryCount: input.entryCount,
    forwardingModuleCount: new Set(input.forwardingModuleIds ?? []).size,
    lazyRootCount: input.lazyRootCount,
    moduleCount: input.filePaths.length,
    totalBytes,
  } satisfies JsGraphStats;
}

export async function collectOutputChunkStats(input: {
  entryFilePath: string;
  lazyFilePaths: string[];
}) {
  const entrySource = await fs.readFile(input.entryFilePath, "utf8");
  const lazySources = await Promise.all(
    input.lazyFilePaths.map((filePath) => fs.readFile(filePath, "utf8")),
  );

  const entryRawBytes = Buffer.byteLength(entrySource);
  const entryGzipBytes = gzipByteLength(entrySource);
  const entryFactoryCount = countRegisteredModuleFactories(entrySource);
  const lazyRawBytes = lazySources.reduce(
    (sum, source) => sum + Buffer.byteLength(source),
    0,
  );
  const lazyGzipBytes = lazySources.reduce(
    (sum, source) => sum + gzipByteLength(source),
    0,
  );
  const lazyFactoryCount = lazySources.reduce(
    (sum, source) => sum + countRegisteredModuleFactories(source),
    0,
  );

  return {
    entryFactoryCount,
    entryGzipBytes,
    entryRawBytes,
    lazyFactoryCount,
    lazyGzipBytes,
    lazyRawBytes,
    totalFactoryCount: entryFactoryCount + lazyFactoryCount,
    totalGzipBytes: entryGzipBytes + lazyGzipBytes,
    totalRawBytes: entryRawBytes + lazyRawBytes,
  } satisfies OutputChunkStats;
}

export function countRegisteredModuleFactories(sourceText: string) {
  return [...sourceText.matchAll(/\((\d+),function\(/gu)].length;
}

function gzipByteLength(sourceText: string) {
  return zlib.gzipSync(Buffer.from(sourceText), { level: 9 }).byteLength;
}
