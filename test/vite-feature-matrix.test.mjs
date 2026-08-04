import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { createFixture, execFileAsync } from "./helpers.mjs";

const WORKER_ENTRY_GRAPH_ERROR =
  "gccTsBundler() does not support worker entry graphs in Vite build mode.";

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
      continue;
    }
    files.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildViteFixture(fixture, options = {}) {
  const viteBin = path.join(
    process.cwd(),
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  const pluginUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "vite", "index.mjs"),
  ).href;
  const pluginEntries = options.pluginEntries ?? (options.withPlugin === false
    ? []
    : ["gccTsBundler({ compiler: { cache: { mode: \"off\" } } })"]);
  await fixture.write(
    "vite.config.mjs",
    [
      ...(options.withPlugin === false
        ? []
        : [
            `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
            "",
          ]),
      "export default {",
      ...(options.configLines ?? []),
      ...(pluginEntries.length === 0
        ? []
        : [
            "  plugins: [",
            ...pluginEntries.map((entry) => `    ${entry},`),
            "  ],",
          ]),
      "  build: {",
      '    outDir: "dist",',
      '    target: "es2018",',
      ...(options.buildLines ?? []),
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  try {
    await execFileAsync(process.execPath, [viteBin, "build"], {
      cwd: fixture.projectRoot,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return { ok: true };
  } catch (error) {
    return { error, ok: false };
  }
}

function buildErrorText(result) {
  if (!result.error) {
    return "";
  }
  return [result.error.stdout, result.error.stderr, result.error.message]
    .filter((value) => typeof value === "string")
    .join("\n");
}

async function writeHtmlFixture(fixture, source = "/src/main.js") {
  await fixture.write(
    "index.html",
    `<script type="module" src="${source}"></script>\n`,
  );
}

async function readJavaScript(fixture) {
  const files = (await listFiles(fixture.outDir)).filter((filePath) =>
    filePath.endsWith(".js"),
  );
  return await Promise.all(
    files.map((filePath) => fixture.read(path.join("dist", filePath))),
  );
}

async function executeFixtureInChromium(fixture, expectedText) {
  const chromium = await findChromiumExecutable();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath =
        url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(fixture.outDir, relativePath);
      const outDirPrefix = `${path.resolve(fixture.outDir)}${path.sep}`;
      if (!filePath.startsWith(outDirPrefix)) {
        response.writeHead(403).end();
        return;
      }
      const source = await fs.readFile(filePath);
      response.setHeader(
        "content-type",
        filePath.endsWith(".html")
          ? "text/html"
          : filePath.endsWith(".js")
            ? "text/javascript"
            : "application/octet-stream",
      );
      response.end(source);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine Chromium fixture server port.");
    }
    const { stdout } = await execFileAsync(
      chromium,
      [
        "--headless=new",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-sandbox",
        "--no-proxy-server",
        `--user-data-dir=${path.join(fixture.projectRoot, "chromium-profile")}`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/`,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    );
    expect(stdout).toContain(expectedText);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function findChromiumExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next conventional browser path.
    }
  }
  throw new Error(
    "Feature-matrix browser execution requires Chromium; set CHROME_BIN to its executable path.",
  );
}

test.serial(
  "Vite suffix transforms preserve url, raw, and inline assets",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      [
        'import assetUrl from "./asset.svg?url";',
        'import rawCss from "./asset.css?raw";',
        'import inlineAsset from "./asset.svg?inline";',
        "globalThis.__suffixMatrix = [assetUrl, rawCss, inlineAsset];",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/asset.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>suffix</text></svg>\n',
    );
    await fixture.write("src/asset.css", "/* raw-css-marker */\n");

    expect(
      (await buildViteFixture(fixture, { buildLines: ["    assetsInlineLimit: 0,"] }))
        .ok,
    ).toBe(true);
    const files = await listFiles(fixture.outDir);
    const source = (await readJavaScript(fixture)).join("\n");
    expect(files.some((filePath) => filePath.endsWith(".svg"))).toBe(true);
    expect(source).toContain("raw-css-marker");
    expect(source).toContain("data:image/svg+xml");
    expect(source).not.toContain("__VITE_ASSET__");
  },
);

