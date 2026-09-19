import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "bun:test";
import ts from "@typescript/typescript6";

import { collectExternalGlobalProtocolEvidence } from "../../src/build/transpile/type-metadata/metadata/external-ownership/index.ts";
import { collectNativeAnalysis } from "../../src/build/transpile/emit-native/analysis/collect.ts";
import { normalizeBuildOptions } from "../../src/build/resolve/options.ts";
import { prebundleMaterializedDependencies } from "../../src/vite/prebundle/index.ts";
import { parseRuntimeExportGraph } from "../../src/vite/type-metadata/export-graphs/index.ts";
import {
  classifyTypeMetadataSource,
  collectViteTypeMetadata,
  joinDeclarationAndRuntimeExports,
  resolveDeclarationOverlays,
  resolveRuntimeResolutionIdentity,
  resolveRuntimeExportGraph,
} from "../../src/vite/type-metadata/index.ts";

test("native preflight uses current authored membership on repeated analysis", async () => {
  const workspace = await createWorkspace();
  const firstFile = await workspace.write(
    "first.js",
    "export const first = 1;\n",
  );
  const addedFile = await workspace.write(
    "added.js",
    '// @ts-check\n/** @type {number} */\nexport const added = "wrong";\n',
  );
  const tsConfigPath = await workspace.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
      },
    }),
  );
  const analyze = (authoredFiles) =>
    collectNativeAnalysis({
      boundaryModuleFileNames: [],
      externalSpecifiers: [],
      fileNames: [firstFile, addedFile],
      options: normalizeBuildOptions({
        projectRoot: workspace.root,
        entries: [firstFile, addedFile],
        authoredFiles,
        diagnostics: { preflight: "errors-only" },
      }),
      tsConfigPath,
      workspaceDir: workspace.root,
    });

  const dependencyOnly = await analyze([firstFile]);
  expect(
    dependencyOnly.preflightDiagnostics.filter(
      (diagnostic) =>
        diagnostic.file?.fileName === addedFile && diagnostic.code === 2322,
    ),
  ).toEqual([]);

  const nowAuthored = await analyze([firstFile, addedFile]);
  expect(
    nowAuthored.preflightDiagnostics.some(
      (diagnostic) =>
        diagnostic.file?.fileName === addedFile && diagnostic.code === 2322,
    ),
  ).toBe(true);

  const removedAuthorship = await analyze([firstFile]);
  expect(
    removedAuthorship.preflightDiagnostics.filter(
      (diagnostic) =>
        diagnostic.file?.fileName === addedFile && diagnostic.code === 2322,
    ),
  ).toEqual([]);
});

test("classifies optional bare global protocols without a producer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-global-protocol-"));
  onTestFinished(() => fs.rm(root, { force: true, recursive: true }));
  const filePath = path.join(root, "input.js");
  await fs.writeFile(
    filePath,
    [
      "var root = typeof globalThis !== 'undefined' ? globalThis : window;",
      "root.Prism = {};",
      "Prism.use();",
      "if (typeof global !== 'undefined') nodeCrypto.randomFillSync([]);",
      "if (typeof OPTIONAL_GLOBAL !== 'undefined') OPTIONAL_GLOBAL.run();",
      "void open;",
      "void pageXOffset;",
      "const { class: local, definedKey: localKey = GLOBAL_DEFAULT } = {};",
      "class Result { get styleSheet() { return 42; } set sink(value) {} get [GLOBAL_KEY]() { return 1; } }",
      "const result = new Result();",
      "void result.styleSheet;",
      "const localObject = { OPTIONAL_GLOBAL: 1 };",
      "void localObject.OPTIONAL_GLOBAL;",
      "",
    ].join("\n"),
  );
  const program = ts.createProgram([filePath], {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
  });
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) throw new Error("fixture source is missing");
  const evidence = collectExternalGlobalProtocolEvidence({
    checker: program.getTypeChecker(),
    platformGlobalNames: new Set(["global"]),
    platformGlobalPropertyAliases: new Set(["pageXOffset"]),
    program,
    sourceFiles: [sourceFile],
  });
  expect(evidence.externalGlobals).toEqual([
    "GLOBAL_DEFAULT",
    "GLOBAL_KEY",
    "OPTIONAL_GLOBAL",
    "Prism",
    "nodeCrypto",
    "open",
  ]);
  expect(evidence.rootProperties).toContain("Prism");
  expect(evidence.memberAccessesByFile.get(filePath)?.length).toBe(1);
});

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-vite-types-"));
  onTestFinished(() => fs.rm(root, { force: true, recursive: true }));
  return {
    root,
    async write(relativePath, content) {
      const filePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
      return filePath;
    },
  };
}

