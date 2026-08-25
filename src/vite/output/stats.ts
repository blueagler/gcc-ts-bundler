import fs from "node:fs/promises";
import path from "node:path";

import { collectOutputChunkStats } from "../../shared/lifecycle-size";
import { logInternalDetail } from "../../shared/timing";

import type { OutputBundle } from "../internal-types";

async function collectOutputByteBreakdown(input: {
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

export async function logOutputStats(input: {
  bundle: OutputBundle;
  emittedOutputFiles: string[];
  finalOutDir: string;
  finalScriptFileName: string;
}) {
  const outputBytes = await collectOutputByteBreakdown({
    bundle: input.bundle,
    emittedOutputFiles: input.emittedOutputFiles,
  });
  logInternalDetail(
    "vite:output-bytes",
    `js=${outputBytes.js} css=${outputBytes.css} fonts=${outputBytes.fonts} assets=${outputBytes.assets}`,
  );
  const finalBaseChunkFilePath = path.join(
    input.finalOutDir,
    input.finalScriptFileName,
  );
  const outputChunkStats = await collectOutputChunkStats({
    entryFilePath: finalBaseChunkFilePath,
    lazyFilePaths: input.emittedOutputFiles.filter(
      (filePath) =>
        filePath.endsWith(".js") && filePath !== finalBaseChunkFilePath,
    ),
  });
  logInternalDetail(
    "vite:output-js-chunks",
    `entry=${outputChunkStats.entryRawBytes}/${outputChunkStats.entryGzipBytes} lazy=${outputChunkStats.lazyRawBytes}/${outputChunkStats.lazyGzipBytes} factories=${outputChunkStats.entryFactoryCount}+${outputChunkStats.lazyFactoryCount}`,
  );
}
