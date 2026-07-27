import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import {
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "../src/build/closure/cache.ts";
import {
  shouldEnableTypeInference,
  TYPE_INFERENCE_OPTIONS,
} from "../src/build/closure/compiler.ts";
import { generatePlatformExternsText } from "../src/build/closure/platform-externs.ts";
import { createFixture } from "./helpers.mjs";

test.serial(
  "builds an ESM package from node_modules in ADVANCED mode",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'import { value } from "demo-pkg";\nexport default value + 1;\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/package.json",
      '{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/browser.js",
      "export const value = 41;\n",
    );
    await fixture.write(
      "node_modules/demo-pkg/import.js",
      "export const value = 99;\n",
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    expect(result.outputFiles).toHaveLength(1);
    const output = await fixture.read("dist/index.js");
    expect(output).not.toMatch(/demo-pkg/);
  },
);

test.serial(
  "minimal platform externs preserve referenced platform APIs",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "const node = document.querySelector(\"#app\");",
        "if (node) {",
        "  node.setAttribute(\"data-ready\", \"yes\");",
        "  node.addEventListener(\"click\", () => {",
        "    queueMicrotask(() => console.log(node.textContent));",
        "  });",
        "}",
        "export default node;",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      platformExterns: "minimal",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/index.js");
    for (const name of [
      "document",
      "querySelector",
      "setAttribute",
      "addEventListener",
      "queueMicrotask",
      "textContent",
    ]) {
      expect(output).toContain(name);
    }
  },
);

test.serial("object entries carry an explicit output name", async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", "export default 41 + 1;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: [{ file: "./index.ts", name: "custom-bundle.js" }],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.ok).toBe(true);
  expect(result.outputFiles.map((file) => path.basename(file))).toEqual([
    "custom-bundle.js",
  ]);
});

test.serial(
  "emits a shared chunk when multiple entries use the same package",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/a.ts",
      'import { shared } from "demo-pkg";\nexport const a = shared + 1;\n',
    );
    await fixture.write(
      "src/b.ts",
      'import { shared } from "demo-pkg";\nexport const b = shared + 2;\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/package.json",
      '{"name":"demo-pkg","module":"./index.js"}\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/index.js",
      "export const shared = 40;\n",
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./a.ts", "./b.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    expect(
      result.outputFiles
        .map((filePath) => path.basename(filePath))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["a.js", "b.js", "shared.js"]);
  },
);

test.serial(
  "full preflight accepts JS dependencies from node_modules",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'import { value } from "demo-pkg";\nexport const answer = value;\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/package.json",
      '{"name":"demo-pkg","module":"./index.js"}\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/index.js",
      "export const value = 7;\n",
    );

    const result = await build({
      cache: { mode: "off" },
      diagnostics: { preflight: "full" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
  },
);

test.serial(
  "authored TypeScript semantic diagnostics surface in supported preflight modes",
  async () => {
    for (const preflight of ["full", "errors-only"]) {
      const fixture = await createFixture();
      await fixture.write(
        "src/index.ts",
        ['const label: number = "bad";', "export default label;", ""].join(
          "\n",
        ),
      );

      const result = await build({
        cache: { mode: "off" },
        diagnostics: { preflight },
        entries: ["./index.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });

      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes(
            "Type 'string' is not assignable to type 'number'",
          ),
        ),
      ).toBe(true);
    }
  },
);

test.serial(
  "persistent cache restores published outputs after the outDir is removed",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export const value = "CACHE_HIT";\n');

    const firstResult = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.cacheHit).toBe(false);

    await fs.rm(fixture.outDir, { force: true, recursive: true });

    const secondResult = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(secondResult.ok).toBe(true);
    expect(secondResult.cacheHit).toBe(true);
    expect(await fixture.read("dist/index.js")).toMatch(/CACHE_HIT/);
  },
);

test.serial("builds mixed ESM and CommonJS package graphs", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { result } from "demo-pkg";\nexport default result;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    [
      'const dep = require("./dep.js");',
      "exports.result = dep.value + 1;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/demo-pkg/dep.js",
    "export const value = 4;\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.ok).toBe(true);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/require\(/);
  expect(output).not.toMatch(/module\.exports/);
});