test.serial(
  "Vite eager and lazy globs retain mixed TypeScript, JSON, and CSS surfaces",
  { timeout: 30000 },
  async () => {
    for (const mode of ["eager", "lazy"]) {
      const fixture = await createFixture();
      await writeHtmlFixture(fixture);
      await fixture.write(
        "src/main.js",
        mode === "eager"
          ? [
              'const modules = import.meta.glob("./modules/*", { eager: true });',
              "globalThis.__eagerGlob = Object.keys(modules);",
              "",
            ].join("\n")
          : [
              'const modules = import.meta.glob("./modules/*");',
              "globalThis.__lazyGlob = modules;",
              "",
            ].join("\n"),
      );
      await fixture.write("src/modules/value.ts", 'export const value = "glob-ts";\n');
      await fixture.write("src/modules/value.json", '{"value":"glob-json"}\n');
      await fixture.write("src/modules/value.css", "/* glob-css-marker */\n");

      expect((await buildViteFixture(fixture)).ok).toBe(true);
      const files = await listFiles(fixture.outDir);
      const source = (await readJavaScript(fixture)).join("\n");
      expect(files.some((filePath) => filePath.endsWith(".css"))).toBe(true);
      expect(source).toContain("glob-ts");
      expect(source).toContain("glob-json");
      if (mode === "lazy") {
        expect(files.filter((filePath) => filePath.endsWith(".js")).length).toBeGreaterThan(1);
      }
    }
  },
);

test.serial(
  "Vite runtime elision is capability-derived and lazy chunks restore the loader",
  { timeout: 30000 },
  async () => {
    const eagerFixture = await createFixture();
    await writeHtmlFixture(eagerFixture);
    await eagerFixture.write(
      "src/main.js",
      'globalThis.__runtimeElisionEager = "ready";\n',
    );
    expect((await buildViteFixture(eagerFixture)).ok).toBe(true);
    const eagerJavaScript = await readJavaScript(eagerFixture);
    expect(eagerJavaScript).toHaveLength(1);
    expect(eagerJavaScript[0]).not.toContain("globalThis.__g");
    expect(eagerJavaScript[0]).not.toContain('globalThis["__g"]');

    const lazyFixture = await createFixture();
    await writeHtmlFixture(lazyFixture);
    await lazyFixture.write(
      "src/main.js",
      'globalThis["__loadRuntimeElisionLazy"] = () => import("./lazy.js").then((module) => module.value);\n',
    );
    await lazyFixture.write("src/lazy.js", 'export const value = "lazy-ready";\n');
    expect((await buildViteFixture(lazyFixture)).ok).toBe(true);
    const lazyFiles = (await listFiles(lazyFixture.outDir)).filter((filePath) =>
      filePath.endsWith(".js"),
    );
    expect(lazyFiles.length).toBeGreaterThan(1);
    const lazySources = await Promise.all(
      lazyFiles.map((filePath) =>
        lazyFixture.read(path.join("dist", filePath)),
      ),
    );
    const lazyHtml = await lazyFixture.read("dist/index.html");
    const entryUrl = lazyHtml.match(/<script[^>]+src="([^"]+\.js)"/u)?.[1];
    expect(entryUrl).toBeDefined();
    const entryFile = entryUrl.replace(/^\//u, "");
    const entryIndex = lazyFiles.indexOf(entryFile);
    expect(entryIndex).toBeGreaterThanOrEqual(0);
    expect(lazySources[entryIndex]).toContain("globalThis.__g");

    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousLoader = globalThis.__loadRuntimeElisionLazy;
    try {
      globalThis.location = {
        href: pathToFileURL(path.join(lazyFixture.outDir, "index.html")).href,
      };
      delete globalThis.__g;
      delete globalThis.__loadRuntimeElisionLazy;
      await import(
        `${pathToFileURL(path.join(lazyFixture.outDir, entryFile)).href}?runtime-elision=${Date.now()}`
      );
      expect(await globalThis.__loadRuntimeElisionLazy()).toBe("lazy-ready");
    } finally {
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      if (previousLoader === undefined) delete globalThis.__loadRuntimeElisionLazy;
      else globalThis.__loadRuntimeElisionLazy = previousLoader;
    }
  },
);

