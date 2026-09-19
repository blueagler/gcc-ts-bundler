import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { getCapturedModuleAnalysis } from "../../src/vite/capture/index.ts";
import { prebundleMaterializedDependencies } from "../../src/vite/prebundle/index.ts";
import { createFixture } from "../helpers.mjs";

test.serial(
  "prebundleMaterializedDependencies stages authored-only dynamic and bare edges with one-to-one provenance",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const runtimeDir = path.join(fixture.projectRoot, "runtime-src");
    const sources = {
      "src/entry.js": [
        'import * as shared from "./shared.js";',
        'import { increment } from "authored-pkg";',
        "export const value = increment(shared.value);",
        'export const load = () => import("./lazy.js");',
        "",
      ].join("\n"),
      "src/shared.js": "export const value = 40;\n",
      "src/lazy.js":
        'import { value } from "./shared.js";\nexport const lazy = value + 2;\n',
      "node_modules/authored-pkg/index.js":
        "export const increment = (value) => value + 1;\n",
    };
    const modules = [];
    for (const [relativePath, source] of Object.entries(sources)) {
      const filePath = path.join(srcDir, relativePath);
      await fixture.write(path.relative(fixture.projectRoot, filePath), source);
      modules.push({
        filePath,
        format: "esm",
        id: filePath,
        relativePath,
        renderedLength: 0,
        sourceModuleIds: [
          path.join(fixture.projectRoot, relativePath.replace(/\.js$/u, ".ts")),
        ],
      });
    }
    const materialized = {
      authoredFiles: modules.map((module) => module.filePath),
      entries: [
        {
          file: "./src/entry.js",
          sourceModuleId: path.join(fixture.projectRoot, "src/entry.ts"),
        },
      ],
      modules,
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: modules.map((module) => `./${module.relativePath}`),
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [modules[2].sourceModuleIds[0]],
      materialized,
      outputSrcDir: runtimeDir,
    });

    expect(prebundled.srcDir).toBe(runtimeDir);
    expect(prebundled.modules.map((module) => module.filePath)).toEqual(
      modules.map((module) => path.join(runtimeDir, module.relativePath)),
    );
    expect(prebundled.modules.map((module) => module.typeMetadata)).toEqual(
      modules.map((module) => ({
        exportFacades: [],
        kind: "one-to-one",
        sourceMappings: module.sourceModuleIds,
      })),
    );
    for (const module of modules) {
      expect(await fs.readFile(module.filePath, "utf8")).toBe(
        sources[module.relativePath],
      );
    }
    await fs.writeFile(
      path.join(srcDir, "src", "shared.js"),
      "export const value = -1;\n",
    );
    const runtime = await import(
      pathToFileURL(path.resolve(prebundled.srcDir, prebundled.entries[0].file))
        .href
    );
    expect(runtime.value).toBe(41);
    expect((await runtime.load()).lazy).toBe(42);
    expect(prebundled.entries[0].sourceModuleId).toBe(
      path.join(fixture.projectRoot, "src/entry.ts"),
    );
  },
);

