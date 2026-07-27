import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

import { compile, preprocess } from "svelte/compiler";
import { build as bundleWithEsbuild } from "esbuild";
import { functionsMixins } from "vite-plugin-functions-mixins";

import { build, generateExterns } from "../../dist/index.mjs";
import {
  collectJsGraphStats,
  collectOutputChunkStats,
} from "../../dist/shared/lifecycle-size.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(projectRoot, "src");
const m3CompiledDir = path.join(projectRoot, ".m3-compiled");
const m3CompiledPackageDir = path.join(m3CompiledDir, "package");
const m3PackageDir = path.join(
  projectRoot,
  "node_modules",
  "m3-svelte",
  "package",
);
const prebundleDir = path.join(projectRoot, ".prebundle");
const prebundleEntry = path.join(prebundleDir, "main.js");
const generatedExternsFile = path.join(
  projectRoot,
  "svelte.generated.externs.js",
);
const m3ThemeSnippet = `
:root {
  color-scheme: light;
  --m3-font: "Inter", system-ui;
  --m3c-primary: #315da8;
  --m3c-on-primary: #ffffff;
  --m3c-on-on-primary: #ffffff;
  --m3c-primary-container: #d8e2ff;
  --m3c-on-primary-container: #001a41;
  --m3c-primary-container-subtle: #edf2ff;
  --m3c-on-primary-container-subtle: #29446f;
  --m3c-primary-fixed: #d8e2ff;
  --m3c-primary-fixed-dim: #aec6ff;
  --m3c-on-primary-fixed: #001a41;
  --m3c-on-primary-fixed-variant: #29446f;
  --m3c-primary-dim: #5479c4;

  --m3c-secondary: #4f607c;
  --m3c-on-secondary: #ffffff;
  --m3c-secondary-container: #d6e4ff;
  --m3c-on-secondary-container: #0d1d35;
  --m3c-secondary-container-subtle: #eef4ff;
  --m3c-on-secondary-container-subtle: #40506a;
  --m3c-secondary-fixed: #d6e4ff;
  --m3c-secondary-fixed-dim: #bac8e9;
  --m3c-on-secondary-fixed: #0d1d35;
  --m3c-on-secondary-fixed-variant: #374863;
  --m3c-secondary-dim: #6d7f9b;

  --m3c-tertiary: #67587d;
  --m3c-on-tertiary: #ffffff;
  --m3c-tertiary-container: #eddcff;
  --m3c-on-tertiary-container: #211633;
  --m3c-tertiary-container-subtle: #f6ecff;
  --m3c-on-tertiary-container-subtle: #56486b;
  --m3c-tertiary-fixed: #eddcff;
  --m3c-tertiary-fixed-dim: #d2bde8;
  --m3c-on-tertiary-fixed: #211633;
  --m3c-on-tertiary-fixed-variant: #4e4064;
  --m3c-tertiary-dim: #7f6f97;

  --m3c-error: #ba1a1a;
  --m3c-on-error: #ffffff;
  --m3c-error-container: #ffdad6;
  --m3c-on-error-container: #410002;
  --m3c-error-container-subtle: #fff0ee;
  --m3c-on-error-container-subtle: #8f2f25;
  --m3c-error-dim: #d64d40;

  --m3c-surface: #fbf8ff;
  --m3c-surface-dim: #ddd9e2;
  --m3c-surface-bright: #fbf8ff;
  --m3c-surface-container-lowest: #ffffff;
  --m3c-surface-container-low: #f5f2fb;
  --m3c-surface-container: #efecf5;
  --m3c-surface-container-high: #e9e6ef;
  --m3c-surface-container-highest: #e3e0e9;
  --m3c-on-surface: #1a1b21;
  --m3c-on-surface-container: #1a1b21;
  --m3c-on-surface-variant: #44474f;
  --m3c-outline: #74777f;
  --m3c-outline-variant: #c4c6d0;
  --m3c-shadow: #000000;
  --m3c-scrim: #000000;
  --m3c-inverse-surface: #2f3036;
  --m3c-inverse-on-surface: #f1f0f7;
  --m3c-inverse-primary: #aec6ff;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at top left, rgba(216, 226, 255, 0.9), transparent 38%),
    radial-gradient(circle at bottom right, rgba(237, 220, 255, 0.72), transparent 32%),
    #f6f7fb;
  font-family: var(--m3-font);
}
`;