function oneToOneModule({ filePath, id, sourceModuleId }) {
  return {
    filePath,
    id,
    relativePath: path.basename(filePath),
    sourceModuleIds: [sourceModuleId],
    typeMetadata: {
      exportFacades: [],
      kind: "one-to-one",
      sourceMappings: [sourceModuleId],
    },
  };
}

function graph({ modules, root, runtimeResolutions = [] }) {
  return {
    authoredFiles: modules
      .filter((module) => !module.sourceModuleIds[0]?.includes("node_modules"))
      .map((module) => module.filePath),
    entries: modules[0]
      ? [
          {
            file: `./${path.basename(modules[0].filePath)}`,
            sourceModuleId: modules[0].sourceModuleIds[0],
          },
        ]
      : [],
    modules,
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: modules.map(
      (module) => `./${path.basename(module.filePath)}`,
    ),
    runtimeResolutions,
    srcDir: root,
  };
}

test("type metadata source eligibility includes dependency TS and explicit JS JSDoc", () => {
  expect(classifyTypeMetadataSource("/app/node_modules/pkg/index.ts")).toBe(
    "ts-runtime",
  );
  expect(classifyTypeMetadataSource("/app/src/App.vue")).toBe("ts-runtime");
  expect(classifyTypeMetadataSource("/app/src/Widget.svelte")).toBe(
    "ts-runtime",
  );
  expect(
    classifyTypeMetadataSource("/app/pkg.js", "/** @param {string} x */\n"),
  ).toBe("js-jsdoc");
  expect(
    classifyTypeMetadataSource("/app/plain.js", "export const x = 1"),
  ).toBe("untyped");
  expect(classifyTypeMetadataSource("virtual:thing.ts")).toBe("untyped");
});

test("runtime resolution identity keeps package subpath and runtime path", async () => {
  const workspace = await createWorkspace();
  await workspace.write(
    "node_modules/pkg/package.json",
    JSON.stringify({ name: "pkg", type: "module" }),
  );
  const runtimePath = await workspace.write(
    "node_modules/pkg/browser/feature.js",
    "export const feature = true;\n",
  );
  const importerModuleId = await workspace.write(
    "src/app.ts",
    'import "pkg/feature";\n',
  );
  const resolution = await resolveRuntimeResolutionIdentity({
    conditions: ["import", "browser"],
    importerModuleId,
    resolvedModuleId: runtimePath,
    specifier: "pkg/feature",
  });

  expect(resolution).toMatchObject({
    conditions: ["browser", "import"],
    importerModuleId,
    packageName: "pkg",
    packageSubpath: "feature",
    resolutionMode: "import",
    runtimeModuleId: runtimePath,
    specifier: "pkg/feature",
  });
});

test("runtime export graph resolves default, named, reexport, star, and CJS identities", async () => {
  const root = path.normalize("/runtime/index.js");
  const leaf = path.normalize("/runtime/leaf.js");
  const cjs = path.normalize("/runtime/cjs.js");
  const modules = new Map(
    [
      [
        root,
        [
          'export { value as named } from "./leaf.js";',
          'export * from "./leaf.js";',
          'export { default } from "./cjs.js";',
          'export type { Hidden } from "./types.js";',
        ].join("\n"),
      ],
      [leaf, "export const value = 1; export const starred = 2;"],
      [
        cjs,
        "const main = () => 1; module.exports = main; exports.extra = value;",
      ],
    ].map(([moduleId, source]) => [
      moduleId,
      parseRuntimeExportGraph(moduleId, source),
    ]),
  );
  const { diagnostics, exports } = await resolveRuntimeExportGraph({
    entryModuleId: root,
    factsFor: async (moduleId) => modules.get(moduleId) ?? [],
  });

  expect(diagnostics).toEqual([]);
  expect(exports.get("named")).toMatchObject({
    localName: "value",
    moduleId: leaf,
  });
  expect(exports.get("starred")).toMatchObject({
    localName: "starred",
    moduleId: leaf,
  });
  expect(exports.get("default")).toMatchObject({
    kind: "cjs",
    localName: "main",
    moduleId: cjs,
  });
  expect(exports.has("Hidden")).toBe(false);
});

