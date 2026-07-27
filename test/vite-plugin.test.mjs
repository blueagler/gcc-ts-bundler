import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, onTestFinished, test } from "bun:test";

import {
  getCapturedModuleAnalysis,
  normalizeRetainedCapturedModules,
  resolveViteCaptureRootPath,
} from "../src/vite/capture.ts";
import { resolveNormalizedBridgeModuleIds } from "../src/vite/graph.ts";
import { resolveCompilerExterns } from "../src/vite/externs.ts";
import { materializeCapturedGraph } from "../src/vite/materialize.ts";
import {
  finalizeBaseJsOutputName,
  renameCompiledNonBaseJsOutputs,
} from "../src/vite/naming.ts";
import { prebundleMaterializedDependencies } from "../src/vite/prebundle/index.ts";
import {
  createCompilerOptions,
  resolveViteLanguageOut,
  VITE_LANGUAGE_OUT_ERROR,
} from "../src/vite/config.ts";
import {
  extractTypedAnnotations,
  isTypedAnnotationSource,
} from "../src/vite/typed-annotations.ts";
import { normalizeBuildOptions } from "../src/build/resolve/options.ts";
import { getOptionsSignature } from "../src/build/resolve/signatures.ts";
import {
  createFixture,
  execFileAsync,
  listDirectoryNames,
} from "./helpers.mjs";

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
  const viteBin = path.join(
    process.cwd(),
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
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
        ? ["    cssCodeSplit: false,"]
        : []),
      ...(overrides.buildLines ?? []),
      "  },",
      "  plugins: [",
      "    gccTsBundler({",
      "      compiler: {",
      `        cache: ${JSON.stringify(overrides.cache ?? { mode: "off" })},`,
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

  return await execFileAsync(process.execPath, [viteBin, "build"], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ...(overrides.env ?? {}),
    },
  });
}

function readRewrittenEntryScript(html) {
  // script mode emits `<script defer src>`; esm mode (the bundler-runtime
  // default) emits `<script type="module" crossorigin src>`.
  const match = html.match(
    /<script (?:defer|type="module" crossorigin) src="([^"]+)"><\/script>/u,
  );
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
      "<!doctype html>",
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
    ["body {", "  background: rgb(250, 250, 252);", "}", ""].join("\n"),
  );
  await fixture.write(
    "src/feature.css",
    [".feature-panel {", "  color: rgb(120, 40, 180);", "}", ""].join("\n"),
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
    const additionalBridgeModuleIds =
      await resolveNormalizedBridgeModuleIds.call(
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
      prebundled.modules.some((module) =>
        module.relativePath.startsWith("__dep-bundles/"),
      ),
    ).toBe(true);

    // Barrel flattening resolves entry->foo and lazy->bar to their defining
    // modules, so each region keeps its own bundle while the code shared by
    // both regions splits into a chunks/ bundle.
    const bundleSources = await Promise.all(
      prebundled.modules
        .filter((module) => module.relativePath.startsWith("__dep-bundles/"))
        .map((module) => fs.readFile(module.filePath, "utf8")),
    );
    const rewrittenEntry = await fs.readFile(authoredEntry, "utf8");
    const rewrittenLazy = await fs.readFile(authoredLazy, "utf8");
    expect(rewrittenEntry).toContain("__dep-bundles/");
    expect(rewrittenLazy).toContain("__dep-bundles/");
    const entryBundlePath = rewrittenEntry.match(/__dep-bundles\/[\w./-]+/)?.[0];
    const lazyBundlePath = rewrittenLazy.match(/__dep-bundles\/[\w./-]+/)?.[0];
    expect(entryBundlePath).toBeTruthy();
    expect(lazyBundlePath).toBeTruthy();
    expect(entryBundlePath).not.toBe(lazyBundlePath);
    const entryBundle = await fs.readFile(
      path.join(srcDir, entryBundlePath),
      "utf8",
    );
    const lazyBundle = await fs.readFile(
      path.join(srcDir, lazyBundlePath),
      "utf8",
    );
    // foo stays out of the lazy region and bar stays out of the eager region.
    expect(entryBundle).not.toContain("shared - helper");
    expect(lazyBundle).not.toContain("shared + helper");
    expect(bundleSources.length).toBeGreaterThan(0);
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
  "prebundleMaterializedDependencies dedupes identical lazy dependency bundles into one shared module",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const authoredLazyA = path.join(srcDir, "src", "lazy-a.js");
    const authoredLazyB = path.join(srcDir, "src", "lazy-b.js");
    const depIndex = path.join(srcDir, "node_modules", "pkg", "index.js");
    const depFoo = path.join(srcDir, "node_modules", "pkg", "foo.js");

    await fs.mkdir(path.dirname(authoredEntry), { recursive: true });
    await fs.mkdir(path.dirname(depIndex), { recursive: true });

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      "export const entry = true;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, authoredLazyA),
      'import { aliased } from "../node_modules/pkg/index.js";\nexport const lazyA = aliased;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, authoredLazyB),
      'import { aliased } from "../node_modules/pkg/index.js";\nexport const lazyB = aliased;\n',
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
      authoredFiles: [authoredEntry, authoredLazyA, authoredLazyB],
      entries: ["./src/entry.js"],
      modules: [
        {
          filePath: authoredEntry,
          id: authoredEntry,
          relativePath: "src/entry.js",
          sourceModuleIds: [authoredEntry],
        },
        {
          filePath: authoredLazyA,
          id: authoredLazyA,
          relativePath: "src/lazy-a.js",
          sourceModuleIds: [authoredLazyA],
        },
        {
          filePath: authoredLazyB,
          id: authoredLazyB,
          relativePath: "src/lazy-b.js",
          sourceModuleIds: [authoredLazyB],
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
        "./src/lazy-a.js",
        "./src/lazy-b.js",
        "./node_modules/pkg/index.js",
        "./node_modules/pkg/foo.js",
      ],
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [authoredLazyA, authoredLazyB],
      materialized,
    });

    const sharedModules = prebundled.modules.filter((module) =>
      module.relativePath.startsWith("__dep-bundles/shared/"),
    );
    expect(sharedModules).toHaveLength(1);
    expect(
      prebundled.modules.some(
        (module) =>
          module.relativePath.startsWith("__dep-bundles/") &&
          !module.relativePath.startsWith("__dep-bundles/chunks/") &&
          !module.relativePath.startsWith("__dep-bundles/shared/"),
      ),
    ).toBe(false);

    const rewrittenLazyA = await fs.readFile(authoredLazyA, "utf8");
    const rewrittenLazyB = await fs.readFile(authoredLazyB, "utf8");
    const sharedImportA = rewrittenLazyA.match(
      /__dep-bundles\/shared\/[^"']+\.js/u,
    );
    const sharedImportB = rewrittenLazyB.match(
      /__dep-bundles\/shared\/[^"']+\.js/u,
    );
    expect(sharedImportA).toBeTruthy();
    expect(sharedImportB).toBeTruthy();
    expect(sharedImportA?.[0]).toBe(sharedImportB?.[0]);
    expect(
      prebundled.runtimeEntries.filter((entry) =>
        entry.startsWith("./__dep-bundles/shared/"),
      ),
    ).toHaveLength(1);
  },
);

