import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "bun:test";
import ts from "@typescript/typescript6";

import { collectExternalGlobalProtocolEvidence } from "../src/build/transpile/closure-ir/metadata/external-ownership.ts";
import { prebundleMaterializedDependencies } from "../src/vite/prebundle/index.ts";
import { createCompilerOptions } from "../src/vite/config.ts";
import {
  classifyTypeMetadataSource,
  collectViteTypeMetadata,
  joinDeclarationAndRuntimeExports,
  resolveDeclarationOverlay,
  resolveRuntimeResolutionIdentity,
  resolveRuntimeExportGraph,
} from "../src/vite/type-metadata/index.ts";

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
      "const { class: local } = {};",
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
    entries: modules[0] ? [`./${path.basename(modules[0].filePath)}`] : [],
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


test("runtime export graph resolves default, named, reexport, star, and CJS identities", () => {
  const root = path.normalize("/runtime/index.js");
  const leaf = path.normalize("/runtime/leaf.js");
  const cjs = path.normalize("/runtime/cjs.js");
  const { diagnostics, exports } = resolveRuntimeExportGraph({
    entryModuleId: root,
    modules: new Map([
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
    ]),
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

  const overlay = await resolveDeclarationOverlay({
    containingFilePath: path.join(workspace.root, "app.mts"),
    resolution: {
      conditions: ["browser", "import"],
      format: "esm",
      packageJsonPath,
      packageName: "pkg",
      packageRoot,
      packageSubpath: "feature",
      runtimeModuleId: "pkg/feature-runtime",
      runtimePath: path.join(packageRoot, "feature.js"),
      selectedRuntimeTarget: "./feature.js",
    },
    resolutionMode: "import",
  });

  expect(overlay.identity).toEqual({
    declarationEntryPath: path.join(packageRoot, "feature.d.mts"),
  });
  expect(overlay.exports.map((fact) => fact.exportName).sort()).toEqual([
    "Feature",
    "default",
  ]);
  expect(overlay.cacheFiles).toContain(path.normalize(packageJsonPath));

  const runtime = resolveRuntimeExportGraph({
    entryModuleId: path.join(packageRoot, "feature.js"),
    modules: new Map([
      [path.join(packageRoot, "feature.js"), "export class Feature {}"],
    ]),
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

  const rootOverlay = await resolveDeclarationOverlay({
    containingFilePath: path.join(workspace.root, "app.mts"),
    resolution: {
      conditions: ["browser", "import"],
      format: "esm",
      packageJsonPath,
      packageName: "pkg",
      packageRoot,
      packageSubpath: ".",
      runtimeModuleId: "pkg/browser-runtime",
      runtimePath: path.join(packageRoot, "index.js"),
      selectedRuntimeTarget: "./browser.js",
    },
    resolutionMode: "import",
  });
  expect(
    rootOverlay.exports.map((fact) => [fact.exportName, fact.isTypeOnly]),
  ).toEqual([
    ["Feature", false],
    ["Hidden", true],
    ["NamedFeature", false],
  ]);

  const legacy = await resolveDeclarationOverlay({
    containingFilePath: path.join(workspace.root, "app.cts"),
    resolution: {
      conditions: ["require"],
      format: "cjs",
      packageJsonPath,
      packageName: "pkg",
      packageRoot,
      packageSubpath: "legacy",
      runtimeModuleId: "pkg/legacy-runtime",
      runtimePath: path.join(packageRoot, "legacy.cjs"),
    },
    resolutionMode: "require",
  });
  expect(legacy.identity?.declarationEntryPath).toBe(
    path.join(packageRoot, "legacy.d.cts"),
  );
  expect(legacy.exports.map((fact) => fact.exportName)).toContain("default");
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
    entries: ["./app.js"],
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
    secondFused?.typeMetadata.exportFacades.map((facade) => facade.facadeId),
  ).toEqual(fused?.typeMetadata.exportFacades.map((facade) => facade.facadeId));
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
      entries: ["./app.js"],
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
      entries: ["./app.js"],
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
  const resolution = {
    conditions: ["browser", "import"],
    format: "esm",
    importerModuleId: importer,
    packageJsonPath,
    packageName: "pkg",
    packageRoot,
    packageSubpath: "feature",
    resolutionMode: "import",
    runtimeModuleId: publicRuntimeId,
    runtimePath: publicRuntimeId,
    selectedRuntimeTarget: "./browser/feature.js",
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
});

test("CJS export-equals overlays attach to the normalized one-to-one runtime binding and config carries the sidecar", async () => {
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
    format: "cjs",
    importerModuleId: importer,
    packageJsonPath,
    packageName: "legacy",
    packageRoot,
    packageSubpath: ".",
    resolutionMode: "require",
    runtimeModuleId: runtimeSource,
    runtimePath: runtimeSource,
    selectedRuntimeTarget: "./index.cjs",
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
  const compilerOptions = createCompilerOptions({
    config: { base: "/", build: { target: "esnext" }, root: workspace.root },
    entries: ["./legacy.cjs"],
    externs: [],
    manifestFile: "manifest.json",
    options: {},
    outDir: path.join(workspace.root, "out"),
    projectRoot: workspace.root,
    publicPath: "/",
    srcDir: path.dirname(runtimeFile),
    typeMetadata: result,
  });
  expect(compilerOptions.typeMetadata).toBe(result);
  expect(compilerOptions.typedExterns).toBeUndefined();
});