test.serial(
  "Vite preserves env, define, JSON named imports, and dynamic import forms",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      [
        'import { named } from "./data.json";',
        "const stem = \"template\";",
        "globalThis.__featureMatrix = {",
        "  flag: __FEATURE_MATRIX_FLAG__,",
        "  mode: import.meta.env.MODE,",
        "  named,",
        '  literal: () => import("./literal.ts"),',
        "  template: () => import(`./${stem}.ts`),",
        "};",
        "",
      ].join("\n"),
    );
    await fixture.write("src/data.json", '{"named":"json-named-import"}\n');
    await fixture.write("src/literal.ts", 'export const literal = "dynamic-literal";\n');
    await fixture.write(
      "src/template.ts",
      'export const template = "dynamic-template";\n',
    );

    expect(
      (
        await buildViteFixture(fixture, {
          configLines: ['  define: { __FEATURE_MATRIX_FLAG__: "true" },'],
        })
      ).ok,
    ).toBe(true);
    const files = await listFiles(fixture.outDir);
    const source = (await readJavaScript(fixture)).join("\n");
    expect(files.filter((filePath) => filePath.endsWith(".js")).length).toBeGreaterThan(1);
    expect(source).toContain("json-named-import");
    expect(source).toContain("dynamic-literal");
    expect(source).toContain("dynamic-template");
    expect(source).not.toContain("__FEATURE_MATRIX_FLAG__");
    expect(source).not.toContain("import.meta.env.MODE");
  },
);

test.serial(
  "Vite URL-form workers execute in-browser and non-root public URLs remain buildable",
  { timeout: 30000 },
  async () => {
    const workerFixture = await createFixture();
    await writeHtmlFixture(workerFixture);
    await workerFixture.write(
      "src/main.js",
      [
        'const status = document.createElement("output");',
        'status.textContent = "worker-waiting";',
        "document.body.append(status);",
        'const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });',
        'worker.onmessage = (event) => { status.textContent = event.data; };',
        'worker.onerror = () => { status.textContent = "worker-error"; };',
        "",
      ].join("\n"),
    );
    await workerFixture.write(
      "src/worker.ts",
      'self.postMessage("url-worker-surface");\n',
    );
    expect((await buildViteFixture(workerFixture)).ok).toBe(true);
    expect(
      (await listFiles(workerFixture.outDir)).filter((filePath) =>
        filePath.endsWith(".js"),
      ).length,
    ).toBeGreaterThan(1);
    const workerJavaScript = (await readJavaScript(workerFixture)).join("\n");
    expect(workerJavaScript).toContain("globalThis.__g");
    expect(workerJavaScript).not.toContain("__VITE_WORKER_ASSET__");
    await executeFixtureInChromium(workerFixture, "url-worker-surface");

    const publicFixture = await createFixture();
    await writeHtmlFixture(publicFixture);
    await publicFixture.write(
      "src/main.js",
      'globalThis.__publicUrl = new URL("/public-marker.txt", import.meta.url).href;\n',
    );
    await publicFixture.write("public/public-marker.txt", "public marker\n");
    expect(
      (
        await buildViteFixture(publicFixture, {
          configLines: ['  base: "/sub/",'],
        })
      ).ok,
    ).toBe(true);
    expect(await publicFixture.read("dist/public-marker.txt")).toBe("public marker\n");
    expect((await readJavaScript(publicFixture)).join("\n")).toContain(
      "/sub/public-marker.txt",
    );
  },
);

test.serial(
  "Vite worker suffix imports remain expected rejections",
  { timeout: 30000 },
  async () => {
    // Planned Vite-plugin milestone: materialize Vite's worker wrapper module
    // onto the existing URL-form worker-chunk path; standalone builds remain
    // intentionally out of scope.
    for (const suffix of ["?worker", "?worker&inline"]) {
      const fixture = await createFixture();
      await writeHtmlFixture(fixture);
      await fixture.write(
        "src/main.js",
        `import worker from "./worker.ts${suffix}"; globalThis.__worker = worker;\n`,
      );
      await fixture.write("src/worker.ts", "self.postMessage(\"suffix\");\n");

      const result = await buildViteFixture(fixture);
      expect(result.ok).toBe(false);
      expect(buildErrorText(result)).toContain(WORKER_ENTRY_GRAPH_ERROR);
    }
  },
);