test.serial(
  "prebundleMaterializedDependencies keeps non-identical lazy dependency bundles separate",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const authoredLazyA = path.join(srcDir, "src", "lazy-a.js");
    const authoredLazyB = path.join(srcDir, "src", "lazy-b.js");
    const depIndexA = path.join(srcDir, "node_modules", "pkg-a", "index.js");
    const depFoo = path.join(srcDir, "node_modules", "pkg-a", "foo.js");
    const depIndexB = path.join(srcDir, "node_modules", "pkg-b", "index.js");
    const depBar = path.join(srcDir, "node_modules", "pkg-b", "bar.js");

    await fs.mkdir(path.dirname(authoredEntry), { recursive: true });
    await fs.mkdir(path.dirname(depIndexA), { recursive: true });
    await fs.mkdir(path.dirname(depIndexB), { recursive: true });

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      "export const entry = true;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, authoredLazyA),
      'import { aliased } from "../node_modules/pkg-a/index.js";\nexport const lazyA = aliased;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, authoredLazyB),
      'import { aliased } from "../node_modules/pkg-b/index.js";\nexport const lazyB = aliased;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depIndexA),
      'export { foo as aliased } from "./foo.js";\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depFoo),
      "export const foo = 7;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depIndexB),
      'export { bar as aliased } from "./bar.js";\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depBar),
      "export const bar = 9;\n",
    );

    const materialized = {
      authoredFiles: [authoredEntry, authoredLazyA, authoredLazyB],
      entries: ["./src/entry.js"],
      modules: [
        {
          filePath: authoredEntry,
          id: authoredEntry,
          relativePath: "src/entry.js",
          sourceModuleIds: [authoredEntry],
        },
        {
          filePath: authoredLazyA,
          id: authoredLazyA,
          relativePath: "src/lazy-a.js",
          sourceModuleIds: [authoredLazyA],
        },
        {
          filePath: authoredLazyB,
          id: authoredLazyB,
          relativePath: "src/lazy-b.js",
          sourceModuleIds: [authoredLazyB],
        },
        {
          filePath: depIndexA,
          id: depIndexA,
          relativePath: "node_modules/pkg-a/index.js",
          sourceModuleIds: [depIndexA],
        },
        {
          filePath: depFoo,
          id: depFoo,
          relativePath: "node_modules/pkg-a/foo.js",
          sourceModuleIds: [depFoo],
        },
        {
          filePath: depIndexB,
          id: depIndexB,
          relativePath: "node_modules/pkg-b/index.js",
          sourceModuleIds: [depIndexB],
        },
        {
          filePath: depBar,
          id: depBar,
          relativePath: "node_modules/pkg-b/bar.js",
          sourceModuleIds: [depBar],
        },
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: [
        "./src/entry.js",
        "./src/lazy-a.js",
        "./src/lazy-b.js",
        "./node_modules/pkg-a/index.js",
        "./node_modules/pkg-a/foo.js",
        "./node_modules/pkg-b/index.js",
        "./node_modules/pkg-b/bar.js",
      ],
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [authoredLazyA, authoredLazyB],
      materialized,
    });

    expect(
      prebundled.modules.some((module) =>
        module.relativePath.startsWith("__dep-bundles/shared/"),
      ),
    ).toBe(false);
    expect(
      prebundled.modules.filter(
        (module) =>
          module.relativePath.startsWith("__dep-bundles/") &&
          !module.relativePath.startsWith("__dep-bundles/chunks/"),
      ).length,
    ).toBe(2);

    const rewrittenLazyA = await fs.readFile(authoredLazyA, "utf8");
    const rewrittenLazyB = await fs.readFile(authoredLazyB, "utf8");
    expect(rewrittenLazyA).toContain("__dep-bundles/lazy-a/");
    expect(rewrittenLazyB).toContain("__dep-bundles/lazy-b/");
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
    expect(html).not.toContain('rel="modulepreload"');
    const entryScript = readRewrittenEntryScript(html);
    expect(entryScript).toMatch(/^\/assets\/.+\.js$/u);
    expect(files).toContain(toDistRelativeFile(entryScript));

    const linkedCss = cssFiles.filter((fileName) => html.includes(fileName));
    expect(linkedCss.length).toBeGreaterThan(0);
    const lazyCss = cssFiles.find((fileName) => !html.includes(fileName));
    expect(lazyCss).toBeTruthy();

    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
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
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
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
        "<!doctype html>",
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
        "document.body.textContent = alive;",
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
      ['export const alive = "alive";', ""].join("\n"),
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
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
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
    expect(jsFiles.some((filePath) => filePath.startsWith("chunks/"))).toBe(
      true,
    );
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
    expect(materialized.modules.map((module) => module.id)).not.toContain(
      emptyId,
    );
    expect(materialized.modules.map((module) => module.id)).toEqual(
      expect.arrayContaining([lazyId, styleId]),
    );
    expect(materialized.runtimeEntries.join("\n")).not.toContain("empty");

    const rewrittenMain = await fixture.read(
      path.relative(
        fixture.projectRoot,
        materialized.modules.find((module) => module.id === mainId).filePath,
      ),
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

test("resolveViteCaptureRootPath is deterministic for identical inputs", () => {
  const input = {
    config: {
      base: "/",
      build: {
        assetsDir: "assets",
        cssCodeSplit: true,
        minify: "esbuild",
        target: "esnext",
      },
      mode: "production",
      root: "/tmp/demo",
    },
    options: {
      compiler: {
        compilationLevel: "ADVANCED",
      },
      externs: {
        generate: {
          mode: "runtime-aware",
          modules: ["pkg"],
        },
      },
    },
    projectRoot: "/tmp/demo",
  };

  expect(resolveViteCaptureRootPath(input)).toBe(
    resolveViteCaptureRootPath(input),
  );
});

test("resolveViteCaptureRootPath changes when material build identity changes", () => {
  const baseInput = {
    config: {
      base: "/",
      build: {
        assetsDir: "assets",
        cssCodeSplit: true,
        minify: "esbuild",
        target: "esnext",
      },
      mode: "production",
      root: "/tmp/demo",
    },
    options: {
      compiler: {
        compilationLevel: "ADVANCED",
      },
    },
    projectRoot: "/tmp/demo",
  };

  expect(
    resolveViteCaptureRootPath({
      ...baseInput,
      config: {
        ...baseInput.config,
        build: {
          ...baseInput.config.build,
          target: "es2018",
        },
      },
    }),
  ).not.toBe(resolveViteCaptureRootPath(baseInput));
});

test.serial(
  "gccTsBundler reuses the same Vite capture root and hits resolve snapshot plus final fast cache on identical builds",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    const first = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });
    const second = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    expect(
      await listDirectoryNames(
        path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"),
      ),
    ).toHaveLength(1);
    expect(first.stderr).toContain(
      "[gcc-ts-bundler timing] cache:final-fast: miss",
    );
    expect(first.stderr).toContain(
      "[gcc-ts-bundler timing] cache:final-metadata: miss",
    );
    expect(second.stderr).toContain(
      "[gcc-ts-bundler timing] cache:resolve-snapshot: hit",
    );
    expect(second.stderr).toContain(
      "[gcc-ts-bundler timing] cache:final-fast: hit",
    );
    expect(second.stderr).not.toContain(
      "[gcc-ts-bundler timing] cache:final-metadata:",
    );
    expect(second.stderr).not.toContain(
      "[gcc-ts-bundler timing] closure:compile:",
    );
    expect(second.stderr).not.toContain(
      "[gcc-ts-bundler timing] native-emit:transpile:",
    );
  },
);

