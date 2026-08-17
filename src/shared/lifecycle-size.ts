import fs from "node:fs/promises";
import zlib from "node:zlib";

interface JsGraphStats {
  entryCount: number;
  forwardingModuleCount: number;
  lazyRootCount: number;
  moduleCount: number;
  totalBytes: number;
}

interface OutputChunkStats {
  entryFactoryCount: number;
  entryGzipBytes: number;
  entryRawBytes: number;
  lazyFactoryCount: number;
  lazyGzipBytes: number;
  lazyRawBytes: number;
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

/**
 * Measures both size axes, because they are not interchangeable and on real
 * workloads they disagree in sign: the Ant Design Pro trial app (2,352
 * modules, compiler v20260811) came out +31.3 KB gzip (+4.0%) while being
 * -79.4 KB raw (-3.3%) against a no-plugin baseline.
 *
 * - `*GzipBytes` is transfer cost: the bytes that cross the wire.
 * - `*RawBytes` is CPU cost: the bytes V8 parses and compiles after inflate.
 *
 * Reporting a single axis is how that 4.0% wire regression shipped with every
 * check green, so both are load-bearing and callers must not collapse them
 * into one number.
 */
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
  } satisfies OutputChunkStats;
}

function countRegisteredModuleFactories(sourceText: string) {
  return [...sourceText.matchAll(/\((\d+),function\(/gu)].length;
}

function gzipByteLength(sourceText: string) {
  return zlib.gzipSync(Buffer.from(sourceText), { level: 9 }).byteLength;
}