test.serial(
  "Vite plugin virtual modules, transforms, CSS, and output hooks retain their boundaries",
  { timeout: 30000 },
  async () => {
    const virtualPlugin = [
      "{",
      '  name: "inline-virtual-module",',
      '  resolveId(id) { return id === "virtual:hello" ? "\\0virtual:hello" : null; },',
      '  load(id) { return id === "\\0virtual:hello" ? "console.log(\\\"virtual-ok\\\");" : null; }',
      "}",
    ].join("\n");
    const preTransformPlugin = [
      "{",
      '  name: "inline-pre-transform",',
      '  enforce: "pre",',
      '  transform(code, id) { return id.endsWith("/src/main.js") ? code + "\\nconsole.log(\\\"pre-seen\\\");" : null; }',
      "}",
    ].join("\n");
    const postTransformPlugin = [
      "{",
      '  name: "inline-post-transform",',
      '  enforce: "post",',
      '  transform(code, id) { return id.endsWith("/src/main.js") ? code + "\\nconsole.log(\\\"post-seen\\\");" : null; }',
      "}",
    ].join("\n");
    const virtualCssPlugin = [
      "{",
      '  name: "inline-virtual-css",',
      '  resolveId(id) { return id === "virtual:plugin.css" ? "\\0virtual:plugin.css" : null; },',
      '  load(id) { return id === "\\0virtual:plugin.css" ? ".virtual-css-marker { color: rebeccapurple; }" : null; }',
      "}",
    ].join("\n");
    const gccPlugin = 'gccTsBundler({ compiler: { cache: { mode: "off" } } })';

    const virtualFixture = await createFixture();
    await writeHtmlFixture(virtualFixture);
    await virtualFixture.write("src/main.js", 'import "virtual:hello";\n');
    expect(
      (await buildViteFixture(virtualFixture, {
        pluginEntries: [virtualPlugin, gccPlugin],
      })).ok,
    ).toBe(true);
    expect((await readJavaScript(virtualFixture)).join("\\n")).toContain("virtual-ok");

    const preFixture = await createFixture();
    await writeHtmlFixture(preFixture);
    await preFixture.write("src/main.js", 'console.log("app");\n');
    expect(
      (await buildViteFixture(preFixture, {
        pluginEntries: [preTransformPlugin, gccPlugin],
      })).ok,
    ).toBe(true);
    expect((await readJavaScript(preFixture)).join("\\n")).toContain("pre-seen");

    const postFixture = await createFixture();
    await writeHtmlFixture(postFixture);
    await postFixture.write("src/main.js", 'console.log("app");\n');
    expect(
      (await buildViteFixture(postFixture, {
        withPlugin: false,
        pluginEntries: [postTransformPlugin],
      })).ok,
    ).toBe(true);
    expect((await readJavaScript(postFixture)).join("\\n")).toContain("post-seen");
    expect(
      (await buildViteFixture(postFixture, {
        pluginEntries: [gccPlugin, postTransformPlugin],
      })).ok,
    ).toBe(true);
    // gcc replaces chunks in generateBundle, structurally after transform hooks run.
    expect((await readJavaScript(postFixture)).join("\\n")).not.toContain("post-seen");

    const cssFixture = await createFixture();
    await writeHtmlFixture(cssFixture);
    await cssFixture.write(
      "src/main.js",
      'import "virtual:plugin.css"; console.log("css-ok");\n',
    );
    expect(
      (await buildViteFixture(cssFixture, {
        pluginEntries: [virtualCssPlugin, gccPlugin],
      })).ok,
    ).toBe(true);
    const cssFiles = await listFiles(cssFixture.outDir);
    expect(cssFiles.some((filePath) => filePath.endsWith(".css"))).toBe(true);
    expect(
      (await Promise.all(
        cssFiles
          .filter((filePath) => filePath.endsWith(".css"))
          .map((filePath) => cssFixture.read(path.join("dist", filePath))),
      )).join("\\n"),
    ).toContain("virtual-css-marker");

    const compressionPlugin = [
      "{",
      '  name: "inline-gzip-postprocessor",',
      '  enforce: "post",',
      '  generateBundle: { order: "post", handler() {} },',
      '  async writeBundle(outputOptions) {',
      '    const { readFile, readdir, writeFile } = await import("node:fs/promises");',
      '    const { join } = await import("node:path");',
      '    const { gzipSync } = await import("node:zlib");',
      '    for (const fileName of await readdir(outputOptions.dir, { recursive: true })) {',
      '      if (fileName.endsWith(".js")) {',
      '        const filePath = join(outputOptions.dir, fileName);',
      '        await writeFile(filePath + ".gz", gzipSync(await readFile(filePath)));',
      "      }",
      "    }",
      "  },",
      "}",
    ].join("\n");
    const compressionFixture = await createFixture();
    await writeHtmlFixture(compressionFixture);
    await compressionFixture.write("src/main.js", 'console.log("gzip-final");\n');
    expect(
      (await buildViteFixture(compressionFixture, {
        pluginEntries: [gccPlugin, compressionPlugin],
      })).ok,
    ).toBe(true);
    const compressionFiles = await listFiles(compressionFixture.outDir);
    const jsFile = compressionFiles.find((filePath) => filePath.endsWith(".js"));
    expect(jsFile).toBeDefined();
    const gzipFile = compressionFiles.find((filePath) => filePath.endsWith(".gz"));
    expect(gzipFile).toBeDefined();
    const { gunzipSync } = await import("node:zlib");
    const finalJavaScript = await fs.readFile(path.join(compressionFixture.outDir, jsFile));
    const compressedJavaScript = await fs.readFile(
      path.join(compressionFixture.outDir, gzipFile),
    );
    expect(gunzipSync(compressedJavaScript).equals(finalJavaScript)).toBe(true);

    const renderChunkPlugin = [
      "{",
      '  name: "inline-render-chunk-mutator",',
      '  renderChunk(code) { return { code: "/* renderchunk-marker */" + code, map: null }; },',
      '  generateBundle(_, bundle) {',
      '    const chunk = Object.values(bundle).find((output) => output.type === "chunk");',
      '    this.emitFile({ type: "asset", fileName: "renderchunk-state.json", source: JSON.stringify({ markerObserved: chunk.code.includes("renderchunk-marker") }) });',
      "  }",
      "}",
    ].join("\n");
    const renderFixture = await createFixture();
    await writeHtmlFixture(renderFixture);
    await renderFixture.write("src/main.js", 'console.log("render-chunk");\n');
    expect(
      (await buildViteFixture(renderFixture, {
        withPlugin: false,
        pluginEntries: [renderChunkPlugin],
      })).ok,
    ).toBe(true);
    const baselineRenderState = JSON.parse(
      await renderFixture.read("dist/renderchunk-state.json"),
    );
    expect(
      (await buildViteFixture(renderFixture, {
        pluginEntries: [gccPlugin, renderChunkPlugin],
      })).ok,
    ).toBe(true);
    const gccRenderState = JSON.parse(
      await renderFixture.read("dist/renderchunk-state.json"),
    );
    // Vite/Rolldown invokes the hook but bypasses its replacement in both builds.
    expect(baselineRenderState.markerObserved).toBe(false);
    expect(gccRenderState).toEqual(baselineRenderState);
  },
);