test.serial(
  "gccTsBundler recreates the runtime source map when the capture root is deleted",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);
    const options = {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    };

    await buildViteFixture(fixture, options);
    await fs.rm(path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"), {
      force: true,
      recursive: true,
    });
    const rebuilt = await buildViteFixture(fixture, options);

    expect(rebuilt.stderr).toContain(
      "[gcc-ts-bundler timing] cache:native-emit: miss",
    );
    const [captureRootId] = await listDirectoryNames(
      path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"),
    );
    expect(
      await fixture.read(
        path.join(
          ".gcc-ts-bundler-vite",
          captureRootId,
          ".gcc-ts-bundler-vite-runtime-module-sources.json",
        ),
      ),
    ).toContain("{");
  },
);

test.serial(
  "gccTsBundler falls back to final metadata restore when core outputs are missing",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    const [captureRootId] = await listDirectoryNames(
      path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"),
    );
    expect(captureRootId).toBeTruthy();
    await fs.rm(
      path.join(
        fixture.projectRoot,
        ".gcc-ts-bundler-vite",
        captureRootId,
        "gcc-core-out",
      ),
      { force: true, recursive: true },
    );

    const restored = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    expect(restored.stderr).toContain(
      "[gcc-ts-bundler timing] cache:resolve-snapshot: hit",
    );
    expect(restored.stderr).toContain(
      "[gcc-ts-bundler timing] cache:final-fast: miss",
    );
    expect(restored.stderr).toContain(
      "[gcc-ts-bundler timing] cache:final-metadata: hit",
    );
    expect(restored.stderr).not.toContain(
      "[gcc-ts-bundler timing] closure:compile:",
    );
  },
);