test("declaration overlays are subpath/mode aware and join only public runtime exports", async () => {
  const workspace = await createWorkspace();
  const packageRoot = path.join(workspace.root, "node_modules/pkg");
  const packageJsonPath = await workspace.write(
    "node_modules/pkg/package.json",
    JSON.stringify({
      exports: {
        ".": { import: "./index.js", types: "./index.d.ts" },
        "./feature": { import: "./feature.js", types: "./feature.d.mts" },
        "./legacy": { require: "./legacy.cjs", types: "./legacy.d.cts" },
      },
      name: "pkg",
      type: "module",
    }),
  );
  await workspace.write(
    "node_modules/pkg/index.js",
    "export { Feature } from './feature.js';\n",
  );
  await workspace.write(
    "node_modules/pkg/index.d.ts",
    "export { Feature as NamedFeature } from './feature.mjs'; export * from './feature.mjs'; export type { Hidden } from './hidden.js';\n",
  );
  await workspace.write(
    "node_modules/pkg/feature.js",
    "export class Feature {}\n",
  );
  await workspace.write(
    "node_modules/pkg/feature.d.mts",
    "export default class DefaultFeature {}\nexport declare class Feature {}\n",
  );
  await workspace.write(
    "node_modules/pkg/hidden.d.ts",
    "export interface Hidden { x: number }\n",
  );
  await workspace.write(
    "node_modules/pkg/legacy.cjs",
    "module.exports = function legacy() {};\n",
  );
  await workspace.write(
    "node_modules/pkg/legacy.d.cts",
    "declare function legacy(): string; export = legacy;\n",
  );

  const [overlay] = await resolveDeclarationOverlays([
    {
      containingFilePath: path.join(workspace.root, "app.mts"),
      resolution: {
        conditions: ["browser", "import"],
        packageJsonPath,
        packageName: "pkg",
        packageRoot,
        packageSubpath: "feature",
        runtimeModuleId: "pkg/feature-runtime",
        runtimePath: path.join(packageRoot, "feature.js"),
      },
      resolutionMode: "import",
    },
  ]);

  expect(overlay.identity).toEqual({
    declarationEntryPath: path.join(packageRoot, "feature.d.mts"),
  });
  expect(overlay.exports.map((fact) => fact.exportName).sort()).toEqual([
    "Feature",
    "default",
  ]);
  expect(overlay.cacheFiles).toContain(path.normalize(packageJsonPath));

  const runtime = await resolveRuntimeExportGraph({
    entryModuleId: path.join(packageRoot, "feature.js"),
    factsFor: async (moduleId) =>
      parseRuntimeExportGraph(moduleId, "export class Feature {}"),
  });
  const joined = joinDeclarationAndRuntimeExports({
    declarationExports: overlay.exports,
    runtimeExports: runtime.exports,
    runtimeModuleId: "pkg/feature-runtime",
  });
  expect(joined.facts.map((fact) => fact.exportName)).toEqual(["Feature"]);
  expect(joined.diagnostics).toEqual([
    {
      exportName: "default",
      reason: "declaration-runtime-export-mismatch",
      runtimeModuleId: "pkg/feature-runtime",
    },
  ]);

  const [rootOverlay] = await resolveDeclarationOverlays([
    {
      containingFilePath: path.join(workspace.root, "app.mts"),
      resolution: {
        conditions: ["browser", "import"],
        packageJsonPath,
        packageName: "pkg",
        packageRoot,
        packageSubpath: ".",
        runtimeModuleId: "pkg/browser-runtime",
        runtimePath: path.join(packageRoot, "index.js"),
      },
      resolutionMode: "import",
    },
  ]);
  expect(
    rootOverlay.exports.map((fact) => [fact.exportName, fact.isTypeOnly]),
  ).toEqual([
    ["Feature", false],
    ["Hidden", true],
    ["NamedFeature", false],
  ]);

  const [legacy] = await resolveDeclarationOverlays([
    {
      containingFilePath: path.join(workspace.root, "app.cts"),
      resolution: {
        conditions: ["require"],
        packageJsonPath,
        packageName: "pkg",
        packageRoot,
        packageSubpath: "legacy",
        runtimeModuleId: "pkg/legacy-runtime",
        runtimePath: path.join(packageRoot, "legacy.cjs"),
      },
      resolutionMode: "require",
    },
  ]);
  expect(legacy.identity?.declarationEntryPath).toBe(
    path.join(packageRoot, "legacy.d.cts"),
  );
  expect(legacy.exports.map((fact) => fact.exportName)).toContain("default");
});