test.serial(
  "Vite vite-plugin-wasm-style top-level await builds and executes through a preserved ESM edge",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      'import wasmAnswer, { answer as namedAnswer } from "virtual:vite-plugin-wasm"; import * as wasmNamespace from "virtual:vite-plugin-wasm"; globalThis["__wasmAnswer"] = [wasmAnswer(), namedAnswer(), wasmNamespace.answer()]; document.body.textContent = `wasm-${globalThis["__wasmAnswer"].join("-")}`;\n',
    );
    const wasmPlugin = [
      "{",
      '  name: "vite-plugin-wasm-tla-fixture",',
      '  resolveId(id) { return id === "virtual:vite-plugin-wasm" ? "\\0virtual:vite-plugin-wasm" : null; },',
      '  load(id) { return id === "\\0virtual:vite-plugin-wasm" ? "const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]); const { instance } = await WebAssembly.instantiate(bytes); const answer = instance.exports.answer; export { answer }; export default answer;" : null; }',
      "}",
    ].join("\n");
    expect(
      (await buildViteFixture(fixture, {
        withPlugin: false,
        pluginEntries: [wasmPlugin],
        buildLines: ['    target: "esnext",'],
      })).ok,
    ).toBe(true);
    const cacheDir = path.join(fixture.projectRoot, "compiler-cache");
    const gcc = await buildViteFixture(fixture, {
      pluginEntries: [
        wasmPlugin,
        `gccTsBundler({ compiler: { cache: { mode: "persistent", dir: ${JSON.stringify(cacheDir)} } } })`,
      ],
      buildLines: ['    target: "esnext",'],
    });
    expect(gcc.ok).toBe(true);
    const files = await listFiles(fixture.outDir);
    const entryFile = files.find(
      (filePath) =>
        filePath.endsWith(".js") && !filePath.startsWith("__gcc_preserved/"),
    );
    const preservedFile = files.find((filePath) =>
      filePath.startsWith("__gcc_preserved/"),
    );
    expect(entryFile).toBeDefined();
    expect(preservedFile).toBeDefined();
    const entrySource = await fixture.read(path.join("dist", entryFile));
    expect(entrySource).toContain("__gcc_preserved/");
    expect(entrySource).toContain("globalThis.__g");
    const cacheFiles = await listFiles(cacheDir);
    const nativeExtern = cacheFiles.find((filePath) =>
      filePath.endsWith("native-generated.externs.js"),
    );
    expect(nativeExtern).toBeDefined();
    const externText = await fs.readFile(path.join(cacheDir, nativeExtern), "utf8");
    expect(externText).toContain("// Preserved ESM import bindings.");
    expect(externText.match(/var __gcc_preserved_/gu)?.length).toBe(3);
    expect(externText).toMatch(/__gcc_preserved_[\w$]+\.answer;/u);
    const preservedUrl = pathToFileURL(
      path.join(fixture.outDir, preservedFile),
    ).href;
    const preserved = await import(
      `${preservedUrl}?preserved-wasm=${Date.now()}`
    );
    expect(preserved.default()).toBe(42);
    expect(preserved.answer()).toBe(42);
    await executeFixtureInChromium(fixture, "wasm-42-42-42");
  },
);

