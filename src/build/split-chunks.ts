import syncFs from "fs";
import path from "path";

import { hashContent } from "../shared/hash";
import type { ChunkPlanChunk, LazyImport } from "./types";

/**
 * Split chunk mode: every module is emitted as a collapsible goog.module and
 * compiled as one Closure program with --chunk, so eager code gets flat-mode
 * optimization quality. Dynamic import is served by per-target registration
 * shims (compiled, so property renaming stays consistent) plus a small
 * handwritten prelude prepended to the base chunk after compilation.
 */

function lazyRegShimFileName(moduleId: string) {
  return `gcc_lazyreg_${moduleId.replace(/[^A-Za-z0-9_]/gu, "_")}.ts`;
}

/**
 * Like toImportPath, but strips only real JS/TS extensions so compound
 * names such as StudioPanel.vue.ts keep their .vue segment.
 */
function toLazyImportPath(relativePath: string) {
  const normalized = relativePath
    .replace(/\\/gu, "/")
    .replace(/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function dedupeLazyImports(lazyImports: readonly LazyImport[]): LazyImport[] {
  const byModuleId = new Map<string, LazyImport>();
  for (const lazyImport of lazyImports) {
    byModuleId.set(lazyImport.moduleId, lazyImport);
  }
  return [...byModuleId.values()];
}

/**
 * Adds the registration shims to every chunk that owns lazy module ids, and
 * makes them Closure entry points so PRUNE keeps the lazy graphs alive.
 */
export function patchSplitChunkPlan(
  chunks: ChunkPlanChunk[],
): ChunkPlanChunk[] {
  return chunks.map((chunk) => {
    const lazyIds = chunk.lazyModuleIds ?? [];
    if (lazyIds.length === 0) {
      return chunk;
    }
    const shimFiles = lazyIds.map(
      (moduleId) => `entries/${lazyRegShimFileName(moduleId)}`,
    );
    return {
      ...chunk,
      entryFiles: [...(chunk.entryFiles ?? []), ...shimFiles],
      files: [...chunk.files, ...shimFiles],
    };
  });
}

/** Writes one namespace-registration shim per lazy target. Returns paths. */
export function writeSplitLazyShims(input: {
  lazyImports: readonly LazyImport[];
  shimDir: string;
}): string[] {
  const lazyImports = dedupeLazyImports(input.lazyImports);
  if (lazyImports.length === 0) {
    return [];
  }
  syncFs.mkdirSync(input.shimDir, { recursive: true });
  return lazyImports.map((lazyImport) => {
    const shimPath = path.join(
      input.shimDir,
      lazyRegShimFileName(lazyImport.moduleId),
    );
    const importPath = toLazyImportPath(
      path.relative(input.shimDir, lazyImport.targetPath),
    );
    const source = [
      `import * as __gccLazyNs from ${JSON.stringify(importPath)};`,
      "",
      "declare const gccRegisterLazy: (",
      "  key: string,",
      "  moduleNamespace: unknown,",
      ") => void;",
      "",
      `gccRegisterLazy(${JSON.stringify(lazyImport.moduleId)}, __gccLazyNs);`,
      "",
    ].join("\n");
    syncFs.writeFileSync(shimPath, source);
    return shimPath;
  });
}

/**
 * The lazy loader prelude. Handwritten and pre-minified: it is prepended raw
 * to the compiled base chunk, so it never passes through Closure. Scripts are
 * appended with async=false, which fetches in parallel but preserves
 * execution order; resolution happens on registration, not on script onload.
 */
/**
 * Closure emits references to this namespace under
 * --rename_prefix_namespace but never declares it, so the base chunk must,
 * before any chunk body runs. Confining globals to one object is what keeps
 * plain-script chunks from colliding with renamed globalThis.* properties.
 */
// Assigned on globalThis rather than declared with `var`: an entry loaded as
// <script type="module"> has module-scoped top-level declarations, so a bare
// `var` would be invisible to lazy chunks injected as classic scripts.
const NAMESPACE_DECLARATION = "globalThis.$gcc=globalThis.$gcc||{};";

/**
 * Chunks ship as plain scripts, so a chunk's own top-level declarations would
 * become globals and can collide with renamed globalThis.* properties (Closure
 * renames the two from independent name pools). Wrapping each chunk body keeps
 * its locals local; cross-chunk symbols travel through $gcc instead.
 */
function wrapChunkBody(compiled: string) {
  return `(function(){${compiled}\n}).call(this);\n`;
}

function renderSplitPrelude(manifest: Record<string, string[]>) {
  const manifestJson = JSON.stringify(manifest);
  return (
    `${NAMESPACE_DECLARATION}` +
    "(function(){" +
    `var m=${manifestJson},r={},w={},l={};` +
    // Resolve chunk URLs against this script's own URL, not the document's.
    // A relative publicPath like "./" must mean "next to the base chunk",
    // which is often a subdirectory of the page that loaded it.
    "var B=document.currentScript&&document.currentScript.src||location.href;" +
    'function s(u){u=new URL(u,B).toString();return l[u]||(l[u]=new Promise(function(a,b){var e=document.createElement("script");' +
    "e.src=u;e.async=!1;e.onload=a;" +
    'e.onerror=function(){delete l[u];b(new Error("gcc chunk failed: "+u))};' +
    "document.head.appendChild(e)}))}" +
    // Assigned on globalThis, not declared: the base chunk may be loaded as a
    // module, whose top-level bindings are invisible to the classic scripts
    // used for lazy chunks.
    "globalThis.gccRegisterLazy=function(k,n){r[k]=n;var q=w[k];q&&q[1](n)};" +
    "globalThis.gccImportLazy=function(k){if(k in r)return Promise.resolve(r[k]);" +
    "var q=w[k];if(!q){var f,j,p=new Promise(function(a,b){f=a;j=b});q=w[k]=[p,f,j];" +
    "Promise.all((m[k]||[]).map(s)).catch(function(e){delete w[k];j(e)})}" +
    "return q[0]};})();\n"
  );
}

/**
 * Post-compile finalization: content-hash the lazy/shared chunk files, build
 * the module-key -> chunk-URL manifest, and prepend the prelude to the base
 * chunk. Returns the updated published output list.
 */
export async function finalizeSplitChunks(input: {
  chunkPlan: ChunkPlanChunk[];
  manifestFile: string;
  outDir: string;
  publicPath: string;
  publishedOutputs: string[];
}): Promise<string[]> {
  const fs = syncFs.promises;
  const fileNameByChunk = new Map<string, string>();
  for (const chunk of input.chunkPlan) {
    fileNameByChunk.set(chunk.name, `${chunk.name}.js`);
  }

  // Content-hash every non-base, non-entry chunk output, wrapping first so
  // the hash covers the shipped bytes.
  for (const chunk of input.chunkPlan) {
    if (chunk.kind !== "lazy" && chunk.kind !== "shared") {
      continue;
    }
    const currentPath = path.join(input.outDir, `${chunk.name}.js`);
    const wrapped = wrapChunkBody(await fs.readFile(currentPath, "utf8"));
    const hashedName = `${chunk.name}.${hashContent(wrapped).slice(0, 8)}.js`;
    await fs.writeFile(currentPath, wrapped);
    await fs.rename(currentPath, path.join(input.outDir, hashedName));
    fileNameByChunk.set(chunk.name, hashedName);
  }

  const chunkByName = new Map(
    input.chunkPlan.map((chunk) => [chunk.name, chunk]),
  );
  const loadableChain = (chunkName: string): string[] => {
    const chunk = chunkByName.get(chunkName);
    if (!chunk || (chunk.kind !== "lazy" && chunk.kind !== "shared")) {
      return [];
    }
    const urls = chunk.dependencies.flatMap(loadableChain);
    urls.push(input.publicPath + (fileNameByChunk.get(chunkName) ?? ""));
    return [...new Set(urls)];
  };

  const manifest: Record<string, string[]> = {};
  for (const chunk of input.chunkPlan) {
    for (const moduleId of chunk.lazyModuleIds ?? []) {
      manifest[moduleId] = loadableChain(chunk.name);
    }
  }

  // The base chunk always declares the rename-prefix namespace; the lazy
  // loader is added only when there is something to load.
  const baseChunk =
    input.chunkPlan.find((chunk) => chunk.kind === "base") ??
    input.chunkPlan[0];
  if (baseChunk) {
    const basePath = path.join(input.outDir, `${baseChunk.name}.js`);
    const compiled = await fs.readFile(basePath, "utf8");
    const prefix =
      Object.keys(manifest).length > 0
        ? renderSplitPrelude(manifest)
        : `${NAMESPACE_DECLARATION}\n`;
    await fs.writeFile(basePath, prefix + wrapChunkBody(compiled));
  }

  if (input.manifestFile) {
    await fs.writeFile(
      path.join(input.outDir, input.manifestFile),
      `${JSON.stringify({ chunks: manifest }, null, 2)}\n`,
    );
  }

  return input.publishedOutputs.map((outputPath) => {
    const chunkName = path.basename(outputPath, ".js");
    const finalName = fileNameByChunk.get(chunkName);
    return finalName
      ? path.join(path.dirname(outputPath), finalName)
      : outputPath;
  });
}
