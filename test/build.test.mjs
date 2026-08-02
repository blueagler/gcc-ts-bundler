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
import { createFixture, execFileAsync, findFilesNamed } from "./helpers.mjs";

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

test.serial("emits and executes all external ESM import forms", async () => {
  const fixture = await createFixture();
  await fixture.write("package.json", '{"type":"module"}\n');
  await fixture.write(
    "node_modules/runtime-ext/package.json",
    '{"name":"runtime-ext","type":"module","exports":"./index.js","types":"./index.d.ts"}\n',
  );
  await fixture.write(
    "node_modules/runtime-ext/index.js",
    [
      "globalThis.__runtimeExtLoaded = true;",
      "export default 2;",
      "export const named = 3;",
      "export const side = 1;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/runtime-ext/index.d.ts",
    [
      "declare const value: number;",
      "export default value;",
      "export declare const named: number;",
      "export declare const side: number;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/index.ts",
    [
      'import "runtime-ext";',
      'import value from "runtime-ext";',
      'import { named as alias } from "runtime-ext";',
      'import * as namespace from "runtime-ext";',
      'if (value + alias + namespace.named + namespace.side !== 9) throw new Error("external import mismatch");',
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "off", outputType: "esm" },
    entries: ["./index.ts"],
    externals: ["runtime-ext"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    target: "node",
  });

  expect(result.ok).toBe(true);
  const output = await fixture.read("dist/index.js");
  expect(output).toContain('import "runtime-ext";');
  expect(output).toMatch(/import __gcc_external_[^ ]+ from "runtime-ext";/u);
  expect(output).toMatch(/import \{ named as __gcc_external_/u);
  expect(output).toMatch(/import \* as __gcc_external_/u);
  await execFileAsync(
    process.execPath,
    [path.join(fixture.outDir, "index.js")],
    {
      cwd: fixture.projectRoot,
    },
  );
});

test.serial(
  "uses typed external declarations and warns on opaque fallback",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "cache");
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "node_modules/typed-ext/package.json",
      '{"name":"typed-ext","type":"module","exports":"./index.js","types":"./index.d.ts"}\n',
    );
    await fixture.write(
      "node_modules/typed-ext/index.js",
      "export const count = 1;\n",
    );
    await fixture.write(
      "node_modules/typed-ext/index.d.ts",
      "export declare const count: number;\n",
    );
    await fixture.write(
      "node_modules/opaque-ext/package.json",
      '{"name":"opaque-ext","type":"module","exports":"./index.js"}\n',
    );
    await fixture.write(
      "node_modules/opaque-ext/index.js",
      "export const extra = 2;\n",
    );
    await fixture.write(
      "src/index.ts",
      [
        'import { count } from "typed-ext";',
        'import * as opaque from "opaque-ext";',
        "if (count + opaque.extra !== 3) throw new Error();",
        "",
      ].join("\n"),
    );
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const result = await build({
        cache: { dir: cacheDir, mode: "persistent" },
        chunks: { mode: "off", outputType: "esm" },
        entries: ["./index.ts"],
        externals: ["typed-ext", "opaque-ext"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
        target: "node",
      });
      expect(result.ok).toBe(true);
      await execFileAsync(
        process.execPath,
        [path.join(fixture.outDir, "index.js")],
        { cwd: fixture.projectRoot },
      );
    } finally {
      console.warn = originalWarn;
    }

    const nativeInputs = await findFilesNamed(cacheDir, "index.js");
    const nativeInputTexts = await Promise.all(
      nativeInputs.map((filePath) => fs.readFile(filePath, "utf8")),
    );
    const nativeInput = nativeInputTexts.find(
      (text) => text.includes("goog.module(") && text.includes("extra"),
    );
    expect(nativeInput).toContain('opaque["extra"]');

    const externFiles = await findFilesNamed(
      cacheDir,
      "native-generated.externs.js",
    );
    expect(externFiles).toHaveLength(1);
    const externText = await fs.readFile(externFiles[0], "utf8");
    expect(externText).toContain("Typed external runtime declarations");
    expect(externText).toContain("@type {number}");
    expect(externText).toMatch(/@type \{\?\} \*\/ var __gcc_external_/u);
    expect(externText).not.toMatch(/__gcc_external_[^.\s]+\.extra;/u);
    expect(warnings.join("\n")).toContain("using opaque externs");
  },
);