test.serial(
  "Vite top-level for-await-of builds through a preserved ESM edge",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      'import value from "virtual:for-await"; globalThis["__forAwait"] = value;\n',
    );
    const forAwaitPlugin = [
      "{",
      '  name: "virtual-for-await",',
      '  resolveId(id) { return id === "virtual:for-await" ? "\\0virtual:for-await" : null; },',
      '  load(id) { return id === "\\0virtual:for-await" ? "const values = []; try { if (true) { for await (const value of [Promise.resolve(2), Promise.resolve(3)]) { values.push(value); } } } finally {} export default values.join(\',\');" : null; }',
      "}",
    ].join("\n");
    const result = await buildViteFixture(fixture, {
      pluginEntries: [
        forAwaitPlugin,
        'gccTsBundler({ compiler: { cache: { mode: "off" } } })',
      ],
      buildLines: ['    target: "esnext",'],
    });
    expect(result.ok).toBe(true);
    const files = await listFiles(fixture.outDir);
    const entryFile = files.find(
      (filePath) =>
        filePath.endsWith(".js") && !filePath.startsWith("__gcc_preserved/"),
    );
    const preservedFile = files.find((filePath) =>
      filePath.startsWith("__gcc_preserved/"),
    );
    expect(entryFile).toBeDefined();
    expect(preservedFile).toBeDefined();
    expect(await fixture.read(path.join("dist", entryFile))).toContain(
      "__gcc_preserved/",
    );
    expect(await fixture.read(path.join("dist", preservedFile))).toContain(
      "for await",
    );
    const preservedUrl = pathToFileURL(
      path.join(fixture.outDir, preservedFile),
    ).href;
    const preserved = await import(
      `${preservedUrl}?preserved-for-await=${Date.now()}`
    );
    expect(preserved.default).toBe("2,3");
  },
);