test.serial(
  "gccTsBundler rejects compiler.languageOut in Vite mode with an actionable error",
  async () => {
    const fixture = await createFixture();
    const pluginUrl = pathToFileURL(
      path.join(process.cwd(), "dist/vite/index.mjs"),
    ).href;
    const viteBin = path.join(
      process.cwd(),
      "node_modules",
      "vite",
      "bin",
      "vite.js",
    );
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

// --- chunk naming ---------------------------------------------------------
//
// These exercise src/vite/naming.ts directly with a hand-built compiled-output
// directory: two chunks, a base and one lazy chunk, wired the way Closure
// emits them for each chunk output type.

const NAMING_OUTPUT_OPTIONS = {
  chunkFileNames: "assets/[name]-[hash].js",
  entryFileNames: "assets/[name]-[hash].js",
  format: "es",
};

async function createNamingWorkspace(input) {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gcc-ts-bundler-naming-"),
  );
  onTestFinished(async () => {
    await fs.rm(outDir, { force: true, recursive: true });
  });

  const baseChunkId = input.baseChunkId ?? "main";
  const manifestFilePath = path.join(outDir, "manifest.json");
  // The vendor chunk is deliberately just another manifest row: the base
  // chunk depends on it, it depends on nothing, and naming treats it like any
  // other non-base chunk.
  const hasVendor = input.vendorSource !== undefined;
  await fs.writeFile(
    manifestFilePath,
    JSON.stringify({
      baseChunk: baseChunkId,
      chunks: {
        lazy: { css: [], deps: [baseChunkId], modules: [], url: "/lazy.js" },
        [baseChunkId]: {
          css: [],
          deps: hasVendor ? ["vendor"] : [],
          modules: [],
          url: "/main.js",
        },
        ...(hasVendor
          ? { vendor: { css: [], deps: [], modules: [], url: "/vendor.js" } }
          : {}),
      },
      loader: "script",
      modules: {},
      publicPath: "/",
    }),
    "utf8",
  );
  await fs.writeFile(path.join(outDir, "main.js"), input.baseSource, "utf8");
  await fs.writeFile(path.join(outDir, "lazy.js"), input.lazySource, "utf8");
  if (hasVendor) {
    await fs.writeFile(
      path.join(outDir, "vendor.js"),
      input.vendorSource,
      "utf8",
    );
  }

  return {
    manifestFilePath,
    outDir,
    outputFiles: [
      path.join(outDir, "main.js"),
      path.join(outDir, "lazy.js"),
      ...(hasVendor ? [path.join(outDir, "vendor.js")] : []),
    ],
  };
}

async function runNamingPasses(workspace, chunkOutputType) {
  const renamed = await renameCompiledNonBaseJsOutputs({
    baseChunkName: "main",
    chunkOutputType,
    dynamicRootModuleIds: [],
    jsChunks: [],
    manifestFilePath: workspace.manifestFilePath,
    materialized: { modules: [] },
    outDir: workspace.outDir,
    outputFiles: workspace.outputFiles,
    outputOptions: NAMING_OUTPUT_OPTIONS,
    publicPath: "/",
    runtimeModuleSourceMapFilePath: path.join(workspace.outDir, "missing.json"),
  });
  const finalized = await finalizeBaseJsOutputName({
    baseChunkFilePath: renamed.baseChunkFilePath,
    baseSeed: renamed.baseSeed,
    chunkOutputType,
    deferredChunkSeeds: renamed.deferredChunkSeeds,
    emittedOutputFiles: renamed.emittedOutputFiles,
    manifestFilePath: workspace.manifestFilePath,
    outDir: workspace.outDir,
    outputOptions: NAMING_OUTPUT_OPTIONS,
    publicPath: "/",
  });
  const manifest = JSON.parse(
    await fs.readFile(workspace.manifestFilePath, "utf8"),
  );
  const emitted = finalized.emittedOutputFiles.map((filePath) =>
    path.relative(workspace.outDir, filePath).replace(/\\/g, "/"),
  );
  return {
    baseScriptFileName: finalized.baseScriptFileName,
    emitted,
    manifest,
    read: (relativePath) =>
      fs.readFile(path.join(workspace.outDir, relativePath), "utf8"),
  };
}

const ESM_BASE_SOURCE =
  'var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"./lazy.js",[]]],[0,1],"/assets/"]);export{r};\n';
const ESM_LAZY_SOURCE = 'import{r}from"./main.js";r.u(1);\n';

test("esm chunk naming hashes every chunk and rewrites import specifiers", async () => {
  const workspace = await createNamingWorkspace({
    baseSource: ESM_BASE_SOURCE,
    lazySource: ESM_LAZY_SOURCE,
  });
  const result = await runNamingPasses(workspace, "esm");

  const baseFileName = result.baseScriptFileName;
  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  expect(baseFileName).toMatch(/^assets\/main-[\w-]{8}\.js$/u);
  expect(lazyFileName).toMatch(/^assets\/shared-lazy-[\w-]{8}\.js$/u);
  expect(result.emitted.sort()).toEqual([baseFileName, lazyFileName].sort());

  // The lazy chunk imports the base chunk under its final hashed name, and the
  // base chunk's runtime manifest points at the lazy chunk's final name.
  const lazySource = await result.read(lazyFileName);
  expect(lazySource).toContain(`"./${path.posix.basename(baseFileName)}"`);
  expect(lazySource).not.toContain('"./main.js"');
  const baseSource = await result.read(baseFileName);
  expect(baseSource).toContain(`"./${path.posix.basename(lazyFileName)}"`);
  expect(baseSource).not.toContain('"./lazy.js"');
  expect(result.manifest.chunks.main.url).toBe(`/${baseFileName}`);
});

test("esm chunk naming resolves the base chunk under its compiler chunk id", async () => {
  // Closure names every output after its chunk id and the pipeline renames the
  // base chunk on the way out, so siblings still import `./<chunkId>.js`.
  const workspace = await createNamingWorkspace({
    baseChunkId: "c0abc",
    baseSource: ESM_BASE_SOURCE,
    lazySource: 'import{r}from"./c0abc.js";r.u(1);\n',
  });
  const result = await runNamingPasses(workspace, "esm");

  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  const lazySource = await result.read(lazyFileName);
  expect(lazySource).toContain(
    `"./${path.posix.basename(result.baseScriptFileName)}"`,
  );
  expect(lazySource).not.toContain('"./c0abc.js"');
});

test("esm chunk naming rehashes dependents when a referenced chunk changes", async () => {
  const first = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_SOURCE,
      lazySource: ESM_LAZY_SOURCE,
    }),
    "esm",
  );
  const second = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_SOURCE.replace("export{r}", "console.log(1);export{r}"),
      lazySource: ESM_LAZY_SOURCE,
    }),
    "esm",
  );

  // The lazy chunk's own bytes are unchanged, but it embeds the base chunk's
  // name: without folding the reference closure into the hash it would keep a
  // stale name while its shipped bytes changed.
  expect(second.baseScriptFileName).not.toBe(first.baseScriptFileName);
  expect(second.manifest.chunks.lazy.url).not.toBe(
    first.manifest.chunks.lazy.url,
  );
});