const transformSource = await createMixinsTransformer(projectRoot);

await fs.rm(m3CompiledDir, { force: true, recursive: true });
await fs.mkdir(m3CompiledDir, { recursive: true });
await compileSvelteDirectory(srcDir, srcDir, transformSource);
await prepareM3SveltePackage(
  m3PackageDir,
  m3CompiledPackageDir,
  transformSource,
);
await writeM3ThemeModule(
  m3PackageDir,
  path.join(m3CompiledDir, "theme.js"),
  transformSource,
);
await logPureGraphSnapshot("compiled", [srcDir, m3CompiledDir], {
  lazyRootCount: 0,
});

await fs.rm(prebundleDir, { force: true, recursive: true });
await fs.mkdir(prebundleDir, { recursive: true });
await bundleWithEsbuild({
  bundle: true,
  chunkNames: "chunks/[name]-[hash]",
  entryPoints: [path.join(srcDir, "main.js")],
  format: "esm",
  outdir: prebundleDir,
  platform: "browser",
  splitting: true,
  target: "es2018",
});
await logPureGraphSnapshot("prebundle", [prebundleDir], {
  lazyRootCount: (await collectRuntimeEntries(prebundleDir)).length - 1,
});

await generateExterns({
  appEntryFiles: ["./main.js"],
  mode: "runtime-aware",
  modules: ["m3-svelte", "svelte"],
  outputFile: "./svelte.generated.externs.js",
  projectRoot,
  runtimeEntryFiles: await collectRuntimeEntries(prebundleDir),
  srcDir: "./src",
});

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "bundler-runtime" },
  diagnostics: { preflight: "full" },
  entries: ["./main.js"],
  externs: ["./svelte.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./.prebundle",
  languageOut: "ECMASCRIPT_NEXT",
});

if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    const where = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}: `
      : "";
    console.error(`${where}${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(
  `Built Svelte SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Bundled Svelte runtime through ${path.relative(projectRoot, prebundleEntry)}`,
);
console.log(
  `Generated externs at ${path.relative(projectRoot, generatedExternsFile)}`,
);
await logPureDistSnapshot();

async function compileSvelteDirectory(sourceDir, outDir, transformSourceCode) {
  await fs.mkdir(outDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outputPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      await compileSvelteDirectory(sourcePath, outputPath, transformSourceCode);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".svelte")) {
      continue;
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const compiledOutputFile = `${outputPath}.js`;
    const result = await compileSvelteSource(
      transformSourceCode(source, sourcePath),
      sourcePath,
      compiledOutputFile,
    );
    await fs.writeFile(
      compiledOutputFile,
      rewriteSvelteSpecifiers(result.js.code),
      "utf8",
    );
  }
}

async function prepareM3SveltePackage(sourceDir, outDir, transformSourceCode) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outputPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      await prepareM3SveltePackage(sourcePath, outputPath, transformSourceCode);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    if (entry.name.endsWith(".svelte")) {
      const source = await fs.readFile(sourcePath, "utf8");
      const compiledOutputFile = `${outputPath}.js`;
      const result = await compileSvelteSource(
        transformSourceCode(source, sourcePath),
        sourcePath,
        compiledOutputFile,
      );
      await fs.writeFile(
        compiledOutputFile,
        rewriteSvelteSpecifiers(result.js.code),
        "utf8",
      );
      continue;
    }

    if (entry.name.endsWith(".js")) {
      const source = await fs.readFile(sourcePath, "utf8");
      const rewrittenSource = rewriteSvelteSpecifiers(
        entry.name === "layer.js"
          ? source.replace(/^import ["']\.\/layer\.css["'];?\s*/u, "")
          : source,
      );
      await fs.writeFile(outputPath, rewrittenSource, "utf8");
    }
  }
}

async function compileSvelteSource(source, sourcePath, outputFile) {
  const preprocessed = await preprocess(
    source,
    {
      name: "typescript",
      script({ attributes, content }) {
        if (attributes.lang !== "ts" && attributes.lang !== "typescript") {
          return;
        }

        const result = ts.transpileModule(content, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
            verbatimModuleSyntax: true,
          },
          fileName: `${sourcePath}.ts`,
          reportDiagnostics: true,
        });
        const errors = (result.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        );
        if (errors.length > 0) {
          throw new Error(
            ts.formatDiagnosticsWithColorAndContext(errors, {
              getCanonicalFileName: (fileName) => fileName,
              getCurrentDirectory: () => projectRoot,
              getNewLine: () => "\n",
            }),
          );
        }

        return { code: result.outputText };
      },
    },
    { filename: sourcePath },
  );

  return compile(preprocessed.code, {
    css: "injected",
    filename: outputFile,
    generate: "dom",
    dev: false,
  });
}

