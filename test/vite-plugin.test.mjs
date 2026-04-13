import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import {
  getCapturedModuleAnalysis,
  normalizeRetainedCapturedModules,
} from "../src/vite/capture.ts";
import { resolveNormalizedBridgeModuleIds } from "../src/vite/graph.ts";
import { materializeCapturedGraph } from "../src/vite/materialize.ts";
import { prebundleMaterializedDependencies } from "../src/vite/prebundle.ts";
import {
  VITE_FETCH_LOADER_ERROR,
  resolveViteLanguageOut,
  VITE_LANGUAGE_OUT_ERROR,
} from "../src/vite/config.ts";
import { createFixture, execFileAsync } from "./helpers.mjs";

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(rootDir, entryPath);
      files.push(...nested);
      continue;
    }
    files.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildViteFixture(fixture, overrides = {}) {
  const pluginUrl = pathToFileURL(
    path.join(process.cwd(), "dist/vite/index.mjs"),
  ).href;
  const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  await fixture.write(
    "vite.config.mjs",
    [
      `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
      "",
      "export default {",
      "  build: {",
      '    outDir: "dist",',
      '    target: "es2018",',
      ...(overrides.build?.cssCodeSplit === false
        ? ['    cssCodeSplit: false,']
        : []),
      ...(overrides.buildLines ?? []),
      "  },",
      "  plugins: [",
      "    gccTsBundler({",
      "      compiler: {",
      '        cache: { mode: "off" },',
      "      },",
      ...(overrides.debugDir
        ? [
            "      debug: {",
            `        dumpCapturedGraphDir: ${JSON.stringify(overrides.debugDir)},`,
            "      },",
          ]
        : []),
      "    }),",
      "  ],",
      "};",
      "",
    ].join("\n"),
  );

  await execFileAsync(process.execPath, [viteBin, "build"], {
    cwd: fixture.projectRoot,
  });
}

function readRewrittenEntryScript(html) {
  const match = html.match(/<script defer src="([^"]+)"><\/script>/u);
  expect(match).toBeTruthy();
  return match[1];
}

function toDistRelativeFile(publicPath) {
  return publicPath.replace(/^\/+/u, "");
}

async function writeViteCssFixture(fixture) {
  await fixture.write(
    "index.html",
    [
      '<!doctype html>',
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "  </head>",
      "  <body>",
      '    <div id="app"></div>',
      '    <script type="module" src="/src/main.js"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/main.js",
    [
      'import "./base.css";',
      'document.getElementById("app").innerHTML = "<button id=\\"load\\">Load</button>";',
      'globalThis.__loadFeature = () => import("./feature.js").then((module) => module.mount());',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.js",
    [
      'import "./feature.css";',
      "export function mount() {",
      '  const node = document.createElement("div");',
      '  node.className = "feature-panel";',
      '  node.textContent = "lazy feature";',
      "  document.body.appendChild(node);",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/base.css",
    [
      "body {",
      "  background: rgb(250, 250, 252);",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.css",
    [
      ".feature-panel {",
      "  color: rgb(120, 40, 180);",
      "}",
      "",
    ].join("\n"),
  );
}

async function readRuntimeModuleSourceMap(fixture, debugDir) {
  const source = await fixture.read(
    path.join(debugDir, ".gcc-ts-bundler-vite-runtime-module-sources.json"),
  );
  return JSON.parse(source);
}

function createCapturePluginContext() {
  return {
    error(message) {
      throw new Error(String(message));
    },
    async resolve(specifier, importer) {
      if (specifier.startsWith(".")) {
        return {
          external: false,
          id: path.resolve(path.dirname(importer), specifier),
        };
      }
      return null;
    },
  };
}

test("captured module analysis ignores comment-only hash text for compat downlevel", () => {
  const record = {
    code: '/** @import { ComponentContext } from "#client" */\nexport { value } from "./dep.js";\n',
    id: "/virtual/comment.js",
  };

  const analysis = getCapturedModuleAnalysis(record);
  expect(analysis.needsClosureCompatibilityDownlevel).toBe(false);
  expect(analysis.needsTypeScriptCompatibilityDownlevel).toBe(false);
  expect(analysis.importSpecifiers).toEqual(["./dep.js"]);
});

test.serial(
  "resolveNormalizedBridgeModuleIds follows bridge imports introduced by compat normalization",
  async () => {
    const fixture = await createFixture();
    const entryId = path.join(fixture.projectRoot, "src", "entry.js");
    const depId = path.join(fixture.projectRoot, "src", "dep.js");
    const capturedModules = new Map([
      [
        entryId,
        {
          code: [
            'export { dep } from "./dep.js";',
            "class Widget {",
            "  static {",
            "    this.ready = true;",
            "  }",
            "}",
            "",
          ].join("\n"),
          id: entryId,
        },
      ],
      [
        depId,
        {
          code: 'export const dep = "dep";\n',
          id: depId,
        },
      ],
    ]);

    const normalizedCapturedModules = await normalizeRetainedCapturedModules({
      capturedModules,
      moduleIds: [entryId],
    });
    const additionalBridgeModuleIds = await resolveNormalizedBridgeModuleIds.call(
      createCapturePluginContext(),
      {
        capturedModules,
        normalizedCapturedModules,
        resolutionCache: new Map(),
        retainedModuleIds: [entryId],
      },
    );

    expect(normalizedCapturedModules.get(entryId)?.code).toContain(
      'from "./dep.js"',
    );
    expect(additionalBridgeModuleIds).toContain(depId);
  },
);

test.serial(
  "prebundleMaterializedDependencies collapses retained dependency modules into region bundles",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const authoredLazy = path.join(srcDir, "src", "lazy.js");
    const depIndex = path.join(srcDir, "node_modules", "pkg", "index.js");
    const depFoo = path.join(srcDir, "node_modules", "pkg", "foo.js");
    const depBar = path.join(srcDir, "node_modules", "pkg", "bar.js");
    const depShared = path.join(srcDir, "node_modules", "pkg", "shared.js");
    const depHelper = path.join(srcDir, "node_modules", "pkg", "helper.js");

    await fs.mkdir(path.dirname(authoredEntry), { recursive: true });
    await fs.mkdir(path.dirname(depIndex), { recursive: true });

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import { foo } from "../node_modules/pkg/index.js";\nexport const entry = foo;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, authoredLazy),
      'import { bar } from "../node_modules/pkg/index.js";\nexport const lazy = bar;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depIndex),
      'export { foo } from "./foo.js";\nexport { bar } from "./bar.js";\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depFoo),
      'import { shared } from "./shared.js";\nimport { helper } from "./helper.js";\nexport const foo = shared + helper;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depBar),
      'import { shared } from "./shared.js";\nimport { helper } from "./helper.js";\nexport const bar = shared - helper;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depShared),
      "export const shared = 7;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depHelper),
      "export const helper = 3;\n",
    );

    const materialized = {
      authoredFiles: [authoredEntry, authoredLazy],
      entries: ["./src/entry.js"],
      modules: [
        {
          filePath: authoredEntry,
          id: authoredEntry,
          relativePath: "src/entry.js",
          sourceModuleIds: [authoredEntry],
        },
        {
          filePath: authoredLazy,
          id: authoredLazy,
          relativePath: "src/lazy.js",
          sourceModuleIds: [authoredLazy],
        },
        {
          filePath: depIndex,
          id: depIndex,
          relativePath: "node_modules/pkg/index.js",
          sourceModuleIds: [depIndex],
        },
        {
          filePath: depFoo,
          id: depFoo,
          relativePath: "node_modules/pkg/foo.js",
          sourceModuleIds: [depFoo],
        },
        {
          filePath: depBar,
          id: depBar,
          relativePath: "node_modules/pkg/bar.js",
          sourceModuleIds: [depBar],
        },
        {
          filePath: depShared,
          id: depShared,
          relativePath: "node_modules/pkg/shared.js",
          sourceModuleIds: [depShared],
        },
        {
          filePath: depHelper,
          id: depHelper,
          relativePath: "node_modules/pkg/helper.js",
          sourceModuleIds: [depHelper],
        },
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: [
        "./src/entry.js",
        "./src/lazy.js",
        "./node_modules/pkg/index.js",
        "./node_modules/pkg/foo.js",
        "./node_modules/pkg/bar.js",
        "./node_modules/pkg/shared.js",
        "./node_modules/pkg/helper.js",
      ],
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [authoredLazy],
      materialized,
    });

    expect(prebundled.modules.length).toBeLessThan(materialized.modules.length);
    expect(
      prebundled.modules.some((module) => module.filePath === depIndex),
    ).toBe(false);
    expect(
      prebundled.modules.some((module) => module.relativePath.startsWith("__dep-bundles/")),
    ).toBe(true);
    expect(
      prebundled.modules.some(
        (module) =>
          module.relativePath.startsWith("__dep-bundles/") &&
          !module.relativePath.startsWith("__dep-bundles/chunks/"),
      ),
    ).toBe(false);

    const rewrittenEntry = await fs.readFile(authoredEntry, "utf8");
    const rewrittenLazy = await fs.readFile(authoredLazy, "utf8");
    expect(rewrittenEntry).toContain("__dep-bundles/chunks/");
    expect(rewrittenLazy).toContain("__dep-bundles/chunks/");
    expect(rewrittenEntry).not.toContain("__dep-bundles/eager/");
    expect(rewrittenLazy).not.toContain("__dep-bundles/lazy/");
    expect(
      prebundled.runtimeEntries.every(
        (entry) =>
          !entry.startsWith("./__dep-bundles/") ||
          entry.startsWith("./__dep-bundles/chunks/"),
      ),
    ).toBe(true);
  },
);

test.serial(
  "prebundleMaterializedDependencies keeps aliasing wrapper exports intact",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const depIndex = path.join(srcDir, "node_modules", "pkg", "index.js");
    const depFoo = path.join(srcDir, "node_modules", "pkg", "foo.js");

    await fs.mkdir(path.dirname(authoredEntry), { recursive: true });
    await fs.mkdir(path.dirname(depIndex), { recursive: true });

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import { aliased } from "../node_modules/pkg/index.js";\nexport const entry = aliased;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depIndex),
      'export { foo as aliased } from "./foo.js";\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depFoo),
      "export const foo = 7;\n",
    );

    const materialized = {
      authoredFiles: [authoredEntry],
      entries: ["./src/entry.js"],
      modules: [
        {
          filePath: authoredEntry,
          id: authoredEntry,
          relativePath: "src/entry.js",
          sourceModuleIds: [authoredEntry],
        },
        {
          filePath: depIndex,
          id: depIndex,
          relativePath: "node_modules/pkg/index.js",
          sourceModuleIds: [depIndex],
        },
        {
          filePath: depFoo,
          id: depFoo,
          relativePath: "node_modules/pkg/foo.js",
          sourceModuleIds: [depFoo],
        },
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: [
        "./src/entry.js",
        "./node_modules/pkg/index.js",
        "./node_modules/pkg/foo.js",
      ],
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [],
      materialized,
    });

    expect(
      prebundled.modules.some(
        (module) =>
          module.relativePath.startsWith("__dep-bundles/eager/") &&
          !module.relativePath.startsWith("__dep-bundles/chunks/"),
      ),
    ).toBe(true);

    const rewrittenEntry = await fs.readFile(authoredEntry, "utf8");
    expect(rewrittenEntry).toContain("__dep-bundles/eager/");
    expect(rewrittenEntry).not.toContain("__dep-bundles/chunks/");
  },
);

test.serial(
  "gccTsBundler wires lazy Vite CSS through the runtime when cssCodeSplit is enabled",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture);

    const files = await listFiles(fixture.outDir);
    const cssFiles = files.filter((filePath) => filePath.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(1);

    const html = await fixture.read("dist/index.html");
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('rel="modulepreload"');
    const entryScript = readRewrittenEntryScript(html);
    expect(entryScript).toMatch(/^\/assets\/.+\.js$/u);
    expect(files).toContain(toDistRelativeFile(entryScript));

    const linkedCss = cssFiles.filter((fileName) => html.includes(fileName));
    expect(linkedCss.length).toBeGreaterThan(0);
    const lazyCss = cssFiles.find((fileName) => !html.includes(fileName));
    expect(lazyCss).toBeTruthy();

    const mainJs = await fixture.read(path.join("dist", toDistRelativeFile(entryScript)));
    expect(mainJs).toContain(lazyCss);
    expect(mainJs).toContain("globalThis.__g");
  },
);

test.serial(
  "gccTsBundler keeps eager Vite CSS when cssCodeSplit is disabled",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      build: {
        cssCodeSplit: false,
      },
    });

    const files = await listFiles(fixture.outDir);
    const cssFiles = files.filter((filePath) => filePath.endsWith(".css"));
    expect(cssFiles).toHaveLength(1);

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(path.join("dist", toDistRelativeFile(entryScript)));
    expect(mainJs).not.toContain(cssFiles[0]);
  },
);

test.serial(
  "gccTsBundler materializes only retained Rollup modules from the final chunk graph",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      [
        '<!doctype html>',
        '<html lang="en">',
        "  <body>",
        '    <script type="module" src="/src/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import { alive } from "./entry.js";',
        'document.body.textContent = alive;',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.js",
      [
        'export { alive } from "./alive.js";',
        'export { dead } from "./dead.js";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/alive.js",
      [
        'export const alive = "alive";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/dead.js",
      [
        'export const dead = "dead";',
        'export function deadBranch() { return "tree-shaken"; }',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, {
      debugDir: ".gcc-debug",
    });

    const runtimeModuleSourceMap = await readRuntimeModuleSourceMap(
      fixture,
      ".gcc-debug",
    );
    const runtimeModuleFiles = Object.values(runtimeModuleSourceMap).join("\n");
    expect(runtimeModuleFiles).toContain("/src/main.js");
    expect(runtimeModuleFiles).toContain("/src/entry.js");
    expect(runtimeModuleFiles).toContain("/src/alive.js");
    expect(runtimeModuleFiles).not.toContain("/src/dead.js");

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(path.join("dist", toDistRelativeFile(entryScript)));
    expect(mainJs).not.toContain("tree-shaken");
  },
);

test.serial(
  "gccTsBundler follows Vite entry and chunk naming config",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      buildLines: [
        "    rollupOptions: {",
        "      output: {",
        '        entryFileNames: "entry/[name]-[hash].js",',
        '        chunkFileNames: "chunks/[name]-[hash].js",',
        "      },",
        "    },",
      ],
    });

    const files = await listFiles(fixture.outDir);
    const jsFiles = files.filter((filePath) => filePath.endsWith(".js"));
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);

    expect(entryScript).toMatch(/^\/entry\/.+\.js$/u);
    expect(files).toContain(toDistRelativeFile(entryScript));
    expect(jsFiles.some((filePath) => filePath.startsWith("chunks/"))).toBe(true);
    expect(jsFiles).not.toContain("main.js");
  },
);

test.serial(
  "materializeCapturedGraph preserves pruning boundaries for empty, dynamic, and CSS side-effect stubs",
  async () => {
  const fixture = await createFixture();
  const srcDir = path.join(fixture.projectRoot, ".gcc-debug", "src");
  const mainId = path.join(fixture.projectRoot, "src", "main.js");
  const emptyId = path.join(fixture.projectRoot, "src", "empty.ts");
  const lazyId = path.join(fixture.projectRoot, "src", "lazy.js");
  const styleId = path.join(fixture.projectRoot, "src", "style.js");
  const capturedModules = new Map([
    [
      mainId,
      {
        code: [
          'import "./empty.ts";',
          'export const loadLazy = () => import("./lazy.js");',
          'import "./style.js";',
          "",
        ].join("\n"),
        id: mainId,
      },
    ],
    [
      emptyId,
      {
        code: "export {};\n",
        id: emptyId,
      },
    ],
    [
      lazyId,
      {
        code: "export {};\n",
        id: lazyId,
      },
    ],
    [
      styleId,
      {
        code: 'import "./style.css";\nexport {};\n',
        id: styleId,
      },
    ],
  ]);

  const materialized = await materializeCapturedGraph.call(
    createCapturePluginContext(),
    {
      capturedModules,
      config: { root: fixture.projectRoot },
      dynamicRootModuleIds: [lazyId],
      entryModuleIds: [mainId],
      resolutionCache: new Map(),
      moduleIds: [mainId, emptyId, lazyId, styleId],
      srcDir,
    },
  );

  expect(materialized.retainedEmptyModuleIds).toContain(emptyId);
  expect(materialized.retainedEmptyModuleIds).toContain(lazyId);
  expect(materialized.retainedEmptyModuleIds).not.toContain(styleId);
  expect(materialized.prunedEmptyModuleIds).toContain(emptyId);
  expect(materialized.prunedEmptyModuleIds).not.toContain(lazyId);
  expect(materialized.prunedEmptyModuleIds).not.toContain(styleId);
  expect(materialized.modules.map((module) => module.id)).not.toContain(emptyId);
  expect(materialized.modules.map((module) => module.id)).toEqual(expect.arrayContaining([lazyId, styleId]));
  expect(materialized.runtimeEntries.join("\n")).not.toContain("empty");

  const rewrittenMain = await fixture.read(
    path.relative(fixture.projectRoot, materialized.modules.find((module) => module.id === mainId).filePath),
  );
  expect(rewrittenMain).not.toContain("empty.ts");
  expect(rewrittenMain).toContain('import("./lazy.js")');
  expect(rewrittenMain).toContain('import "./style.js"');
  },
);

test("resolveViteLanguageOut derives compiler output from Vite build.target", () => {
  expect(
    resolveViteLanguageOut({
      build: { target: false },
    }),
  ).toBe("ECMASCRIPT_NEXT");
  expect(
    resolveViteLanguageOut({
      build: { target: "esnext" },
    }),
  ).toBe("ECMASCRIPT_NEXT");
  expect(
    resolveViteLanguageOut({
      build: { target: "es5" },
    }),
  ).toBe("ECMASCRIPT5");
  expect(
    resolveViteLanguageOut({
      build: { target: "baseline-widely-available" },
    }),
  ).toBe("ECMASCRIPT6");
  expect(
    resolveViteLanguageOut({
      build: { target: ["es2020", "es5"] },
    }),
  ).toBe("ECMASCRIPT5");
});

test("resolveViteLanguageOut rejects unsupported target strings", () => {
  expect(() =>
    resolveViteLanguageOut({
      build: { target: "chrome120" },
    }),
  ).toThrow(/could not derive a compiler output level/);
});

test.serial(
  "gccTsBundler rejects compiler.languageOut in Vite mode with an actionable error",
  async () => {
    const fixture = await createFixture();
    const pluginUrl = pathToFileURL(
      path.join(process.cwd(), "dist/vite/index.mjs"),
    ).href;
    const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    await fixture.write(
      "index.html",
      [
        "<!doctype html>",
        "<html>",
        "  <body>",
        '    <script type="module" src="/src/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
    await fixture.write("src/main.js", 'console.log("vite");\n');
    await fixture.write(
      "vite.config.mjs",
      [
        `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
        "",
        "export default {",
        "  plugins: [",
        "    gccTsBundler({",
        "      compiler: {",
        '        languageOut: "ECMASCRIPT5",',
        "      },",
        "    }),",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      execFileAsync(process.execPath, [viteBin, "build"], {
        cwd: fixture.projectRoot,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(VITE_LANGUAGE_OUT_ERROR),
    });
  },
);

test.serial(
  'gccTsBundler rejects runtime.loader="fetch" in Vite mode with an actionable error',
  async () => {
    const fixture = await createFixture();
    const pluginUrl = pathToFileURL(
      path.join(process.cwd(), "dist/vite/index.mjs"),
    ).href;
    const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    await fixture.write(
      "index.html",
      [
        "<!doctype html>",
        "<html>",
        "  <body>",
        '    <script type="module" src="/src/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
    await fixture.write("src/main.js", 'console.log("vite");\n');
    await fixture.write(
      "vite.config.mjs",
      [
        `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
        "",
        "export default {",
        "  plugins: [",
        "    gccTsBundler({",
        "      runtime: {",
        '        loader: "fetch",',
        "      },",
        "    }),",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      execFileAsync(process.execPath, [viteBin, "build"], {
        cwd: fixture.projectRoot,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(VITE_FETCH_LOADER_ERROR),
    });
  },
);