const ESM_VENDOR_SOURCE = "export var dep=1;\n";
const ESM_BASE_WITH_VENDOR_SOURCE =
  'import{dep}from"./vendor.js";var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"./vendor.js",[]],[[0],"./lazy.js",[]]],[0,1,2],"/assets/"]);export{r};\n';

test("esm chunk naming gives base-dependency chunks the stable vendor name", async () => {
  const workspace = await createNamingWorkspace({
    baseSource: ESM_BASE_WITH_VENDOR_SOURCE,
    lazySource: ESM_LAZY_SOURCE,
    vendorSource: ESM_VENDOR_SOURCE,
  });
  const result = await runNamingPasses(workspace, "esm");

  const vendorFileName = toDistRelativeFile(result.manifest.chunks.vendor.url);
  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  expect(vendorFileName).toMatch(/^assets\/vendor-[\w-]{8}\.js$/u);
  expect(result.emitted.sort()).toEqual(
    [result.baseScriptFileName, lazyFileName, vendorFileName].sort(),
  );

  // The base chunk's import of the vendor chunk is rewritten to the final
  // hashed name, exactly like the manifest urls of the lazy chunks.
  const baseSource = await result.read(result.baseScriptFileName);
  expect(baseSource).toContain(
    `"./${path.posix.basename(vendorFileName)}"`,
  );
  expect(baseSource).not.toContain('"./vendor.js"');
});