test.serial(
  "keeps typed Node namespace accesses unquoted and protects them with externs",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "cache");
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "node_modules/@types/node/package.json",
      '{"name":"@types/node","version":"1.0.0","types":"index.d.ts"}\n',
    );
    await fixture.write(
      "node_modules/@types/node/index.d.ts",
      [
        'declare module "node:fs" {',
        "  export function existsSync(path: string): boolean;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/index.ts",
      [
        'import * as fs from "node:fs";',
        'if (!fs.existsSync("package.json")) throw new Error("missing package");',
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      chunks: { mode: "off", outputType: "esm" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      target: "node",
    });
    expect(result.ok).toBe(true);

    const nativeInputs = await findFilesNamed(cacheDir, "index.js");
    const nativeInputTexts = await Promise.all(
      nativeInputs.map((filePath) => fs.readFile(filePath, "utf8")),
    );
    const nativeInput = nativeInputTexts.find(
      (text) => text.includes("goog.module(") && text.includes("existsSync"),
    );
    expect(nativeInput).toMatch(/\.existsSync\(/u);
    expect(nativeInput).not.toContain('["existsSync"]');

    const [externFile] = await findFilesNamed(
      cacheDir,
      "native-generated.externs.js",
    );
    expect(externFile).toBeTruthy();
    const externText = await fs.readFile(externFile, "utf8");
    expect(externText).toMatch(
      /__gcc_external_[^.\s]+\.existsSync = function\(path\) \{\};/u,
    );
    expect(externText).toContain("@param {string} path");

    await execFileAsync(
      process.execPath,
      [path.join(fixture.outDir, "index.js")],
      { cwd: fixture.projectRoot },
    );
  },
);

test.serial("rejects export-from external modules", async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", 'export { value } from "runtime-ext";\n');
  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "off", outputType: "esm" },
    entries: ["./index.ts"],
    externals: ["runtime-ext"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0]?.message).toContain(
    "Export-from external module",
  );
});

