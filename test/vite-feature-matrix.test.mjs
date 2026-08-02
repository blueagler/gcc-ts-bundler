import fs from "node:fs/promises";
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
  const plugins = options.withPlugin === false
    ? []
    : [
        "  plugins: [gccTsBundler({ compiler: { cache: { mode: \"off\" } } })],",
      ];
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
      ...plugins,
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
  "Vite URL-form workers and non-root public URLs remain buildable",
  { timeout: 30000 },
  async () => {
    const workerFixture = await createFixture();
    await writeHtmlFixture(workerFixture);
    await workerFixture.write(
      "src/main.js",
      'globalThis.__worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n',
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