test("vendor chunk keeps its file name across an app-code edit", async () => {
  // Only the base chunk body differs; vendor and lazy bytes are identical.
  const first = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_WITH_VENDOR_SOURCE,
      lazySource: ESM_LAZY_SOURCE,
      vendorSource: ESM_VENDOR_SOURCE,
    }),
    "esm",
  );
  const second = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_WITH_VENDOR_SOURCE.replace(
        "export{r}",
        "console.log(1);export{r}",
      ),
      lazySource: ESM_LAZY_SOURCE,
      vendorSource: ESM_VENDOR_SOURCE,
    }),
    "esm",
  );

  // The whole point of the vendor chunk: nothing it contains references the
  // entry, so its reference closure is empty and an app edit cannot rename it.
  // On this app that is the biggest chunk, so its cache entry survives.
  expect(second.manifest.chunks.vendor.url).toBe(
    first.manifest.chunks.vendor.url,
  );

  // Pinned limit, not an oversight: a lazy chunk's shipped bytes contain
  // `import ... from "./<entry>-<hash>.js"`, so when the entry is renamed the
  // lazy chunk's bytes really do change and it must be renamed too. Full lazy
  // stability would need import-map indirection.
  expect(second.baseScriptFileName).not.toBe(first.baseScriptFileName);
  expect(second.manifest.chunks.lazy.url).not.toBe(
    first.manifest.chunks.lazy.url,
  );
});

test("script chunk naming leaves chunk sources untouched", async () => {
  const baseSource =
    'var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"lazy.js",[]]],[0,1],"/assets/"]);\n';
  const lazySource = 'globalThis.__g.u(1);\n';
  const workspace = await createNamingWorkspace({ baseSource, lazySource });
  const result = await runNamingPasses(workspace, "script");

  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  // Script output only ever rewrites the base chunk's runtime manifest; the
  // lazy chunk keeps its exact compiled bytes.
  expect(await result.read(lazyFileName)).toBe(lazySource);
  const baseSourceOut = await result.read(result.baseScriptFileName);
  expect(baseSourceOut).toContain(path.posix.basename(lazyFileName));
  expect(baseSourceOut).not.toContain('"lazy.js"');
});

const TYPED_ANNOTATION_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      strict: true,
      target: "ESNext",
    },
  },
  null,
  2,
);

const TYPED_ANNOTATION_SOURCE = [
  "export class Point {",
  "  x: number;",
  "  constructor(x: number) {",
  "    this.x = x;",
  "  }",
  "}",
  "export function scale(p: Point, k: number): number {",
  "  return p.x * k;",
  "}",
  "export function label(name: string, on: boolean): string {",
  '  return on ? name : "";',
  "}",
  "export const factor: number = 3;",
  "export function widen(v: number | string): string {",
  "  return String(v);",
  "}",
  "export function identity<T>(v: T): T {",
  "  return v;",
  "}",
  "export function optional(a?: number): number {",
  "  return a ?? 0;",
  "}",
  "export function shape(): { a: number } {",
  "  return { a: 1 };",
  "}",
  "",
].join("\n");