test.serial(
  "Vite nested await stays in the compiled graph",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      'import { nested } from "virtual:nested-await"; globalThis["__nestedAwait"] = nested;\n',
    );
    const nestedPlugin = [
      "{",
      '  name: "virtual-nested-await",',
      '  resolveId(id) { return id === "virtual:nested-await" ? "\\0virtual:nested-await" : null; },',
      '  load(id) { return id === "\\0virtual:nested-await" ? "export async function nested() { return await Promise.resolve(3); }" : null; }',
      "}",
    ].join("\n");
    const result = await buildViteFixture(fixture, {
      pluginEntries: [
        nestedPlugin,
        'gccTsBundler({ compiler: { cache: { mode: "off" } } })',
      ],
      buildLines: ['    target: "esnext",'],
    });
    expect(result.ok).toBe(true);
    expect(
      (await listFiles(fixture.outDir)).some((filePath) =>
        filePath.startsWith("__gcc_preserved/"),
      ),
    ).toBe(false);
  },
);

test.serial(
  "Vite preserved and compiled cycles fail closed",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write("src/main.js", 'import "virtual:cycle-a";\n');
    const cyclePlugin = [
      "{",
      '  name: "virtual-preserved-cycle",',
      '  resolveId(id) { return id === "virtual:cycle-a" ? "\\0virtual:cycle-a" : id === "virtual:cycle-b" ? "\\0virtual:cycle-b" : null; },',
      '  load(id) { if (id === "\\0virtual:cycle-a") return "import { b } from \'virtual:cycle-b\'; export const a = await Promise.resolve(b);"; if (id === "\\0virtual:cycle-b") return "import { a } from \'virtual:cycle-a\'; export const b = a ?? 1;"; return null; }',
      "}",
    ].join("\n");
    const result = await buildViteFixture(fixture, {
      pluginEntries: [
        cyclePlugin,
        'gccTsBundler({ compiler: { cache: { mode: "off" } } })',
      ],
      buildLines: ['    target: "esnext",'],
    });
    expect(result.ok).toBe(false);
    expect(buildErrorText(result)).toContain(
      "Preserved/compiled module cycle is unsupported in phase 1",
    );
  },
);

test.serial(
  "Vite preserved modules fail closed for script output",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      'import value from "virtual:tla"; globalThis.__value = value;\n',
    );
    const tlaPlugin = [
      "{",
      '  name: "virtual-tla",',
      '  resolveId(id) { return id === "virtual:tla" ? "\\0virtual:tla" : null; },',
      '  load(id) { return id === "\\0virtual:tla" ? "export default await Promise.resolve(1);" : null; }',
      "}",
    ].join("\n");
    const result = await buildViteFixture(fixture, {
      pluginEntries: [
        tlaPlugin,
        'gccTsBundler({ compiler: { cache: { mode: "off" }, chunks: { outputType: "script" } } })',
      ],
      buildLines: ['    target: "esnext",'],
    });
    expect(result.ok).toBe(false);
    expect(buildErrorText(result)).toContain(
      'Preserved modules require ESM output. Set chunks.outputType to "esm".',
    );
  },
);

test.serial(
  "Vite WASM ?init works with stock Vite and gccTsBundler",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await writeHtmlFixture(fixture);
    await fixture.write(
      "src/main.js",
      'import init from "./module.wasm?init"; globalThis.__wasmInit = init;\n',
    );
    await fixture.write(
      "src/module.wasm",
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );

    const stock = await buildViteFixture(fixture, { withPlugin: false });
    if (!stock.ok) {
      // Skip-marked attribution: if stock Vite/Rolldown rejects this surface,
      // gccTsBundler must fail with the same diagnostic rather than own it.
      const gcc = await buildViteFixture(fixture);
      expect(gcc.ok).toBe(false);
      expect(buildErrorText(gcc)).toContain(buildErrorText(stock));
      return;
    }

    expect((await buildViteFixture(fixture)).ok).toBe(true);
  },
);