test.serial(
  "prebundleMaterializedDependencies routes dependencies even when authored and module counts match",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const runtimeDir = path.join(fixture.projectRoot, "runtime-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const unretainedAuthored = path.join(srcDir, "src", "unretained.js");
    const dependency = path.join(srcDir, "node_modules", "pkg", "index.js");
    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import value from "../node_modules/pkg/index.js";\nexport const result = value + 1;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, unretainedAuthored),
      "export const unused = 0;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, dependency),
      "module.exports = 41;\n",
    );
    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [dependency],
      materialized: {
        authoredFiles: [authoredEntry, unretainedAuthored],
        entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
        modules: [
          {
            filePath: authoredEntry,
            format: "esm",
            id: authoredEntry,
            relativePath: "src/entry.js",
            sourceModuleIds: [authoredEntry],
          },
          {
            filePath: dependency,
            format: "cjs",
            id: dependency,
            relativePath: "node_modules/pkg/index.js",
            sourceModuleIds: [dependency],
          },
        ],
        prunedEmptyModuleIds: [],
        retainedEmptyModuleIds: [],
        runtimeEntries: ["./src/entry.js", "./node_modules/pkg/index.js"],
        srcDir,
      },
      outputSrcDir: runtimeDir,
    });

    expect(
      prebundled.modules.some((module) =>
        module.relativePath.startsWith("__dep-bundles/"),
      ),
    ).toBe(true);
    expect(prebundled.modules.some((module) => module.id === dependency)).toBe(
      false,
    );
    const runtime = await import(
      pathToFileURL(path.resolve(prebundled.srcDir, prebundled.entries[0].file))
        .href
    );
    expect(runtime.result).toBe(42);
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
      entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
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
    const entryBundlePath = rewrittenEntry.match(
      /__dep-bundles\/[\w./-]+/,
    )?.[0];
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
  "prebundleMaterializedDependencies keeps proven multi-module ESM direct and flattens namespace barrels",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const runtimeDir = path.join(fixture.projectRoot, "runtime-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const depIndex = path.join(srcDir, "node_modules", "pkg", "index.js");
    const depFoo = path.join(srcDir, "node_modules", "pkg", "foo.js");
    const depBar = path.join(srcDir, "node_modules", "pkg", "bar.js");

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import * as dep from "../node_modules/pkg/index.js";\nexport const value = dep.foo + dep.bar;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depIndex),
      'export * from "./foo.js";\nexport * from "./bar.js";\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depFoo),
      "export const foo = 3;\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, depBar),
      "export const bar = 4;\n",
    );

    const dependencyModule = (filePath, relativePath, renderedLength = 1) => ({
      filePath,
      format: "esm",
      id: filePath,
      relativePath,
      renderedLength,
      sourceModuleIds: [filePath],
    });
    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [],
      materialized: {
        authoredFiles: [authoredEntry],
        entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
        modules: [
          {
            filePath: authoredEntry,
            id: authoredEntry,
            relativePath: "src/entry.js",
            sourceModuleIds: [authoredEntry],
          },
          dependencyModule(depIndex, "node_modules/pkg/index.js", 0),
          dependencyModule(depFoo, "node_modules/pkg/foo.js"),
          dependencyModule(depBar, "node_modules/pkg/bar.js"),
        ],
        prunedEmptyModuleIds: [],
        retainedEmptyModuleIds: [],
        runtimeEntries: [
          "./src/entry.js",
          "./node_modules/pkg/index.js",
          "./node_modules/pkg/foo.js",
          "./node_modules/pkg/bar.js",
        ],
        srcDir,
      },
      outputSrcDir: runtimeDir,
    });

    expect(
      prebundled.modules.some((module) =>
        module.relativePath.startsWith("__dep-bundles/"),
      ),
    ).toBe(false);
    expect(prebundled.modules).toHaveLength(4);
    const rewrittenEntry = await fs.readFile(
      path.join(runtimeDir, "src", "entry.js"),
      "utf8",
    );
    expect(rewrittenEntry).not.toContain("import * as dep");
    expect(rewrittenEntry).not.toContain("pkg/index.js");
    expect(rewrittenEntry).toContain("pkg/foo.js");
    expect(rewrittenEntry).toContain("pkg/bar.js");
  },
);