async function collectRuntimeEntries(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const runtimeEntries = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      runtimeEntries.push(...(await collectRuntimeEntries(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      runtimeEntries.push(
        `./${path.relative(projectRoot, entryPath).replace(/\\/g, "/")}`,
      );
    }
  }
  return runtimeEntries.sort((left, right) => left.localeCompare(right));
}

async function writeM3ThemeModule(sourceDir, outputFile, transformSourceCode) {
  const styles = transformSourceCode(
    await fs.readFile(path.join(sourceDir, "etc", "styles.css"), "utf8"),
    path.join(sourceDir, "etc", "styles.css"),
  );
  const layer = transformSourceCode(
    await fs.readFile(path.join(sourceDir, "etc", "layer.css"), "utf8"),
    path.join(sourceDir, "etc", "layer.css"),
  );
  const themeCss = `${styles}\n${layer}\n${m3ThemeSnippet}`;
  const themeModule = `const themeId = "m3-svelte-demo-theme";
if (typeof document !== "undefined" && !document.getElementById(themeId)) {
  const style = document.createElement("style");
  style.id = themeId;
  style.textContent = ${JSON.stringify(themeCss)};
  document.head.appendChild(style);
}
`;
  await fs.writeFile(outputFile, themeModule, "utf8");
}

async function logPureGraphSnapshot(label, roots, { lazyRootCount }) {
  if (!process.env.GCC_BUILD_TIMINGS) {
    return;
  }

  const files = [];
  for (const root of roots) {
    files.push(...(await collectJsFiles(root)));
  }
  const uniqueFiles = [...new Set(files)].sort((left, right) =>
    left.localeCompare(right),
  );
  const forwardingCount = (
    await Promise.all(
      uniqueFiles.map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        return /^\s*(?:export\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*)+$/su.test(
          source,
        )
          ? 1
          : 0;
      }),
    )
  ).reduce((sum, count) => sum + count, 0);
  const graphStats = await collectJsGraphStats({
    entryCount: 1,
    filePaths: uniqueFiles,
    lazyRootCount,
  });
  console.log(
    `[gcc-ts-bundler timing] pure:${label}: modules=${graphStats.moduleCount} js=${graphStats.totalBytes} forwarding=${forwardingCount} entries=1 lazy=${lazyRootCount}`,
  );
}

async function collectJsFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function logPureDistSnapshot() {
  if (!process.env.GCC_BUILD_TIMINGS) {
    return;
  }

  const distDir = path.join(projectRoot, "dist");
  const jsFiles = await collectJsFiles(distDir);
  const entryFilePath = path.join(distDir, "main.js");
  const lazyFilePaths = jsFiles
    .filter((filePath) => filePath !== entryFilePath)
    .sort((left, right) => left.localeCompare(right));
  const outputStats = await collectOutputChunkStats({
    entryFilePath,
    lazyFilePaths,
  });
  console.log(
    `[gcc-ts-bundler timing] pure:dist: entry=${outputStats.entryRawBytes}/${outputStats.entryGzipBytes} lazy=${outputStats.lazyRawBytes}/${outputStats.lazyGzipBytes} factories=${outputStats.entryFactoryCount}+${outputStats.lazyFactoryCount}`,
  );
}

async function createMixinsTransformer(rootDir) {
  const plugin = functionsMixins({ deps: ["m3-svelte"] });
  plugin.configResolved?.({ plugins: [], root: rootDir });
  await plugin.buildStart?.();
  return (source, id) => {
    const result = plugin.transform?.(source, id);
    const nextSource =
      result && typeof result === "object" && "code" in result
        ? result.code
        : source;
    return nextSource.replace(/--m3-density\(([^()]+)\)/gu, "$1");
  };
}

function rewriteSvelteSpecifiers(source) {
  return source.replace(
    /(["'`])([^"'`]+\.svelte)\1/gu,
    (_match, quote, specifier) => `${quote}${specifier}.js${quote}`,
  );
}