test("extracts conservative Closure annotations from TypeScript sources", async () => {
  const fixture = await createFixture();
  await fixture.write("tsconfig.json", TYPED_ANNOTATION_TSCONFIG);
  await fixture.write("src/mod.ts", TYPED_ANNOTATION_SOURCE);
  // Stands in for the materialized module: types erased, bindings preserved.
  await fixture.write("src/mod__ts.js", TYPED_ANNOTATION_SOURCE);

  const result = await extractTypedAnnotations({
    candidates: [
      {
        materializedFilePath: path.join(fixture.srcDir, "mod__ts.js"),
        sourceFilePath: path.join(fixture.srcDir, "mod.ts"),
      },
    ],
    projectRoot: fixture.projectRoot,
  });

  expect(result.files).toHaveLength(1);
  const byName = new Map(
    result.files[0].bindings.map((binding) => [binding.name, binding.jsdoc]),
  );

  // A function whose params/return are a same-module class and primitives.
  expect(byName.get("scale")).toBe(
    "/** @param {!Point} p @param {number} k @return {number} */\n",
  );
  expect(byName.get("label")).toBe(
    "/** @param {string} name @param {boolean} on @return {string} */\n",
  );
  // Single-declarator top-level variable with a primitive type.
  expect(byName.get("factor")).toBe("/** @type {number} */\n");

  // Classes carry no JSDoc of their own (Closure reads ES6 class structure
  // natively), but since v2 they carry per-member @type entries.
  const point = result.files[0].bindings.find(
    (binding) => binding.name === "Point",
  );
  expect(point).toBeTruthy();
  expect(point.jsdoc).toBe("");
  expect(
    point.members.some(
      (member) =>
        member.name === "x" && member.jsdoc === "/** @type {number} */\n",
    ),
  ).toBe(true);
  // Ineligible signatures are omitted whole - absence is always sound.
  for (const omitted of ["widen", "identity", "optional", "shape"]) {
    expect(byName.has(omitted)).toBe(false);
  }
  expect(result.bindingCount).toBe(byName.size);
});

test("drops annotations whose binding did not survive the transform", async () => {
  const fixture = await createFixture();
  await fixture.write("tsconfig.json", TYPED_ANNOTATION_TSCONFIG);
  await fixture.write("src/mod.ts", TYPED_ANNOTATION_SOURCE);
  // Only `scale` survives into the emitted text.
  await fixture.write("src/mod__ts.js", "export function scale() {}\n");

  const result = await extractTypedAnnotations({
    candidates: [
      {
        materializedFilePath: path.join(fixture.srcDir, "mod__ts.js"),
        sourceFilePath: path.join(fixture.srcDir, "mod.ts"),
      },
    ],
    projectRoot: fixture.projectRoot,
  });

  expect(result.files[0].bindings.map((binding) => binding.name)).toEqual([
    "scale",
  ]);
});

test("emits no annotations without a tsconfig", async () => {
  // Not createFixture(): that scaffolds a tsconfig.json, and TypeScript
  // discovers config files by walking up from the project root.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gcc-typed-no-tsconfig-")),
  );
  onTestFinished(() => fs.rm(root, { force: true, recursive: true }));
  await fs.writeFile(path.join(root, "mod.ts"), TYPED_ANNOTATION_SOURCE);

  const result = await extractTypedAnnotations({
    candidates: [
      {
        materializedFilePath: path.join(root, "mod.ts"),
        sourceFilePath: path.join(root, "mod.ts"),
      },
    ],
    projectRoot: root,
  });

  expect(result).toEqual({ bindingCount: 0, files: [] });
});

test("only plain project TypeScript modules are annotation sources", () => {
  const projectRoot = "/project";
  expect(isTypedAnnotationSource("/project/src/main.ts", projectRoot)).toBe(
    true,
  );
  expect(isTypedAnnotationSource("/project/src/App.tsx", projectRoot)).toBe(
    true,
  );
  // Framework single-file components compile through their own toolchain.
  expect(isTypedAnnotationSource("/project/src/App.svelte", projectRoot)).toBe(
    false,
  );
  expect(isTypedAnnotationSource("/project/src/App.vue", projectRoot)).toBe(
    false,
  );
  // Query suffixes change the materialized file name and the text.
  expect(
    isTypedAnnotationSource("/project/src/main.ts?used", projectRoot),
  ).toBe(false);
  expect(isTypedAnnotationSource("\0virtual:entry.ts", projectRoot)).toBe(
    false,
  );
  expect(
    isTypedAnnotationSource("/project/node_modules/dep/index.ts", projectRoot),
  ).toBe(false);
  expect(isTypedAnnotationSource("/elsewhere/main.ts", projectRoot)).toBe(
    false,
  );
});