test("declaration batches preserve package order, transitive dependencies, and conditional modes", async () => {
  const workspace = await createWorkspace();
  const inputs = [];
  const leaves = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const packageRoot = path.join(workspace.root, "node_modules", name);
    const packageJsonPath = await workspace.write(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        type: "module",
        exports: {
          ".": {
            browser: {
              import: { types: "./browser.d.mts" },
              require: { types: "./browser.d.cts" },
            },
            import: { types: "./index.d.mts" },
            require: { types: "./index.d.cts" },
          },
        },
      }),
    );
    await workspace.write(
      `node_modules/${name}/index.d.mts`,
      `export { ${name} } from "./leaf.mjs";\n`,
    );
    leaves.push(
      await workspace.write(
        `node_modules/${name}/leaf.d.mts`,
        `export declare class ${name} {}\n`,
      ),
    );
    inputs.push({
      compilerOptions: { types: [] },
      containingFilePath: path.join(workspace.root, "app.mts"),
      resolution: {
        conditions: ["import"],
        packageJsonPath,
        packageName: name,
        packageRoot,
        packageSubpath: ".",
        runtimeModuleId: `${name}/runtime`,
        runtimePath: path.join(packageRoot, "index.js"),
      },
      resolutionMode: "import",
    });
  }
  await workspace.write(
    "node_modules/gamma/browser.d.mts",
    "export declare class BrowserImport {}\n",
  );
  await workspace.write(
    "node_modules/gamma/browser.d.cts",
    "export declare class BrowserRequire {}\n",
  );
  await workspace.write(
    "node_modules/gamma/index.d.cts",
    "export declare class ServerRequire {}\n",
  );
  const gamma = inputs[2];
  const missing = {
    ...gamma,
    resolution: {
      ...gamma.resolution,
      packageSubpath: "missing",
      runtimeModuleId: "gamma/missing",
    },
  };
  const overlays = await resolveDeclarationOverlays([
    inputs[0],
    missing,
    inputs[1],
    gamma,
    { ...gamma, compilerOptions: { customConditions: ["browser"], types: [] } },
    {
      ...gamma,
      containingFilePath: path.join(workspace.root, "app.cts"),
      resolution: { ...gamma.resolution, conditions: ["browser", "require"] },
      resolutionMode: "require",
    },
    {
      ...gamma,
      containingFilePath: path.join(workspace.root, "app.cts"),
      resolution: { ...gamma.resolution, conditions: ["require"] },
      resolutionMode: "require",
    },
  ]);
  expect(
    overlays.map((overlay) => overlay.exports.map((fact) => fact.exportName)),
  ).toEqual([
    ["alpha"],
    [],
    ["beta"],
    ["gamma"],
    ["BrowserImport"],
    ["BrowserRequire"],
    ["ServerRequire"],
  ]);
  expect(overlays[1].diagnostics).toEqual([
    { reason: "declaration-unresolved", runtimeModuleId: "gamma/missing" },
  ]);
  expect(
    overlays
      .filter((_, index) => index !== 1)
      .flatMap((overlay) => overlay.diagnostics),
  ).toEqual([]);
  const dependencies = new Set(
    overlays.flatMap((overlay) => overlay.cacheFiles),
  );
  for (const filePath of leaves) {
    expect(dependencies.has(path.normalize(filePath))).toBe(true);
  }
  expect(
    overlays
      .slice(4)
      .map((overlay) => path.basename(overlay.identity.declarationEntryPath)),
  ).toEqual(["browser.d.mts", "browser.d.cts", "index.d.cts"]);

  await workspace.write(
    "node_modules/alpha/leaf.d.mts",
    "export interface alpha { changed: string }\n",
  );
  const [updated] = await resolveDeclarationOverlays([inputs[0]]);
  expect(
    updated.exports.map((fact) => [fact.exportName, fact.isTypeOnly]),
  ).toEqual([["alpha", true]]);
  expect(
    overlays[0].exports.map((fact) => [fact.exportName, fact.isTypeOnly]),
  ).toEqual([["alpha", false]]);
});

test("declaration batches do not leak a package's transitive module augmentation into another entry", async () => {
  const workspace = await createWorkspace();
  const inputs = [];
  for (const name of ["plain", "augmenting"]) {
    const packageRoot = path.join(workspace.root, "node_modules", name);
    const packageJsonPath = await workspace.write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: "module", types: "./index.d.ts" }),
    );
    inputs.push({
      compilerOptions: { types: [] },
      resolution: {
        conditions: ["import"],
        packageJsonPath,
        packageName: name,
        packageRoot,
        packageSubpath: ".",
        runtimeModuleId: `${name}/runtime`,
        runtimePath: path.join(packageRoot, "index.js"),
      },
      resolutionMode: "import",
    });
  }
  const plain = await workspace.write(
    "node_modules/plain/index.d.ts",
    "export declare class Original {}\n",
  );
  const augmentation = await workspace.write(
    "node_modules/augmenting/augmentation.d.ts",
    'import "plain"; declare module "plain" { export const injected: number; }\n',
  );
  await workspace.write(
    "node_modules/augmenting/index.d.ts",
    'import "./augmentation.js"; export { Original, injected } from "plain";\n',
  );
  const [plainOverlay, augmentingOverlay] =
    await resolveDeclarationOverlays(inputs);
  expect(plainOverlay.exports.map((fact) => fact.exportName)).toEqual([
    "Original",
  ]);
  expect(
    new Set(augmentingOverlay.exports.map((fact) => fact.exportName)),
  ).toEqual(new Set(["Original", "injected"]));
  expect(plainOverlay.cacheFiles).not.toContain(path.normalize(augmentation));
  expect(augmentingOverlay.cacheFiles).toContain(path.normalize(augmentation));
  expect(augmentingOverlay.cacheFiles).toContain(path.normalize(plain));

  const [augmentedFirst, plainSecond] = await resolveDeclarationOverlays(
    [...inputs].reverse(),
  );
  expect(augmentedFirst.exports).toEqual(augmentingOverlay.exports);
  expect(plainSecond.exports).toEqual(plainOverlay.exports);
});