test.serial(
  "publishes configured modules verbatim and permits their dynamic require",
  async () => {
    const fixture = await createFixture();
    const loaderSource = [
      "export function load(name) {",
      "  return require(name);",
      "}",
      "",
    ].join("\n");
    await fixture.write("src/loader.js", loaderSource);
    await fixture.write(
      "src/index.js",
      'import { load } from "./loader.js";\nglobalThis.savedLoad = load;\n',
    );
    const preserved = await build({
      cache: { mode: "off" },
      chunks: { mode: "off", outputType: "esm" },
      entries: ["./index.js"],
      outDir: fixture.outDir,
      preserveModules: ["src/loader.js"],
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(preserved.ok).toBe(true);
    expect(await fixture.read("dist/__gcc_preserved/loader.js")).toBe(
      loaderSource,
    );

    await fixture.write(
      "src/compiled.js",
      "const name = './loader.js';\nexport const loaded = require(name);\n",
    );
    const compiled = await build({
      cache: { mode: "off" },
      entries: ["./compiled.js"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(compiled.ok).toBe(false);
  },
);

test.serial(
  "rejects preserved symlinks whose real target escapes the project",
  async () => {
    const fixture = await createFixture();
    const outsidePath = path.join(
      path.dirname(fixture.projectRoot),
      `${path.basename(fixture.projectRoot)}-outside.js`,
    );
    await fs.writeFile(outsidePath, "export const escaped = true;\n", "utf8");
    await fixture.write(
      "src/index.js",
      'import { escaped } from "./linked.js";\nconsole.log(escaped);\n',
    );
    await fs.symlink(outsidePath, path.join(fixture.srcDir, "linked.js"));
    try {
      const result = await build({
        cache: { mode: "off" },
        chunks: { mode: "off", outputType: "esm" },
        entries: ["./index.js"],
        outDir: fixture.outDir,
        preserveModules: ["src/linked.js"],
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.message).toContain(
        "preserveModules path resolves outside projectRoot or srcDir",
      );
      expect(result.diagnostics[0]?.message).toContain(outsidePath);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  },
);

test.serial(
  "rejects in-tree preserved symlink aliases with a clear policy error",
  async () => {
    const fixture = await createFixture();
    const preservedSource =
      "export function load(name) { return require(name); }\n";
    await fixture.write("src/real-loader.js", preservedSource);
    await fs.symlink(
      path.join(fixture.srcDir, "real-loader.js"),
      path.join(fixture.srcDir, "linked-loader.js"),
    );
    await fixture.write(
      "src/index.js",
      'import { load } from "./linked-loader.js";\nglobalThis.savedLoad = load;\n',
    );
    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "off", outputType: "esm" },
      entries: ["./index.js"],
      outDir: fixture.outDir,
      preserveModules: ["src/linked-loader.js"],
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain(
      "preserveModules symlink aliases are unsupported",
    );
    expect(result.diagnostics[0]?.message).toContain("real-loader.js");
  },
);

test.serial("rejects lexical preserveModules path escapes", async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.js", "console.log('entry');\n");
  let thrown;
  try {
    await build({
      cache: { mode: "off" },
      entries: ["./index.js"],
      outDir: fixture.outDir,
      preserveModules: ["../outside.js"],
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
  } catch (error) {
    thrown = error;
  }
  expect(String(thrown)).toContain(
    "preserveModules path must be inside srcDir",
  );
});

test.serial(
  "node-target CLI output preserves shebang and import.meta and runs",
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write("data.txt", "node-fixture\n");
    await fixture.write(
      "src/cli.ts",
      [
        "#!/usr/bin/env node",
        'import { readFileSync } from "node:fs";',
        'if (readFileSync("data.txt", "utf8").trim() !== "node-fixture") throw new Error("read failed");',
        'if (!import.meta.url.startsWith("file:")) throw new Error("import.meta lost");',
        "",
      ].join("\n"),
    );
    const binPath = new URL("../bin/gcc-ts-bundler.mjs", import.meta.url)
      .pathname;
    await execFileAsync(
      process.execPath,
      [
        binPath,
        "build",
        `--project-root=${fixture.projectRoot}`,
        "--src-dir=src",
        "--entry=./cli.ts",
        "--out-dir=dist",
        "--target=node",
        "--chunks=off",
        "--chunk-output-type=esm",
        "--cache-mode=off",
        "--preflight=off",
      ],
      { cwd: fixture.projectRoot },
    );
    const output = await fixture.read("dist/cli.js");
    expect(output.startsWith("#!/usr/bin/env node\nimport ")).toBe(true);
    expect(output).toContain("import.meta.url");
    await execFileAsync(
      process.execPath,
      [path.join(fixture.outDir, "cli.js")],
      {
        cwd: fixture.projectRoot,
      },
    );
  },
);

test.serial("browser target still rejects Node builtins", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { readFileSync } from "node:fs";\nreadFileSync("x");\n',
  );
  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "off", outputType: "esm" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0]?.message).toContain(
    "Unsupported Node builtin import",
  );
});

test.serial(
  "minimal platform externs preserve referenced platform APIs",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        'const node = document.querySelector("#app");',
        "if (node) {",
        '  node.setAttribute("data-ready", "yes");',
        '  node.addEventListener("click", () => {',
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
  "platform externs preserve upstream typed declarations",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "input.js",
      "const canvas = new HTMLCanvasElement(); canvas.captureStream();\n",
    );
    const input = path.join(fixture.projectRoot, "input.js");
    const slice = await generatePlatformExternsText([input]);
    expect(slice).toContain("function HTMLCanvasElement()");
    expect(slice).toContain("@extends {HTMLElement}");
    expect(slice).toContain("@return {!MediaStream}");
    expect(slice).not.toContain("Object.prototype.captureStream;");
  },
);

test.serial(
  "silent type inference is job-local and removable by the escape hatch",
  async () => {
    expect(shouldEnableTypeInference("ADVANCED", true)).toBe(true);
    expect(shouldEnableTypeInference("ADVANCED", false)).toBe(false);
    expect(shouldEnableTypeInference("SIMPLE", true)).toBe(false);

    process.env.GCC_DISABLE_TYPE_INFERENCE = "1";
    try {
      expect(shouldEnableTypeInference("ADVANCED", true)).toBe(false);
    } finally {
      delete process.env.GCC_DISABLE_TYPE_INFERENCE;
    }

    // The wrapper's camelCase keys must render the hidden-inference CLI pair;
    // a typo here is silent (the compiler simply keeps QUIET behaviour).
    const { compiler: ClosureCompiler } =
      await import("google-closure-compiler");
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
      hasTypeMetadata: true,
      js: [],
      jsOutputFile: outputFile,
      languageIn: "UNSTABLE",
      languageOut: "ECMASCRIPT_NEXT",
      rewritePolyfills: false,
      typeMetadataCounts: {
        annotationCount: 1,
        enumDeclarationCount: 0,
        memberAnnotationCount: 0,
        typeDeclarationCount: 0,
        unresolvedTypeReferenceCount: 0,
      },
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
