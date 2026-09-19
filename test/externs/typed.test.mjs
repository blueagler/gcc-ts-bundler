import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { expect, test } from "bun:test";

import { generateExterns } from "../../src/api/build.ts";
import {
  createBuildTypeWorld,
  loadBuildTypeWorldOptions,
} from "../../src/externs/build-plan/create-type-world.ts";
import {
  assembleExternalExterns,
  deriveExternalExternPlan,
  probeExternalExternSpecifiers,
} from "../../src/externs/build-plan/external-plan.ts";
import { runClosureCompiler } from "../../src/build/closure/compiler.ts";
import { createFixture } from "../helpers.mjs";

async function createTypedExternFixture() {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    'import { make } from "typed-runtime";\nexport const service = make("demo");\n',
  );
  await fixture.write(
    "node_modules/typed-runtime/package.json",
    JSON.stringify({
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./subpath": { types: "./subpath.d.ts", default: "./subpath.js" },
      },
      name: "typed-runtime",
      types: "./index.d.ts",
    }),
  );
  await fixture.write(
    "node_modules/typed-runtime/index.js",
    "module.exports = {};\n",
  );
  await fixture.write("node_modules/typed-runtime/subpath.js", "export {};\n");
  await fixture.write(
    "node_modules/typed-runtime/shared.d.ts",
    [
      "export interface Base { id: string; }",
      "export interface Options { label?: string; nested: { count: number }; }",
      "export type Conditional<T> = T extends string ? number : boolean;",
      "export enum Mode { Ready = 1, Done = 2 }",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/typed-runtime/index.d.ts",
    [
      'import type { Base, Options, Conditional } from "./shared";',
      'export { Mode } from "./shared";',
      "export interface ServiceLike extends Base {",
      "  optional?: string | null;",
      "  run(value: string, count?: number, ...flags: boolean[]): Promise<number>;",
      "}",
      "export declare class Service<T> implements ServiceLike {",
      "  constructor(options?: Options);",
      "  id: string;",
      "  optional?: string | null;",
      "  run(value: string): Promise<number>;",
      "  run(value: number, count?: number): Promise<number>;",
      "  static create<U>(value: U): Service<U>;",
      "}",
      "export declare function make(options?: Options): Service<string>;",
      "export declare function make(label: string): Service<string>;",
      "export type Unsafe<T> = Conditional<T>;",
      "export default Service;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/typed-runtime/subpath.d.ts",
    [
      'export { Service as Client, make as default } from "./index";',
      'export * from "./shared";',
      "",
    ].join("\n"),
  );
  return fixture;
}

test.serial(
  "compiled modules do not create empty typed extern siblings",
  async () => {
    const fixture = await createTypedExternFixture();
    const outputFile = path.join(fixture.projectRoot, "generated.externs.js");
    const result = await generateExterns({
      appEntryFiles: ["./main.ts"],
      mode: "boundary-aware",
      modules: ["typed-runtime"],
      outputFile,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.typedDeclarations.moduleExports).toEqual([]);
    expect(result.typedDeclarations.outputFile).toBeUndefined();
    expect(
      await fs.stat(outputFile.replace(/\.js$/u, ".typed.externs.js")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  },
);

test.serial(
  "typed extern signatures use parse-safe positional parameter names",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "node_modules/overloaded-runtime/package.json",
      JSON.stringify({
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        name: "overloaded-runtime",
        types: "./index.d.ts",
      }),
    );
    await fixture.write(
      "node_modules/overloaded-runtime/index.js",
      "export {};\n",
    );
    await fixture.write(
      "node_modules/overloaded-runtime/index.d.ts",
      [
        "export declare function collide(value: string, callback: () => void): void;",
        "export declare function collide(value: string, address: string, callback: () => void): void;",
        "export declare function reserved(arguments: string, eval?: number): void;",
        "",
      ].join("\n"),
    );
    const result = await generateExterns({
      mode: "boundary-aware",
      modules: [{ runtime: "external", specifier: "overloaded-runtime" }],
      projectRoot: fixture.projectRoot,
    });
    const typedFile = path.join(fixture.projectRoot, "typed.externs.js");
    const inputFile = path.join(fixture.projectRoot, "closure-input.js");
    const outputFile = path.join(fixture.projectRoot, "closure-output.js");
    await fs.writeFile(typedFile, result.typedDeclarations.text);
    await fs.writeFile(inputFile, "var value = 1;\n");

    expect(
      (
        await runClosureCompiler({
          compilationLevel: "SIMPLE",
          env: "CUSTOM",
          externs: [typedFile],
          js: [inputFile],
          jsOutputFile: outputFile,
          jscompError: ["duplicate"],
          languageIn: "UNSTABLE",
          languageOut: "ECMASCRIPT_2020",
          warningLevel: "VERBOSE",
        })
      ).exitCode,
    ).toBe(0);
  },
);

test.serial(
  "external declaration translation produces split owner-qualified artifacts",
  async () => {
    const fixture = await createTypedExternFixture();
    const outputFile = path.join(
      fixture.projectRoot,
      "generated.rename-barriers.externs.js",
    );
    const result = await generateExterns({
      mode: "boundary-aware",
      modules: [
        { runtime: "external", specifier: "typed-runtime" },
        { runtime: "external", specifier: "typed-runtime/subpath" },
      ],
      outputFile,
      projectRoot: fixture.projectRoot,
    });

    // The barrier *file* proves nothing here (every module is external), but
    // the typed declarations still pin names through `T.prototype.P` and
    // record keys, so `propertyNames` is their union — not an empty list.
    expect(result.renameBarriers.propertyNames).toEqual(
      result.typedDeclarations.propertyNames,
    );

    const [root, subpath] = result.typedDeclarations.moduleExports;
    expect(root.specifier).toBe("typed-runtime");
    expect(subpath.specifier).toBe("typed-runtime/subpath");
    expect(root.exports.map((item) => item.exportName)).toContain("default");
    expect(root.exports.map((item) => item.exportName)).toContain("make");
    expect(subpath.exports.map((item) => item.exportName)).toContain("Client");
    expect(subpath.exports.map((item) => item.exportName)).toContain("default");
    expect(
      subpath.exports.find((item) => item.exportName === "Client")
        ?.qualifiedName,
    ).toBe(
      root.exports.find((item) => item.exportName === "Service")?.qualifiedName,
    );
    expect(
      result.diagnostics.some(
        (item) => item.code === "unsupported-type-operator",
      ),
    ).toBe(true);

    const typedFile = outputFile.replace(/\.js$/u, ".typed.externs.js");
    expect(await fs.readFile(outputFile, "utf8")).toBe(
      result.renameBarriers.text,
    );
    expect(await fs.readFile(typedFile, "utf8")).toBe(
      result.typedDeclarations.text,
    );

    const inputFile = path.join(fixture.projectRoot, "closure-input.js");
    const compiledFile = path.join(fixture.projectRoot, "closure-output.js");
    await fs.writeFile(inputFile, "const value = 1; console.log(value);\n");
    expect(
      (
        await runClosureCompiler({
          compilationLevel: "SIMPLE",
          env: "BROWSER",
          externs: [typedFile],
          js: [inputFile],
          jsOutputFile: compiledFile,
          jscompError: ["checkTypes"],
          languageIn: "UNSTABLE",
          languageOut: "ECMASCRIPT_2020",
          warningLevel: "DEFAULT",
        })
      ).exitCode,
    ).toBe(0);

    const used = await generateExterns({
      appEntryFiles: ["./main.ts"],
      mode: "boundary-aware",
      modules: [
        { exports: "used", runtime: "external", specifier: "typed-runtime" },
      ],
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(used.typedDeclarations.moduleExports[0]?.exports).toEqual([
      expect.objectContaining({ exportName: "make" }),
    ]);

    const repeated = await generateExterns({
      mode: "boundary-aware",
      modules: [
        { runtime: "external", specifier: "typed-runtime" },
        { runtime: "external", specifier: "typed-runtime/subpath" },
      ],
      projectRoot: fixture.projectRoot,
    });
    expect(repeated.typedDeclarations.text).toBe(result.typedDeclarations.text);
    expect(repeated.typedDeclarations.moduleExports).toEqual(
      result.typedDeclarations.moduleExports,
    );
  },
);

test.serial(
  "disjoint typed fragments preserve shared cyclic, aliased, inherited and namespace contracts independently and together",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "node_modules/projected-runtime/package.json",
      JSON.stringify({
        name: "projected-runtime",
        exports: {
          "./a": { types: "./a.d.ts" },
          "./b": { types: "./b.d.ts" },
          "./unrelated": { types: "./unrelated.d.ts" },
        },
      }),
    );
    await fixture.write(
      "node_modules/projected-runtime/shared.d.ts",
      [
        "export interface Shared { label: string; peer: Peer; }",
        "export interface Peer { shared: Shared; count: number; }",
        "export interface ComparisonOnly { marker: string; }",
        "export declare class Base {",
        "  shared: Shared;",
        "  details: { value: string; edge: ComparisonOnly };",
        "  transform(value: Shared): Peer;",
        "}",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/projected-runtime/a.d.ts",
      [
        'import { Base, Shared, Peer, ComparisonOnly } from "./shared";',
        "export type Mapper = (value: Shared) => Peer;",
        "export declare class Derived<T> extends Base {",
        "  shared: Shared;",
        "  details: { value: T extends string ? number : boolean; edge: ComparisonOnly };",
        "  transform(value: Shared): Peer;",
        "  nested(callback: (value: Shared) => Peer): Shared;",
        "}",
        "export declare namespace Tools {",
        "  function wrap(value: Shared): Peer;",
        "}",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/projected-runtime/b.d.ts",
      [
        'import { Shared, Peer } from "./shared";',
        'export { Shared as Payload, Base as Parent } from "./shared";',
        "export declare function accept(value: Shared): Peer;",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/projected-runtime/unrelated.d.ts",
      "export interface Unrelated { unrelatedFlag: boolean; }\n",
    );
    const modules = ["a", "b", "unrelated"].map((name) => ({
      runtime: "external",
      specifier: `projected-runtime/${name}`,
    }));
    const options = {
      mode: "boundary-aware",
      modules,
      projectRoot: fixture.projectRoot,
    };
    const result = await generateExterns({
      ...options,
      outputFile: "generated/barriers.js",
      typedOutputFile: "generated/full.js",
      typedModuleFragmentsDir: "generated/fragments",
    });
    const full = await generateExterns(options);
    const { moduleFragments, ...typedDeclarations } = result.typedDeclarations;
    expect(typedDeclarations).toEqual({
      ...full.typedDeclarations,
      outputFile: path.join(fixture.projectRoot, "generated/full.js"),
    });
    expect(result.diagnostics).toEqual(full.diagnostics);
    expect(await fs.readFile(result.typedDeclarations.outputFile, "utf8")).toBe(
      result.typedDeclarations.text,
    );
    const exportedName = (specifier, name) =>
      result.typedDeclarations.moduleExports
        .find((module) => module.specifier === `projected-runtime/${specifier}`)
        .exports.find((item) => item.exportName === name).qualifiedName;
    const derived = exportedName("a", "Derived");
    const tools = exportedName("a", "Tools");
    const mapper = exportedName("a", "Mapper");
    const payload = exportedName("b", "Payload");
    const parent = exportedName("b", "Parent");
    const accept = exportedName("b", "accept");
    const unrelated = exportedName("unrelated", "Unrelated");
    const selectFragments = (...roots) => {
      const requested = new Set(
        roots.map((name) => `projected-runtime/${name}`),
      );
      return moduleFragments
        .filter(({ modules }) =>
          modules.some((specifier) => requested.has(specifier)),
        )
        .map(({ outputFile }) => outputFile);
    };
    const consumers = [
      {
        module: "a",
        excluded: accept,
        valid: [
          `/** @param {!${derived}} value @param {${mapper}} callback @return {number} */`,
          "function consume(value, callback) {",
          `  return ${tools}.wrap(value.shared).shared.peer.count +`,
          "    callback(value.shared).count + value.details.edge.marker.length +",
          "    value.transform(value.shared).count +",
          "    value.nested(function(input) { return input.peer; }).peer.count;",
          "}",
        ].join("\n"),
        invalid: [
          `/** @param {!${derived}} value @return {number} */`,
          "function reject(value) { return value.details.edge.marker; }",
        ].join("\n"),
      },
      {
        module: "b",
        excluded: derived,
        valid: [
          `/** @param {!${parent}} owner @param {!${payload}} value @return {string} */`,
          "function consume(owner, value) {",
          `  return owner.transform(value).shared.label + ${accept}(value).shared.label;`,
          "}",
        ].join("\n"),
        invalid: [
          `/** @param {!${payload}} value @return {number} */`,
          "function reject(value) { return value.peer.shared.label; }",
        ].join("\n"),
      },
    ];
    for (const consumer of consumers) {
      const externsFiles = selectFragments(consumer.module);
      const text = (
        await Promise.all(externsFiles.map((file) => fs.readFile(file, "utf8")))
      ).join("\n");
      expect(text).not.toContain(consumer.excluded);
      expect(text).not.toContain(unrelated);
      const inputFile = path.join(fixture.projectRoot, "consumer.js");
      const outputFile = path.join(fixture.projectRoot, "consumer.out.js");
      for (const [source, succeeds] of [
        [consumer.valid, true],
        [consumer.invalid, false],
      ]) {
        await fs.writeFile(inputFile, source);
        const compiled = await runClosureCompiler({
          compilationLevel: "SIMPLE",
          env: "BROWSER",
          externs: externsFiles,
          js: [inputFile],
          jsOutputFile: outputFile,
          jscompError: ["checkTypes", "undefinedVars"],
          languageIn: "UNSTABLE",
          languageOut: "ECMASCRIPT_2020",
          warningLevel: "VERBOSE",
        });
        expect(compiled.exitCode === 0, compiled.diagnostics.join("\n")).toBe(
          succeeds,
        );
      }
    }

    const combinedInput = path.join(
      fixture.projectRoot,
      "combined-consumer.js",
    );
    const combinedOutput = path.join(
      fixture.projectRoot,
      "combined-consumer.out.js",
    );
    const combinedConsumers = [
      {
        succeeds: true,
        source: [
          `/** @param {!${derived}} child @param {!${parent}} owner @param {!${payload}} value @return {number} */`,
          "function consumeTogether(child, owner, value) {",
          "  return child.transform(value).shared.peer.count +",
          `    ${accept}(owner.shared).count + ${tools}.wrap(value).count +`,
          "    owner.details.edge.marker.length;",
          "}",
        ].join("\n"),
      },
      {
        succeeds: false,
        source: [
          `/** @param {!${derived}} child @param {!${payload}} value @return {number} */`,
          "function rejectTogether(child, value) {",
          `  return ${tools}.wrap(child.transform(value).shared).shared.label;`,
          "}",
        ].join("\n"),
      },
    ];
    for (const consumer of combinedConsumers) {
      await fs.writeFile(combinedInput, consumer.source);
      const compileWith = (externs) =>
        runClosureCompiler({
          compilationLevel: "SIMPLE",
          env: "BROWSER",
          externs,
          js: [combinedInput],
          jsOutputFile: combinedOutput,
          jscompError: ["checkTypes", "undefinedVars"],
          languageIn: "UNSTABLE",
          languageOut: "ECMASCRIPT_2020",
          warningLevel: "VERBOSE",
        });
      const complete = await compileWith([result.typedDeclarations.outputFile]);
      const combined = await compileWith(selectFragments("a", "b"));
      expect(complete.exitCode === 0).toBe(consumer.succeeds);
      expect(combined.exitCode).toBe(complete.exitCode);
      const diagnosticCodes = (compiled) =>
        compiled.diagnostics
          .flatMap((message) => message.match(/\[JSC_[A-Z_]+\]/gu) ?? [])
          .sort();
      expect(diagnosticCodes(combined)).toEqual(diagnosticCodes(complete));
    }
  },
);

test.serial(
  "typed fragment destinations reject empty directories and artifact collisions before writing",
  async () => {
    const fixture = await createTypedExternFixture();
    const options = {
      mode: "boundary-aware",
      modules: [
        { runtime: "external", specifier: "typed-runtime" },
        { runtime: "external", specifier: "typed-runtime/subpath" },
      ],
      projectRoot: fixture.projectRoot,
      outputFile: "generated/barriers.js",
      typedOutputFile: "generated/full.js",
    };
    const typedModuleFragmentsDir = "generated/fragments";
    const generated = await generateExterns({
      ...options,
      typedModuleFragmentsDir,
    });
    const fragmentFile =
      generated.typedDeclarations.moduleFragments[0].outputFile;
    await fs.rm(path.join(fixture.projectRoot, "generated"), {
      recursive: true,
    });
    for (const invalidOptions of [
      { typedModuleFragmentsDir: "" },
      { typedModuleFragmentsDir: "   " },
      {
        outputFile: path.relative(fixture.projectRoot, fragmentFile),
      },
      { typedOutputFile: fragmentFile },
    ]) {
      await expect(
        generateExterns({
          ...options,
          typedModuleFragmentsDir,
          ...invalidOptions,
        }),
      ).rejects.toThrow(/typedModuleFragmentsDir/);
    }
    expect(
      await fs.stat(path.join(fixture.projectRoot, "generated")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  },
);

const reactExampleRoot = path.resolve(
  import.meta.dirname,
  "../../examples/react-vite-official",
);

async function hasReactExampleDeps() {
  try {
    await fs.access(path.join(reactExampleRoot, "node_modules/react"));
    await fs.access(path.join(reactExampleRoot, "node_modules/react-dom"));
    return true;
  } catch {
    return false;
  }
}

// Regression lock for the `renderFunctionType` recursion hole: it used to call
// `renderType` with a fresh `seen`, so every function-typed hop reset MAX_DEPTH
// and React's `ReactNode` / `Dispatch<SetStateAction<S>>` cycles blew the stack
// with `RangeError: Maximum call stack size exceeded`. Synthetic fixtures never
// reproduced it — only a real declaration graph does.
test(
  "typed externs render real libraries without exhausting the stack",
  { timeout: 300_000 },
  async () => {
    if (!(await hasReactExampleDeps())) return;

    const result = await generateExterns({
      appEntryFiles: ["./src/main.tsx"],
      mode: "boundary-aware",
      modules: [
        { exports: "used", runtime: "external", specifier: "react" },
        { exports: "used", runtime: "external", specifier: "react-dom" },
      ],
      projectRoot: reactExampleRoot,
      srcDir: "./src",
    });

    expect(result.typedDeclarations.text.length).toBeGreaterThan(0);
    // Degrading to `?` is the sound outcome for a cycle; crashing is not.
    expect(
      result.diagnostics.every(
        (diagnostic) => typeof diagnostic.code === "string",
      ),
    ).toBe(true);
  },
);

test.serial(
  "one typed batch assembles usable boundaries without mutating native externs",
  async () => {
    const fixture = await createFixture();
    for (const [specifier, declarations] of [
      [
        "class-runtime",
        "export declare class Service { constructor(value: number); value: number; }\n",
      ],
      [
        "function-runtime",
        "export declare function double(value: number): number;\n",
      ],
    ]) {
      await fixture.write(
        `node_modules/${specifier}/package.json`,
        JSON.stringify({ name: specifier, types: "./index.d.ts" }),
      );
      await fixture.write(`node_modules/${specifier}/index.d.ts`, declarations);
    }
    await fixture.write(
      "src/main.ts",
      [
        'import { Service } from "class-runtime";',
        'import * as tools from "function-runtime";',
        "export const answer = tools.double(new Service(7).value);",
      ].join("\n"),
    );
    const options = {
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      target: "browser",
    };
    const specifiers = ["class-runtime", "function-runtime", "opaque-runtime"];
    const appEntryFiles = [path.join(fixture.srcDir, "main.ts")];
    const tsConfigPath = path.join(fixture.projectRoot, "tsconfig.json");
    const { compilerOptions, declarationRoots } =
      await loadBuildTypeWorldOptions({
        emitFileNames: appEntryFiles,
        tsConfigPath,
        workspaceDir: fixture.projectRoot,
      });
    const typeWorld = await createBuildTypeWorld({
      compilerOptions,
      declarationRoots,
      emitFileNames: appEntryFiles,
      options,
      specifiers,
      tsxRuntimeSourceFiles: [],
    });
    const probed = await probeExternalExternSpecifiers({
      compilerOptions: typeWorld.compilerOptions,
      options,
      specifiers,
    });
    const plan = await deriveExternalExternPlan({
      appEntryFiles,
      options,
      opaqueSpecifiers: probed.opaqueSpecifiers,
      typedSpecifiers: probed.typedSpecifiers,
      typeWorld,
    });
    expect(plan.opaqueSpecifiers).toEqual(["opaque-runtime"]);
    expect(
      plan.typedDeclarations.moduleExports.map(({ specifier }) => specifier),
    ).toEqual(["class-runtime", "function-runtime"]);

    const nativeText = [
      "/** @externs */",
      "var ExternalService;",
      "var ExternalDouble;",
      "/** @const */ var RuntimeTools = {};",
      "RuntimeTools.double;",
      "/** @type {?} */ var IndependentCarrier;",
      "IndependentCarrier.double;",
      "Object.prototype.nativeOnly;",
      "/** @type {?} */ var OpaqueRuntime;",
      "",
    ].join("\n");
    await fixture.write("native.externs.js", nativeText);
    const externsPath = path.join(fixture.projectRoot, "native.externs.js");
    const outputPath = path.join(fixture.projectRoot, "assembled.externs.js");
    const imports = [
      {
        boundaryExports: ["Service"],
        boundaryNames: ["ExternalService"],
        externalSpecifier: "class-runtime",
      },
      {
        boundaryExports: ["Service"],
        boundaryNames: ["ExternalService"],
        externalSpecifier: "class-runtime",
      },
      {
        boundaryExports: ["double"],
        boundaryNames: ["ExternalDouble"],
        externalSpecifier: "function-runtime",
      },
      {
        boundaryExports: ["*"],
        boundaryNames: ["RuntimeTools"],
        externalSpecifier: "function-runtime",
      },
      {
        boundaryExports: ["*"],
        boundaryNames: ["RuntimeTools"],
        externalSpecifier: "function-runtime",
      },
      {
        boundaryExports: ["run"],
        boundaryNames: ["OpaqueRuntime"],
        externalSpecifier: "opaque-runtime",
      },
    ];
    expect(
      await assembleExternalExterns({ externsPath, imports, plan, outputPath }),
    ).toBe(outputPath);
    expect(await fs.readFile(externsPath, "utf8")).toBe(nativeText);

    await expect(
      assembleExternalExterns({
        externsPath,
        imports,
        plan,
        outputPath: path.join(fixture.projectRoot, ".", "native.externs.js"),
      }),
    ).rejects.toThrow(/must not overwrite/);
    expect(await fs.readFile(externsPath, "utf8")).toBe(nativeText);

    await fixture.write(
      "closure-input.js",
      [
        "var local = { nativeOnly: 2 };",
        'globalThis["answer"] = new ExternalService(7).value +',
        "  RuntimeTools.double(2) + ExternalDouble(2) + IndependentCarrier.double +",
        "  local.nativeOnly + OpaqueRuntime();",
      ].join("\n"),
    );
    const compiledFile = path.join(fixture.projectRoot, "closure-output.js");
    expect(
      (
        await runClosureCompiler({
          compilationLevel: "ADVANCED",
          env: "BROWSER",
          externs: [outputPath],
          js: [path.join(fixture.projectRoot, "closure-input.js")],
          jsOutputFile: compiledFile,
          jscompError: ["duplicate", "checkTypes", "undefinedVars"],
          languageIn: "UNSTABLE",
          languageOut: "ECMASCRIPT_2020",
          warningLevel: "VERBOSE",
        })
      ).exitCode,
    ).toBe(0);
    const context = {
      ExternalService: class {
        constructor(value) {
          this.value = value;
        }
      },
      ExternalDouble: (value) => value * 2,
      RuntimeTools: { double: (value) => value * 2 },
      IndependentCarrier: { double: 3 },
      OpaqueRuntime: () => 5,
    };
    vm.runInNewContext(await fs.readFile(compiledFile, "utf8"), context);
    expect(context.answer).toBe(25);

    await fixture.write(
      "closure-input.js",
      'globalThis["answer"] = ExternalDouble("invalid") + RuntimeTools.double("invalid");\n',
    );
    const invalidCall = await runClosureCompiler({
      compilationLevel: "ADVANCED",
      env: "BROWSER",
      externs: [outputPath],
      js: [path.join(fixture.projectRoot, "closure-input.js")],
      jsOutputFile: compiledFile,
      jscompError: ["duplicate", "checkTypes", "undefinedVars"],
      languageIn: "UNSTABLE",
      languageOut: "ECMASCRIPT_2020",
      warningLevel: "VERBOSE",
    });
    expect(invalidCall.exitCode).not.toBe(0);
    expect(invalidCall.diagnostics.join("\n")).toContain("JSC_TYPE_MISMATCH");
    expect(await fs.readFile(externsPath, "utf8")).toBe(nativeText);
  },
);