test("prebundles retain deterministic exported facade provenance", async () => {
  const workspace = await createWorkspace();
  const srcDir = path.join(workspace.root, "captured");
  const outputSrcDir = path.join(workspace.root, "runtime");
  const app = await workspace.write(
    "captured/app.js",
    'import { alpha } from "./pkg-a.js"; import { beta } from "./pkg-b.js"; console.log(alpha, beta);\n',
  );
  const depA = await workspace.write(
    "captured/pkg-a.js",
    "export const alpha = 1;\n",
  );
  const depB = await workspace.write(
    "captured/pkg-b.js",
    "export const beta = 2;\n",
  );
  const graph = {
    authoredFiles: [app],
    entries: [{ file: "./app.js", sourceModuleId: "/src/app.ts" }],
    modules: [
      {
        filePath: app,
        id: "app",
        relativePath: "app.js",
        sourceModuleIds: ["/src/app.ts"],
      },
      {
        filePath: depA,
        id: "pkg/a",
        relativePath: "pkg-a.js",
        sourceModuleIds: ["/node_modules/pkg/a.js"],
      },
      {
        filePath: depB,
        id: "pkg/b",
        relativePath: "pkg-b.js",
        sourceModuleIds: ["/node_modules/pkg/b.js"],
      },
    ],
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: ["./app.js"],
    srcDir,
  };

  const first = await prebundleMaterializedDependencies({
    dynamicRootModuleIds: [],
    materialized: graph,
    outputSrcDir,
  });
  const fused = first.modules.find(
    (module) =>
      module.typeMetadata?.kind === "fused" &&
      module.typeMetadata.exportFacades.length > 0,
  );
  expect(
    fused?.typeMetadata.exportFacades.map((facade) => ({
      origin: `${facade.originModuleId}:${facade.originExportName}`,
      output: facade.outputExportName,
    })),
  ).toEqual([
    { origin: "pkg/a:alpha", output: "alpha" },
    { origin: "pkg/b:beta", output: "beta" },
  ]);

  const second = await prebundleMaterializedDependencies({
    dynamicRootModuleIds: [],
    materialized: graph,
    outputSrcDir: path.join(workspace.root, "runtime-2"),
  });
  const secondFused = second.modules.find(
    (module) =>
      module.typeMetadata?.kind === "fused" &&
      module.typeMetadata.exportFacades.length > 0,
  );
  expect(
    secondFused?.typeMetadata.exportFacades.map((facade) => ({
      origin: `${facade.originModuleId}:${facade.originExportName}`,
      output: facade.outputExportName,
    })),
  ).toEqual(
    fused?.typeMetadata.exportFacades.map((facade) => ({
      origin: `${facade.originModuleId}:${facade.originExportName}`,
      output: facade.outputExportName,
    })),
  );
});