test.serial(
  "prebundleMaterializedDependencies resolves CJS through the original package context",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const materializedDependency = path.join(
      srcDir,
      "__deps__",
      "react-dom",
      "index.js",
    );
    const sourceDependency = path.join(
      fixture.projectRoot,
      "isolated-store",
      "node_modules",
      "react-dom",
      "index.js",
    );
    const materializedReact = path.join(
      srcDir,
      "__deps__",
      "react",
      "index.js",
    );
    const sourceReact = path.join(
      fixture.projectRoot,
      "isolated-store",
      "node_modules",
      "react",
      "index.js",
    );
    const scheduler = path.join(
      fixture.projectRoot,
      "isolated-store",
      "node_modules",
      "scheduler",
      "index.js",
    );

    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import dependency from "../__deps__/react-dom/index.js"; export const value = dependency.value;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, materializedDependency),
      'module.exports = { value: require("react").value + require("scheduler").value };\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, materializedReact),
      "module.exports = { value: 10 };\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, sourceDependency),
      "module.exports = {};\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, sourceReact),
      "module.exports = { value: 100 };\n",
    );
    await fixture.write(
      path.relative(fixture.projectRoot, scheduler),
      "module.exports = { value: 7 };\n",
    );

    const materialized = {
      authoredFiles: [authoredEntry],
      dependencySourceFileByMaterializedFile: {
        [materializedDependency]: sourceDependency,
        [materializedReact]: sourceReact,
      },
      entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
      modules: [
        {
          filePath: authoredEntry,
          id: authoredEntry,
          relativePath: "src/entry.js",
          sourceModuleIds: [authoredEntry],
        },
        {
          filePath: materializedDependency,
          id: sourceDependency,
          relativePath: "__deps__/react-dom/index.js",
          sourceModuleIds: [sourceDependency],
        },
        {
          filePath: materializedReact,
          id: sourceReact,
          relativePath: "__deps__/react/index.js",
          sourceModuleIds: [sourceReact],
        },
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: [
        "./src/entry.js",
        "./__deps__/react-dom/index.js",
        "./__deps__/react/index.js",
      ],
      srcDir,
    };

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [],
      materialized,
    });
    const bundle = prebundled.modules.find((module) =>
      module.relativePath.startsWith("__dep-bundles/eager/"),
    );
    expect(bundle).toBeDefined();
    if (!bundle) throw new Error("Expected an eager dependency bundle");
    const bundleText = await fs.readFile(bundle.filePath, "utf8");
    expect(bundleText).toContain("module.exports = { value: 10 }");
    expect(bundleText).not.toContain("value: 100");
    expect(bundleText).toContain("scheduler");
    const marker = JSON.parse(
      await fs.readFile(
        path.join(
          srcDir,
          "__dep-bundles",
          ".gcc-ts-bundler-materialized-dependency-bundles.json",
        ),
        "utf8",
      ),
    );
    expect(marker.kind).toBe("gcc-ts-bundler-materialized-dependency-bundles");
    expect(
      marker.files.some((file) =>
        file.path.endsWith(path.basename(bundle.filePath)),
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
      entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
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
      entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
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
      entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
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
  "prebundle derives eventemitter3-style named exports for an atom facade",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, "captured-src");
    const runtimeDir = path.join(fixture.projectRoot, "runtime-src");
    const authoredEntry = path.join(srcDir, "src", "entry.js");
    const wrapper = path.join(srcDir, "node_modules", "wrapper", "index.js");
    const facade = path.join(srcDir, "__virtual__", "callable-cjs-facade.js");
    const commonJs = path.join(
      srcDir,
      "node_modules",
      "callable-cjs",
      "index.js",
    );
    const commonJsCode = [
      "var state = { exports: {} };",
      "function requireCallable() {",
      "  (function(module) {",
      "    function EventEmitter() { this.value = 42; }",
      "    EventEmitter.EventEmitter = EventEmitter;",
      "    module.exports = EventEmitter;",
      "  })(state);",
      "  return state.exports;",
      "}",
      "export { requireCallable as __require };",
      "",
    ].join("\n");
    const commonJsNamedExports = getCapturedModuleAnalysis({
      code: commonJsCode,
      id: commonJs,
    }).commonJsNamedExports;
    expect(commonJsNamedExports).toEqual(["EventEmitter"]);
    await fixture.write(
      path.relative(fixture.projectRoot, authoredEntry),
      'import { EventEmitter } from "../node_modules/wrapper/index.js"; export const value = new EventEmitter().value;\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, wrapper),
      'import Callable, { EventEmitter } from "../../__virtual__/callable-cjs-facade.js"; export { Callable as default, EventEmitter };\n',
    );
    await fixture.write(
      path.relative(fixture.projectRoot, facade),
      [
        'import { __require as requireCallable } from "../node_modules/callable-cjs/index.js";',
        "var callableExports = requireCallable();",
        "var callableDefault = callableExports;",
        "export { callableDefault as default };",
        "",
      ].join("\n"),
    );
    await fixture.write(
      path.relative(fixture.projectRoot, commonJs),
      commonJsCode,
    );

    const prebundled = await prebundleMaterializedDependencies({
      dynamicRootModuleIds: [],
      materialized: {
        authoredFiles: [authoredEntry],
        entries: [{ file: "./src/entry.js", sourceModuleId: authoredEntry }],
        modules: [
          {
            filePath: authoredEntry,
            format: "esm",
            id: authoredEntry,
            relativePath: "src/entry.js",
            sourceModuleIds: [authoredEntry],
          },
          {
            filePath: wrapper,
            format: "esm",
            id: wrapper,
            relativePath: "node_modules/wrapper/index.js",
            sourceModuleIds: [wrapper],
          },
          {
            filePath: facade,
            format: "cjs",
            id: "\0callable-cjs?commonjs-es-import",
            relativePath: "__virtual__/callable-cjs-facade.js",
            sourceModuleIds: ["\0callable-cjs?commonjs-es-import"],
          },
          {
            commonJsNamedExports,
            filePath: commonJs,
            format: "mixed",
            id: commonJs,
            relativePath: "node_modules/callable-cjs/index.js",
            sourceModuleIds: [commonJs],
          },
        ],
        prunedEmptyModuleIds: [],
        retainedEmptyModuleIds: [],
        runtimeEntries: [
          "./src/entry.js",
          "./node_modules/wrapper/index.js",
          "./__virtual__/callable-cjs-facade.js",
          "./node_modules/callable-cjs/index.js",
        ],
        srcDir,
      },
      outputSrcDir: runtimeDir,
    });

    const atom = prebundled.modules.find((module) =>
      module.relativePath.startsWith("__dep-bundles/atom/"),
    );
    expect(atom).toBeDefined();
    if (!atom) throw new Error("Expected a callable CommonJS atom");
    const exports = await import(
      `${pathToFileURL(atom.filePath).href}?eventemitter3`
    );
    expect(new exports.EventEmitter().value).toBe(42);
    expect(exports.EventEmitter).toBe(exports.default.EventEmitter);
  },
);