test("typed annotations reach build options and move the options signature", async () => {
  const fixture = await createFixture();
  const typedAnnotations = [
    {
      bindings: [{ jsdoc: "/** @type {number} */\n", name: "factor" }],
      filePath: path.join(fixture.srcDir, "mod__ts.js"),
    },
  ];
  const baseInput = {
    config: { base: "/", build: { target: "esnext" }, root: fixture.projectRoot },
    entries: ["./main.js"],
    externs: [],
    manifestFile: "manifest.json",
    options: {},
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    publicPath: "/",
    srcDir: fixture.srcDir,
  };

  const withTypes = createCompilerOptions({ ...baseInput, typedAnnotations });
  expect(withTypes.typedAnnotations).toEqual(typedAnnotations);
  const withoutTypes = createCompilerOptions(baseInput);
  expect(withoutTypes.typedAnnotations).toEqual([]);

  const signatureOf = (compilerOptions) =>
    getOptionsSignature(normalizeBuildOptions(compilerOptions));
  const untypedSignature = signatureOf(withoutTypes);
  const typedSignature = signatureOf(withTypes);
  expect(typedSignature).not.toBe(untypedSignature);

  // Same sources, different inferred type: the signature must still move, or
  // a type-only edit would be served a stale cached build.
  const retypedSignature = signatureOf(
    createCompilerOptions({
      ...baseInput,
      typedAnnotations: [
        {
          bindings: [{ jsdoc: "/** @type {string} */\n", name: "factor" }],
          filePath: typedAnnotations[0].filePath,
        },
      ],
    }),
  );
  expect(retypedSignature).not.toBe(typedSignature);
  expect(signatureOf(createCompilerOptions({ ...baseInput, typedAnnotations }))).toBe(
    typedSignature,
  );
});

/**
 * Builds the two graphs the externs stage sees. The dependency module differs
 * between them exactly as esbuild's class-field lowering makes it differ: the
 * authored source assigns `this.loweredField`, the prebundled output writes it
 * through `__publicField(this, "loweredField", ...)`.
 */
async function writeExternsGraphFixture(fixture) {
  const preDepFile = path.join(fixture.srcDir, "pre-dep.js");
  const postDepFile = path.join(fixture.srcDir, "post-dep.js");
  const appFile = path.join(fixture.srcDir, "app.js");
  const depModuleId = path.join(
    fixture.projectRoot,
    "node_modules",
    "dep-pkg",
    "index.js",
  );

  await fs.mkdir(fixture.srcDir, { recursive: true });
  await fs.writeFile(
    preDepFile,
    [
      "export class Widget {",
      "  constructor() {",
      "    this.loweredField = 1;",
      "  }",
      "  read(other) {",
      "    return other.loweredField;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    postDepFile,
    [
      "const __publicField = (obj, key, value) => (obj[key] = value);",
      "export class Widget {",
      "  constructor() {",
      '    __publicField(this, "loweredField", 1);',
      "  }",
      "  read(other) {",
      "    return other.loweredField;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(appFile, "export const app = 1;\n");

  const graph = (depFilePath) => ({
    authoredFiles: [appFile],
    entries: ["./app.js"],
    modules: [
      { filePath: appFile, id: appFile, relativePath: "app.js", sourceModuleIds: [appFile] },
      {
        filePath: depFilePath,
        id: depFilePath,
        relativePath: path.basename(depFilePath),
        sourceModuleIds: [depModuleId],
      },
    ],
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: ["./app.js", `./${path.basename(depFilePath)}`],
    srcDir: fixture.srcDir,
  });

  return { post: graph(postDepFile), pre: graph(preDepFile) };
}

test("dependency hazards are read from the post-prebundle graph", async () => {
  // Running the externs stage straight from src skips the bundler define that
  // normally supplies this; the package signature only needs to resolve to a
  // package.json.
  globalThis.__gcc_current_module_url = pathToFileURL(
    path.join(process.cwd(), "dist/index.mjs"),
  ).href;
  const fixture = await createFixture();
  const graphs = await writeExternsGraphFixture(fixture);
  const generatedExternFile = path.join(fixture.projectRoot, "generated.externs.js");

  const options = {
    compiler: { cache: { mode: "off" } },
    externs: {
      generate: {
        modules: ["dep-pkg"],
        outputFile: generatedExternFile,
      },
    },
  };

  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized: graphs.pre,
    options,
    postPrebundleMaterialized: Promise.resolve(graphs.post),
    projectRoot: fixture.projectRoot,
  });

  // The string-keyed definition only exists after prebundling. Scanning the
  // pre-prebundle graph would see `this.loweredField = 1` (dot-defined,
  // dot-accessed, safe) and emit nothing, silently dropping a real hazard.
  expect(await fs.readFile(generatedExternFile, "utf8")).toContain(
    "Object.prototype.loweredField;",
  );

  // Control: feeding the pre-prebundle graph to both sides must NOT find it,
  // which is what makes the assertion above about ordering rather than luck.
  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized: graphs.pre,
    options,
    postPrebundleMaterialized: Promise.resolve(graphs.pre),
    projectRoot: fixture.projectRoot,
  });
  expect(await fs.readFile(generatedExternFile, "utf8")).not.toContain(
    "Object.prototype.loweredField;",
  );
});