test("typed dependency runtime sources bypass fusion conservatively", async () => {
  const workspace = await createWorkspace();
  const srcDir = path.join(workspace.root, "captured");
  const outputSrcDir = path.join(workspace.root, "runtime");
  const app = await workspace.write(
    "captured/app.js",
    'import { value } from "./typed.js"; console.log(value);\n',
  );
  const dependency = await workspace.write(
    "captured/typed.js",
    "export const value = 1;\n",
  );
  const result = await prebundleMaterializedDependencies({
    dynamicRootModuleIds: [],
    materialized: {
      authoredFiles: [app],
      entries: [{ file: "./app.js", sourceModuleId: "/src/app.ts" }],
      modules: [
        {
          filePath: app,
          id: "app",
          relativePath: "app.js",
          sourceModuleIds: ["/src/app.ts"],
        },
        {
          filePath: dependency,
          id: "typed",
          relativePath: "typed.js",
          sourceModuleIds: ["/node_modules/typed/index.ts"],
        },
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: ["./app.js"],
      srcDir,
    },
    outputSrcDir,
  });

  expect(result.modules).toHaveLength(2);
  expect(
    result.modules.every(
      (module) => module.typeMetadata?.kind === "one-to-one",
    ),
  ).toBe(true);
  expect(
    result.modules.some((module) =>
      module.relativePath.includes("__dep-bundles"),
    ),
  ).toBe(false);
  expect(
    await fs.readFile(path.join(outputSrcDir, "typed.js"), "utf8"),
  ).toContain("value");
});

test("large typed dependency graphs fall back to prebundling", async () => {
  const workspace = await createWorkspace();
  const srcDir = path.join(workspace.root, "captured");
  const outputSrcDir = path.join(workspace.root, "runtime");
  const app = await workspace.write(
    "captured/app.js",
    'import { value } from "./typed.js"; console.log(value);\n',
  );
  const dependency = await workspace.write(
    "captured/typed.js",
    "export const value = 1;\n",
  );
  const fillerModules = await Promise.all(
    Array.from({ length: 255 }, async (_, index) => {
      const filePath = await workspace.write(
        `captured/filler-${index}.js`,
        `export const filler${index} = ${index};\n`,
      );
      return {
        filePath,
        id: `filler-${index}`,
        relativePath: `filler-${index}.js`,
        sourceModuleIds: [`/node_modules/filler-${index}/index.js`],
      };
    }),
  );
  const result = await prebundleMaterializedDependencies({
    dynamicRootModuleIds: [],
    materialized: {
      authoredFiles: [app],
      entries: [{ file: "./app.js", sourceModuleId: "/src/app.ts" }],
      modules: [
        {
          filePath: app,
          id: "app",
          relativePath: "app.js",
          sourceModuleIds: ["/src/app.ts"],
        },
        {
          filePath: dependency,
          id: "typed",
          relativePath: "typed.js",
          sourceModuleIds: ["/node_modules/typed/index.ts"],
        },
        ...fillerModules,
      ],
      prunedEmptyModuleIds: [],
      retainedEmptyModuleIds: [],
      runtimeEntries: ["./app.js"],
      srcDir,
    },
    outputSrcDir,
  });

  expect(result.modules.length).toBeGreaterThan(1);
  expect(
    result.modules.some((module) =>
      module.relativePath.includes("__dep-bundles"),
    ),
  ).toBe(true);
});

test("shared extractor targets project, dependency, TSX, and JSDoc sources without guessing transformed ids", async () => {
  const workspace = await createWorkspace();
  await workspace.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        jsx: "preserve",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        target: "ESNext",
      },
    }),
  );
  const appSource = await workspace.write(
    "src/app.ts",
    'import type { Config } from "./types"; export function app(value: Config): string { return value.label; }\n',
  );
  const typeOnlySource = await workspace.write(
    "src/types.ts",
    "export interface Config { label: string }\n",
  );
  const viewSource = await workspace.write(
    "src/view.tsx",
    "export function View(props: { label: string }): string { return props.label; }\n",
  );
  await workspace.write(
    "node_modules/typed-dep/package.json",
    JSON.stringify({ name: "typed-dep", type: "module" }),
  );
  const dependencySource = await workspace.write(
    "node_modules/typed-dep/index.ts",
    "export class Dep { count: number = 1; } export function use(dep: Dep): number { return dep.count; }\n",
  );
  const jsdocSource = await workspace.write(
    "src/typed.js",
    "/** @param {string} value @return {number} */ export function size(value) { return value.length; }\n",
  );
  const runtimeRoot = path.join(workspace.root, "runtime");
  const appRuntime = await workspace.write(
    "runtime/app.js",
    "export function app(value) { return value.label; }\n",
  );
  const viewRuntime = await workspace.write(
    "runtime/view.js",
    "export function View(props) { return props.label; }\n",
  );
  const dependencyRuntime = await workspace.write(
    "runtime/dependency.js",
    "export class Dep { constructor() { this.count = 1; } } export function use(dep) { return dep.count; }\n",
  );
  const jsdocRuntime = await workspace.write(
    "runtime/typed.js",
    "export function size(value) { return value.length; }\n",
  );
  const queryRuntime = await workspace.write(
    "runtime/query.js",
    "export const query = 1;\n",
  );
  const virtualRuntime = await workspace.write(
    "runtime/virtual.js",
    "export const virtual = 1;\n",
  );
  const modules = [
    oneToOneModule({
      filePath: appRuntime,
      id: "app",
      sourceModuleId: appSource,
    }),
    oneToOneModule({
      filePath: viewRuntime,
      id: "view",
      sourceModuleId: viewSource,
    }),
    oneToOneModule({
      filePath: dependencyRuntime,
      id: "typed-dep",
      sourceModuleId: dependencySource,
    }),
    oneToOneModule({
      filePath: jsdocRuntime,
      id: "typed-js",
      sourceModuleId: jsdocSource,
    }),
    oneToOneModule({
      filePath: queryRuntime,
      id: "query",
      sourceModuleId: `${appSource}?used`,
    }),
    oneToOneModule({
      filePath: virtualRuntime,
      id: "virtual",
      sourceModuleId: "\0virtual:typed.ts",
    }),
  ];
  const materialized = graph({ modules, root: runtimeRoot });
  const result = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
  });

  expect(result.files.map((file) => file.runtimeModuleId).sort()).toEqual([
    "app",
    "typed-dep",
    "typed-js",
    "view",
  ]);
  expect(result.dependencies).toContain(path.normalize(typeOnlySource));
  expect(
    result.files.some((file) => file.sourceFilePath === typeOnlySource),
  ).toBe(false);
  expect(result.extractedCounts.annotationCount).toBeGreaterThanOrEqual(4);
  expect(result.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(
    expect.arrayContaining(["query-module-omitted", "virtual-module-omitted"]),
  );
  expect(
    result.files.every((file) =>
      modules.some(
        (module) =>
          module.filePath === file.filePath &&
          module.id === file.runtimeModuleId,
      ),
    ),
  ).toBe(true);
});