test.serial("builds decorated TypeScript sources", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/decorators.ts",
    [
      "export function increment(_value: unknown, _context: ClassAccessorDecoratorContext) {",
      "  return {",
      "    init(value: number) {",
      "      return value + 1;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/index.ts",
    [
      'import { increment } from "./decorators.js";',
      "",
      "class Counter {",
      "  @increment accessor value = 1;",
      "}",
      "",
      "export const total = new Counter().value;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.ok).toBe(true);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/@increment/);

  const builtModule = await import(
    `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?decorated=${Date.now()}`
  );
  expect(builtModule.total).toBe(2);
});

test.serial(
  "type-aware annotations preserve extern properties while internal typed properties optimize away",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "type InternalShape = { internalVerboseProperty: number; keepPublic: number };",
        "function makeShape(value: number): InternalShape {",
        "  return { internalVerboseProperty: value + 1, keepPublic: value };",
        "}",
        "class Box {",
        "  longInternalField: number;",
        "  constructor(value: number) { this.longInternalField = value; }",
        "  read(): number { return this.longInternalField; }",
        "}",
        "export function readPublic(input: { keepPublic: number }): number {",
        "  const shape = makeShape(input.keepPublic);",
        "  const box = new Box(shape.internalVerboseProperty);",
        "  return box.read() + input.keepPublic;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "externs.js",
      "/** @externs */\nObject.prototype.keepPublic;\n",
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      externs: ["./externs.js"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/index.js");
    expect(output).toContain("keepPublic");
    expect(output).not.toContain("internalVerboseProperty");
    expect(output).not.toContain("longInternalField");
  },
);

test.serial(
  "exported entry bundles do not retain GCC wrapper exports",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "export class MotionHero {",
        "  static tag = 'motion-hero';",
        "}",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/index.js");
    expect(output).toMatch(/export/);
    expect(output).not.toMatch(/globalThis\.GCC/);
    expect(output).not.toMatch(/__gcc_export_/);
  },
);

test.serial(
  "unsupported CommonJS packages surface actionable diagnostics",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'import value from "demo-pkg";\nexport default value;\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/package.json",
      '{"name":"demo-pkg","main":"./index.cjs"}\n',
    );
    await fixture.write(
      "node_modules/demo-pkg/index.cjs",
      "module.exports = require(name);\n",
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(String(result.diagnostics[0].message)).toMatch(
      /Unsupported CommonJS/,
    );
  },
);

test.serial(
  "platform externs declare typed constructors only when the build carries typed annotations",
  async () => {
    const untyped = await generatePlatformExternsText([]);
    const typed = await generatePlatformExternsText([], {
      typedConstructors: true,
    });

    // An untyped `var HTMLElement;` leaves the platform type unknown, which
    // makes every subclass unknown and silently disables all type-based
    // passes for it (docs/research/typed-input.md §4c). The typed form costs
    // +134 B gzip on untyped input, so it stays gated.
    expect(untyped).toContain("var HTMLElement;");
    expect(untyped).not.toContain("function HTMLElement()");
    expect(typed).toContain("/** @constructor */ function HTMLElement() {}");
    expect(typed).not.toContain("var HTMLElement;");
    // Non-constructor globals are untouched by the gate.
    expect(typed).toContain("var undefined;");
  },
);

test.serial(
  "silent type inference is added to bundler-runtime ADVANCED jobs and removable by the escape hatch",
  async () => {
    expect(shouldEnableTypeInference("bundler-runtime", "ADVANCED")).toBe(true);
    // Only bundler-runtime carries the typed annotations inference exists to
    // feed, and only ADVANCED runs the passes that consume them.
    expect(shouldEnableTypeInference("split", "ADVANCED")).toBe(false);
    expect(shouldEnableTypeInference("off", "ADVANCED")).toBe(false);
    expect(shouldEnableTypeInference("bundler-runtime", "SIMPLE")).toBe(false);

    process.env.GCC_DISABLE_TYPE_INFERENCE = "1";
    try {
      expect(shouldEnableTypeInference("bundler-runtime", "ADVANCED")).toBe(
        false,
      );
    } finally {
      delete process.env.GCC_DISABLE_TYPE_INFERENCE;
    }

    // The wrapper's camelCase keys must render the hidden-inference CLI pair;
    // a typo here is silent (the compiler simply keeps QUIET behaviour).
    const { compiler: ClosureCompiler } = await import(
      "google-closure-compiler"
    );
    expect(
      new ClosureCompiler(TYPE_INFERENCE_OPTIONS).commandArguments,
    ).toEqual(["--hide_warnings_for=/", "--jscomp_warning=checkTypes"]);
  },
);

test.serial(
  "the closure job cache key separates inference-on from inference-off builds",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "job-cache");
    const outputFile = path.join(fixture.projectRoot, "out.js");
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, "var a = 1;\n", "utf8");
    const baseJob = {
      assumeFunctionWrapper: true,
      compilationLevel: "ADVANCED",
      externs: [],
      js: [],
      jsOutputFile: outputFile,
      languageIn: "UNSTABLE",
      languageOut: "ECMASCRIPT_NEXT",
      rewritePolyfills: false,
      warningLevel: "QUIET",
    };
    const restore = (job) =>
      tryRestoreCachedClosureJob({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job,
      });

    await persistCachedClosureJob({
      artifactFiles: [outputFile],
      cacheDir,
      compilerVersion: "test",
      job: { ...baseJob, typeInference: true },
    });

    expect(await restore({ ...baseJob, typeInference: true })).toBe(true);
    // The flag lives in no hashed file, so without explicit keying a cached
    // inference-on artifact would be served to an inference-off build.
    expect(await restore(baseJob)).toBe(false);
  },
);