test("declaration overlays attach only proven browser-subpath exports to fused vendor and lazy facades", async () => {
  const workspace = await createWorkspace();
  await workspace.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ESNext",
      },
    }),
  );
  const packageRoot = path.join(workspace.root, "node_modules/pkg");
  const packageJsonPath = await workspace.write(
    "node_modules/pkg/package.json",
    JSON.stringify({
      exports: {
        "./feature": {
          browser: "./browser/feature.js",
          import: "./feature.js",
          types: "./types/feature.d.ts",
        },
      },
      name: "pkg",
      type: "module",
    }),
  );
  const publicRuntimeId = await workspace.write(
    "node_modules/pkg/browser/feature.js",
    'export { Feature, create } from "./model.js";\n',
  );
  const leafRuntimeId = await workspace.write(
    "node_modules/pkg/browser/model.js",
    "export class Feature { constructor(label) { this.label = label; } } export function create(label) { return new Feature(label); }\n",
  );
  await workspace.write(
    "node_modules/pkg/types/feature.d.ts",
    'export { Feature, create } from "./model.js"; export type { Hidden } from "./model.js";\n',
  );
  const declarationModel = await workspace.write(
    "node_modules/pkg/types/model.d.ts",
    "export declare class Feature { label: string; } export declare const create: (label: string) => Feature; export interface Hidden { secret: string; }\n",
  );
  const importer = await workspace.write(
    "app.mts",
    'import { create } from "pkg/feature"; void create;\n',
  );
  const sourceRoot = path.join(workspace.root, "captured");
  const publicRuntimeFile = await workspace.write(
    "captured/feature.js",
    'export { Feature, create } from "./model.js";\n',
  );
  const leafRuntimeFile = await workspace.write(
    "captured/model.js",
    "export class Feature { constructor(label) { this.label = label; } } export function create(label) { return new Feature(label); }\n",
  );
  const unusedRuntimeFile = await workspace.write(
    "captured/unused.js",
    "export const unused = 1;\n",
  );
  const resolution = {
    conditions: ["browser", "import"],
    importerModuleId: importer,
    packageJsonPath,
    packageName: "pkg",
    packageRoot,
    packageSubpath: "feature",
    resolutionMode: "import",
    runtimeModuleId: publicRuntimeId,
    runtimePath: publicRuntimeId,
    specifier: "pkg/feature",
  };
  const sourceGraph = graph({
    modules: [
      oneToOneModule({
        filePath: publicRuntimeFile,
        id: publicRuntimeId,
        sourceModuleId: publicRuntimeId,
      }),
      oneToOneModule({
        filePath: leafRuntimeFile,
        id: leafRuntimeId,
        sourceModuleId: leafRuntimeId,
      }),
      oneToOneModule({
        filePath: unusedRuntimeFile,
        id: "unused-provenance",
        sourceModuleId: "unused-provenance",
      }),
      oneToOneModule({
        filePath: path.join(sourceRoot, "unreadable.js"),
        id: "unreadable-provenance",
        sourceModuleId: "unreadable-provenance",
      }),
    ],
    root: sourceRoot,
    runtimeResolutions: [resolution],
  });
  const finalRoot = path.join(workspace.root, "final");
  const vendorFile = await workspace.write(
    "final/vendor.js",
    "class Feature$1 { constructor(label) { this.label = label; } } export { Feature$1 as Feature };\n",
  );
  const lazyFile = await workspace.write(
    "final/lazy.js",
    "function create$1(label) { return label; } export { create$1 as make };\n",
  );
  const fusedModule = (filePath, id, facade) => ({
    filePath,
    id,
    relativePath: path.basename(filePath),
    sourceModuleIds: [publicRuntimeId, leafRuntimeId],
    typeMetadata: {
      exportFacades: [facade],
      kind: "fused",
      sourceMappings: [],
    },
  });
  const materialized = graph({
    modules: [
      fusedModule(vendorFile, "fused:vendor", {
        originExportName: "Feature",
        originModuleId: publicRuntimeId,
        outputExportName: "Feature",
        outputLocalName: "Feature$1",
      }),
      fusedModule(lazyFile, "fused:lazy", {
        originExportName: "create",
        originModuleId: publicRuntimeId,
        outputExportName: "make",
        outputLocalName: "create$1",
      }),
    ],
    root: finalRoot,
    runtimeResolutions: [resolution],
  });

  const first = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(first.files.map((file) => file.runtimeModuleId).sort()).toEqual([
    "fused:lazy",
    "fused:vendor",
  ]);
  expect(
    first.files.flatMap((file) =>
      file.annotations.map((annotation) =>
        annotation.target.kind === "binding"
          ? annotation.target.bindingName
          : annotation.target.ownerBindingName,
      ),
    ),
  ).toEqual(expect.arrayContaining(["Feature$1", "create$1"]));
  expect(
    first.files
      .flatMap((file) =>
        file.annotations.map((annotation) => JSON.stringify(annotation.target)),
      )
      .join("\n"),
  ).not.toContain("Hidden");
  expect(first.dependencies).toContain(path.normalize(declarationModel));
  expect(first.dependencies).toContain(path.normalize(publicRuntimeFile));
  expect(first.dependencies).toContain(path.normalize(leafRuntimeFile));
  expect(first.dependencies).not.toContain(path.normalize(unusedRuntimeFile));
  expect(
    first.diagnostics.some(
      (diagnostic) => diagnostic.runtimeModuleId === "unreadable-provenance",
    ),
  ).toBe(false);

  await workspace.write(
    "captured/unused.js",
    "export const unrelated = 123;\n",
  );
  const unchanged = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(JSON.stringify(unchanged)).toBe(JSON.stringify(first));

  await workspace.write(
    "captured/feature.js",
    'export { Feature } from "./model.js";\n',
  );
  const narrowed = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(narrowed.files.map((file) => file.runtimeModuleId)).toEqual([
    "fused:vendor",
  ]);
  await workspace.write(
    "captured/feature.js",
    'export { Feature, create } from "./model.js";\n',
  );
  const restoredExports = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(restoredExports.files).toEqual(first.files);

  await workspace.write(
    "node_modules/pkg/types/model.d.ts",
    "export declare class Feature { label: number; } export declare const create: (label: number) => Feature; export interface Hidden { secret: string; }\n",
  );
  const second = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(JSON.stringify(second.files)).not.toBe(JSON.stringify(first.files));

  const missingLeaf = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph: {
      ...sourceGraph,
      modules: sourceGraph.modules.filter(
        (module) => module.id !== leafRuntimeId,
      ),
    },
  });
  expect(missingLeaf.files).toEqual([]);
  const restored = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
    sourceGraph,
  });
  expect(restored.files).toEqual(second.files);
});

test("CJS export-equals overlays attach to the normalized one-to-one runtime binding", async () => {
  const workspace = await createWorkspace();
  await workspace.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ESNext",
      },
    }),
  );
  const packageRoot = path.join(workspace.root, "node_modules/legacy");
  const packageJsonPath = await workspace.write(
    "node_modules/legacy/package.json",
    JSON.stringify({
      exports: { ".": { require: "./index.cjs", types: "./index.d.cts" } },
      name: "legacy",
    }),
  );
  const runtimeSource = await workspace.write(
    "node_modules/legacy/index.cjs",
    "function legacy(value) { return String(value); } module.exports = legacy;\n",
  );
  await workspace.write(
    "node_modules/legacy/index.d.cts",
    "declare const legacy: (value: number) => string; export = legacy;\n",
  );
  const importer = await workspace.write(
    "app.cts",
    'import legacy = require("legacy"); void legacy;\n',
  );
  const runtimeFile = await workspace.write(
    "runtime/legacy.cjs",
    "function legacy(value) { return String(value); } module.exports = legacy;\n",
  );
  const resolution = {
    conditions: ["require"],
    importerModuleId: importer,
    packageJsonPath,
    packageName: "legacy",
    packageRoot,
    packageSubpath: ".",
    resolutionMode: "require",
    runtimeModuleId: runtimeSource,
    runtimePath: runtimeSource,
    specifier: "legacy",
  };
  const materialized = graph({
    modules: [
      oneToOneModule({
        filePath: runtimeFile,
        id: runtimeSource,
        sourceModuleId: runtimeSource,
      }),
    ],
    root: path.dirname(runtimeFile),
    runtimeResolutions: [resolution],
  });
  const result = await collectViteTypeMetadata({
    materialized,
    projectRoot: workspace.root,
  });

  expect(result.files).toHaveLength(1);
  expect(
    result.files[0].annotations.some(
      (annotation) =>
        annotation.target.kind === "binding" &&
        annotation.target.bindingName === "__cjsExports",
    ),
  ).toBe(true);
});
