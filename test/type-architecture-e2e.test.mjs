import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
import { resolveClosureCompilerEnvironment } from "../src/build/closure/compiler.ts";
import {
  createFixture,
  execFileAsync,
  findFilesNamed,
  getProjectCacheDir,
} from "./helpers.mjs";

const STRICT_CLOSURE_FLAGS = [
  "--jscomp_error=checkTypes",
  "--jscomp_off=duplicate",
  "--jscomp_off=undefinedVars",
  "--jscomp_off=missingProperties",
].join(" ");

let importCounter = 0;

async function withEnv(values, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectBuildSuccess(result) {
  expect(
    result.ok,
    result.ok
      ? ""
      : result.diagnostics.map(({ message }) => message).join("\n"),
  ).toBe(true);
  return result;
}

async function newestFile(filePaths) {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => ({
      filePath,
      mtimeMs: (await fs.stat(filePath)).mtimeMs,
    })),
  );
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return entries[0]?.filePath;
}

async function resolveProjectCacheDir(fixture, cacheDir) {
  const expected = getProjectCacheDir(cacheDir, fixture.projectRoot);
  try {
    await fs.stat(path.join(expected, "resolve", "latest.json"));
    return expected;
  } catch {
    const latestPath = await newestFile(
      (await findFilesNamed(cacheDir, "latest.json")).filter((filePath) =>
        filePath.includes(`${path.sep}resolve${path.sep}`),
      ),
    );
    expect(latestPath).toBeTruthy();
    return path.dirname(path.dirname(latestPath));
  }
}

async function readLatestNativeMetadata(fixture, cacheDir) {
  const projectCacheDir = await resolveProjectCacheDir(fixture, cacheDir);
  const latest = JSON.parse(
    await fs.readFile(
      path.join(projectCacheDir, "resolve", "latest.json"),
      "utf8",
    ),
  );
  return JSON.parse(
    await fs.readFile(
      path.join(
        projectCacheDir,
        "native-emit",
        latest.nativeEmitKey,
        "meta.json",
      ),
      "utf8",
    ),
  );
}

async function readLatestNamedCacheFile(
  fixture,
  cacheDir,
  fileName,
  pathIncludes,
) {
  const projectCacheDir = await resolveProjectCacheDir(fixture, cacheDir);
  let filePaths = await findFilesNamed(projectCacheDir, fileName);
  if (pathIncludes) {
    filePaths = filePaths.filter((filePath) => filePath.includes(pathIncludes));
  }
  const filePath = await newestFile(filePaths);
  expect(filePath).toBeTruthy();
  return { filePath, text: await fs.readFile(filePath, "utf8") };
}

function sumTypeMetadata(typeMetadata) {
  return typeMetadata.reduce(
    (counts, file) => {
      for (const name of Object.keys(counts)) counts[name] += file.counts[name];
      return counts;
    },
    {
      annotationCount: 0,
      enumDeclarationCount: 0,
      memberAnnotationCount: 0,
      typeDeclarationCount: 0,
      unresolvedTypeReferenceCount: 0,
    },
  );
}

async function readOutputText(outputFiles) {
  return (
    await Promise.all(
      outputFiles
        .filter((filePath) => filePath.endsWith(".js"))
        .map((filePath) => fs.readFile(filePath, "utf8")),
    )
  ).join("\n");
}

async function importOutput(filePath) {
  return import(`${pathToFileURL(filePath).href}?e2e=${importCounter++}`);
}

async function executeStandalone(fixture, mode, outputFiles) {
  const previousRuntime = globalThis.__g;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  delete globalThis.__g;
  delete globalThis.__matrixPromise;
  delete globalThis.__matrixResult;
  try {
    const mainFile = outputFiles.find((filePath) =>
      filePath.endsWith("main.js"),
    );
    expect(mainFile).toBeTruthy();
    // `split` and `bundler-runtime` are one emission path, so both load as
    // native modules; the script-injection harness the split envelope needed is
    // deleted rather than kept alive for a shape nothing emits.
    if (mode !== "off") {
      globalThis.location = { href: pathToFileURL(mainFile).href };
    }
    await importOutput(mainFile);
    await globalThis.__matrixPromise;
    return globalThis.__matrixResult;
  } finally {
    if (previousRuntime === undefined) delete globalThis.__g;
    else globalThis.__g = previousRuntime;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    delete globalThis.__matrixPromise;
    delete globalThis.__matrixResult;
  }
}

async function writeStandaloneMatrixFixture(fixture, mode) {
  await fixture.write(
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
      include: ["src", "node_modules/source-pkg"],
    }),
  );
  await fixture.write(
    "src/ambient.d.ts",
    "export declare class AmbientClient { id: string; }\n",
  );
  await fixture.write(
    "src/model.ts",
    [
      "export interface RecordShape {",
      "  label: string;",
      "  count: number;",
      "  declarationOnlyProperty?: string;",
      "}",
      // A *string* enum: number enums are SWC-lowered and carry no `@enum`
      // metadata, and a `const enum` is erased outright, so this is the shape
      // the enum-declaration counts below measure.
      'export enum Mode { Ready = "1", Done = "2" }',
      "export class Model {",
      "  private veryLongPrivateField = 40;",
      "  constructor(public shape: RecordShape) {}",
      "  total(extra: number): number {",
      "    return this.veryLongPrivateField + this.shape.count + extra;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/view.tsx",
    [
      'import type { Model } from "./model";',
      "export function viewLabel(model: Model): string {",
      "  return model.shape.label;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/typed-js.js",
    "/** @param {string} value @return {number} */\nexport function jsSize(value) { return value.length; }\n",
  );
  await fixture.write(
    "node_modules/source-pkg/package.json",
    JSON.stringify({
      exports: { ".": "./index.ts" },
      name: "source-pkg",
      type: "module",
    }),
  );
  await fixture.write(
    "node_modules/source-pkg/index.ts",
    'export { default, SourceWidget } from "./widget.tsx";\nexport * from "./helpers.ts";\n',
  );
  await fixture.write(
    "node_modules/source-pkg/widget.tsx",
    [
      "export class SourceWidget {",
      "  private internalSourceField = 2;",
      "  read(value: number): number { return value + this.internalSourceField; }",
      "}",
      "export default SourceWidget;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/source-pkg/helpers.ts",
    'export function sourceLabel(value: string): string { return "src:" + value; }\n',
  );
  await fixture.write(
    "src/lazy.ts",
    [
      'import type { Model } from "./model";',
      "export function finish(model: Model, value: number): number {",
      "  return model.total(value);",
      "}",
      "",
    ].join("\n"),
  );

  const finalLines =
    mode === "off"
      ? [
          "const finalValue = model.total(widget.read(size));",
          '(globalThis as any)["__matrixResult"] =',
          '  `${viewLabel(model)}:${sourceLabel("ok")}:${finalValue}:${Mode.Ready}:${reflective["publicReflective"]}`;',
        ]
      : [
          '(globalThis as any)["__matrixPromise"] = import("./lazy").then(({ finish }) => {',
          "  const finalValue = finish(model, widget.read(size));",
          '  const result = `${viewLabel(model)}:${sourceLabel("ok")}:${finalValue}:${Mode.Ready}:${reflective["publicReflective"]}`;',
          '(globalThis as any)["__matrixResult"] = result;',
          "  return result;",
          "});",
        ];
  await fixture.write(
    "src/main.ts",
    [
      'import SourceWidget, { sourceLabel } from "source-pkg";',
      'import type { AmbientClient } from "./ambient";',
      'import { Mode, Model } from "./model";',
      'import { jsSize } from "./typed-js.js";',
      'import { viewLabel } from "./view";',
      "function ambientLabel(_client: AmbientClient, retries: number): string {",
      '  return "ambient:" + retries;',
      "}",
      "const model = new Model({ label: ambientLabel(null as any, 3), count: 1 });",
      "const widget = new SourceWidget();",
      'const size = jsSize("abcd");',
      'const reflective = { publicReflective: "kept", privatePayloadName: 1 };',
      "void reflective.privatePayloadName;",
      ...finalLines,
      "",
    ].join("\n"),
  );
}

test.serial(
  "strict fixtures promote Closure checkTypes while preserving repeated extra flags",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "function square(value: number): number { return value * value; }",
        '(globalThis as any)["__strictFailure"] = square("bad" as any);',
        "",
      ].join("\n"),
    );

    await withEnv(
      { GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS },
      async () => {
        expect(resolveClosureCompilerEnvironment().options.jscomp_off).toEqual([
          "duplicate",
          "undefinedVars",
          "missingProperties",
        ]);
        const errors = [];
        const previousError = console.error;
        console.error = (...values) => errors.push(values.join(" "));
        try {
          const result = await build({
            cache: { mode: "off" },
            diagnostics: { preflight: "off" },
            entries: ["./index.ts"],
            outDir: fixture.outDir,
            platformExterns: "full",
            projectRoot: fixture.projectRoot,
            srcDir: fixture.srcDir,
          });
          expect(result.ok).toBe(false);
        } finally {
          console.error = previousError;
        }
        expect(errors.join("\n")).toContain("actual parameter 1 of square");
      },
    );
  },
);

test.serial(
  "standalone strict metadata survives off, split, and hoisted bundler-runtime",
  { timeout: 90_000 },
  async () => {
    await withEnv(
      { GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS },
      async () => {
        for (const mode of ["off", "split", "bundler-runtime"]) {
          const fixture = await createFixture();
          await writeStandaloneMatrixFixture(fixture, mode);
          const cacheDir = path.join(fixture.projectRoot, ".cache");
          const result = expectBuildSuccess(
            await build({
              cache: { dir: cacheDir, mode: "persistent" },
              chunks: { mode, outputType: "esm" },
              diagnostics: { preflight: "off" },
              entries: ["./main.ts"],
              outDir: fixture.outDir,
              platformExterns: "full",
              projectRoot: fixture.projectRoot,
              srcDir: fixture.srcDir,
            }),
          );

          expect(
            await executeStandalone(fixture, mode, result.outputFiles),
          ).toBe("ambient:3:src:ok:47:1:kept");
          const outputText = await readOutputText(result.outputFiles);
          for (const absent of [
            "AmbientClient",
            "declarationOnlyProperty",
            "internalSourceField",
            "veryLongPrivateField",
          ]) {
            expect(outputText).not.toContain(absent);
          }

          const metadata = await readLatestNativeMetadata(fixture, cacheDir);
          const counts = sumTypeMetadata(metadata.typeMetadata);
          expect(counts.annotationCount).toBeGreaterThan(0);
          expect(counts.memberAnnotationCount).toBeGreaterThan(0);
          expect(counts.typeDeclarationCount).toBeGreaterThan(0);
          expect(counts.enumDeclarationCount).toBeGreaterThan(0);
          expect(counts.unresolvedTypeReferenceCount).toBeGreaterThan(0);
          expect(
            metadata.typeMetadata.some((file) =>
              file.diagnostics.some(
                (diagnostic) =>
                  diagnostic.reason === "ambient-nominal-without-binding",
              ),
            ),
          ).toBe(true);
          expect(
            metadata.typeMetadata.some(
              (file) =>
                file.emittedFile.endsWith(
                  "node_modules/source-pkg/widget.js",
                ) && file.counts.memberAnnotationCount > 0,
            ),
          ).toBe(true);
          expect(
            metadata.typeMetadata.some(
              (file) =>
                file.emittedFile.endsWith("src/typed-js.js") &&
                file.counts.annotationCount > 0,
            ),
          ).toBe(true);
          expect(
            metadata.typeMetadata.some(
              (file) =>
                file.emittedFile.endsWith("src/view.js") &&
                file.counts.annotationCount > 0,
            ),
          ).toBe(true);

          const nativeMain = await fs.readFile(
            metadata.typeMetadata.find((file) =>
              file.emittedFile.endsWith("src/main.js"),
            ).emittedFile,
            "utf8",
          );
          expect(nativeMain).toContain("@param {?} _client");
          expect(nativeMain).not.toContain("AmbientClient");
          const barrier = await readLatestNamedCacheFile(
            fixture,
            cacheDir,
            "native-generated.externs.js",
          );
          expect(barrier.text).toContain("publicReflective");
          expect(barrier.text).not.toContain("declarationOnlyProperty");

          if (mode === "bundler-runtime") {
            const linkedFiles = await findFilesNamed(
              getProjectCacheDir(cacheDir, fixture.projectRoot),
              "main.linked.js",
            );
            const linked = (
              await Promise.all(
                linkedFiles.map((filePath) => fs.readFile(filePath, "utf8")),
              )
            ).join("\n");
            expect(linked).toMatch(/class Model\$\$\d+/);
            expect(linked).toMatch(/@type \{!Model\$\$\d+\}/);
          }
        }
      },
    );
  },
);

test.serial(
  "authored records stay type-only and no structural records are generated",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/main.ts",
      [
        "interface Payload {",
        '  "synthetic-only"?: string;',
        "}",
        "function passThrough(value: PromiseLike<number>, _payload: Payload): PromiseLike<number> {",
        "  return value;",
        "}",
        '(globalThis as any)["__typeOnlyResult"] = passThrough(Promise.resolve(42), {});',
        "",
      ].join("\n"),
    );

    const result = await withEnv(
      {
        GCC_CLOSURE_EXTRA_FLAGS: undefined,
        GCC_DISABLE_TYPE_INFERENCE: undefined,
      },
      async () =>
        expectBuildSuccess(
          await build({
            cache: { dir: cacheDir, mode: "persistent" },
            chunks: { mode: "off", outputType: "esm" },
            diagnostics: { preflight: "off" },
            entries: ["./main.ts"],
            outDir: fixture.outDir,
            platformExterns: "full",
            projectRoot: fixture.projectRoot,
            srcDir: fixture.srcDir,
          }),
        ),
    );
    const outputText = await readOutputText(result.outputFiles);
    expect(outputText).not.toContain("(function(){}).prototype.then;");
    expect(outputText).not.toMatch(/\(function\(\)\{\}\)\.prototype(?:\.|\[)/u);
    expect(outputText).not.toContain("synthetic-only");

    // The compiler input itself must carry no synthesized structural records:
    // `PromiseLike<number>` used to expand into a recursive chain of generated
    // `@record` templates (and malformed `!?` atoms) worth zero output bytes.
    const closureIr = JSON.parse(
      (await readLatestNamedCacheFile(fixture, cacheDir, "closure-ir.json"))
        .text,
    );
    const templates = closureIr.flatMap((file) => [
      ...file.declarations.map((item) => item.template),
      ...file.annotations.map((item) => item.template),
    ]);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.some((template) => template.includes("!?"))).toBe(false);
    expect(templates.some((template) => /\$Record\d/u.test(template))).toBe(
      false,
    );
    expect(
      templates.some((template) => template.includes(".prototype.then;")),
    ).toBe(false);
    expect(
      closureIr.some((file) =>
        file.symbols.some((symbol) => symbol.kind === "generated-record"),
      ),
    ).toBe(false);
    // The authored `Payload` interface is still lowered, still type-only.
    const payload = templates.find((template) =>
      template.includes("function Payload()"),
    );
    expect(payload).toBeDefined();
    expect(payload).toContain("if (false) {");
    expect(payload).toContain("synthetic-only");

    try {
      await importOutput(result.outputFiles[0]);
      expect(await globalThis.__typeOnlyResult).toBe(42);
    } finally {
      delete globalThis.__typeOnlyResult;
    }
  },
);

test.serial(
  "strict CommonJS registry metadata attaches and executes through a dependency",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ESNext",
        },
      }),
    );
    await fixture.write(
      "node_modules/registry-pkg/package.json",
      JSON.stringify({ main: "./index.cjs", name: "registry-pkg" }),
    );
    await fixture.write(
      "node_modules/registry-pkg/dep.cjs",
      "module.exports = { base: 40 };\n",
    );
    await fixture.write(
      "node_modules/registry-pkg/index.cjs",
      [
        'const dep = require("./dep.cjs");',
        "/** @param {number} value @return {number} */",
        "function add(value) { return dep.base + value; }",
        "module.exports = { add };",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import registry from "registry-pkg";',
        '(globalThis as any)["__registryResult"] = registry.add(2);',
        "",
      ].join("\n"),
    );

    const result = await withEnv(
      { GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS },
      async () =>
        expectBuildSuccess(
          await build({
            cache: { dir: cacheDir, mode: "persistent" },
            chunks: { mode: "bundler-runtime", outputType: "esm" },
            diagnostics: { preflight: "off" },
            entries: ["./main.ts"],
            outDir: fixture.outDir,
            platformExterns: "full",
            projectRoot: fixture.projectRoot,
            srcDir: fixture.srcDir,
          }),
        ),
    );

    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      delete globalThis.__g;
      const mainFile = result.outputFiles.find((filePath) =>
        filePath.endsWith("main.js"),
      );
      globalThis.location = { href: pathToFileURL(mainFile).href };
      await importOutput(mainFile);
      expect(globalThis.__registryResult).toBe(42);
    } finally {
      globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      delete globalThis.__registryResult;
    }

    const metadata = await readLatestNativeMetadata(fixture, cacheDir);
    const cjsMetadata = metadata.typeMetadata.find((file) =>
      file.emittedFile.endsWith("node_modules/registry-pkg/index.js"),
    );
    expect(cjsMetadata.counts.annotationCount).toBeGreaterThan(0);
    expect(
      cjsMetadata.diagnostics.some(
        (diagnostic) => diagnostic.reason === "annotation-target-not-found",
      ),
    ).toBe(false);
    const linked = await readLatestNamedCacheFile(
      fixture,
      cacheDir,
      "main.linked.js",
    );
    expect(linked.text).toContain("__register");
    expect(linked.text).toContain("@param {number}");
    expect(linked.text).toContain('"__cjsExports"');
  },
);

test.serial(
  "strict minimal platform slicing includes typed URL dependencies without full externs",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/main.ts",
      [
        "function hostName(url: URL): string { return url.hostname; }",
        'const host = hostName(new URL("https://example.test/path"));',
        '(globalThis as any)["__platformHost"] = host;',
        "",
      ].join("\n"),
    );
    const result = await withEnv(
      { GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS },
      async () =>
        expectBuildSuccess(
          await build({
            cache: { dir: cacheDir, mode: "persistent" },
            diagnostics: { preflight: "off" },
            entries: ["./main.ts"],
            outDir: fixture.outDir,
            platformExterns: "minimal",
            projectRoot: fixture.projectRoot,
            srcDir: fixture.srcDir,
          }),
        ),
    );
    await importOutput(result.outputFiles[0]);
    expect(globalThis.__platformHost).toBe("example.test");
    delete globalThis.__platformHost;

    const platform = await readLatestNamedCacheFile(
      fixture,
      cacheDir,
      "platform-externs.main.js",
    );
    expect(platform.text).toContain("function URL");
    expect(platform.text).toContain("URL.prototype.hostname");
    expect(platform.text).not.toContain("IDBDatabase");
  },
);

async function writeViteMatrixFixture(fixture, cacheDir) {
  await fixture.write(
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
      include: ["src", "node_modules/source-vite-pkg"],
    }),
  );
  await fixture.write(
    "index.html",
    '<script type="module" src="/src/main.ts"></script>\n',
  );

  await fixture.write(
    "node_modules/overlay-pkg/package.json",
    JSON.stringify({
      browser: {
        "./index.js": "./browser/index.js",
        "./sub.js": "./browser/sub.js",
      },
      main: "./index.js",
      name: "overlay-pkg",
      types: "./index.d.ts",
    }),
  );
  await fixture.write(
    "node_modules/overlay-pkg/index.js",
    'export default () => ({ label: "server" });\nexport const namedValue = "server";\n',
  );
  await fixture.write(
    "node_modules/overlay-pkg/index.d.ts",
    [
      'import type { OverlayClass } from "./model.js";',
      'export { OverlayClass } from "./model.js";',
      'export * from "./extra.js";',
      "export default function makeOverlay(): OverlayClass;",
      "export declare const namedValue: string;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/overlay-pkg/model.d.ts",
    [
      "export declare class OverlayClass {",
      "  label: string;",
      "  declarationOnlyOverlay?: string;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/overlay-pkg/extra.d.mts",
    'export declare const starValue: "star";\n',
  );
  await fixture.write(
    "node_modules/overlay-pkg/sub.d.ts",
    [
      'export declare const subValue: "sub";',
      "export declare class SubClass { subLabel: string; }",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/overlay-pkg/sub.js",
    'export const subValue = "server-sub";\n',
  );
  await fixture.write(
    "node_modules/overlay-pkg/browser/model.js",
    [
      "export class OverlayClass {",
      '  constructor() { this.veryLongOverlayPrivate = 2; this.label = "browser"; }',
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/overlay-pkg/browser/extra.js",
    'export const starValue = "star";\n',
  );
  await fixture.write(
    "node_modules/overlay-pkg/browser/index.js",
    [
      'import { OverlayClass } from "./model.js";',
      'export { OverlayClass } from "./model.js";',
      'export * from "./extra.js";',
      'export const namedValue = "named";',
      "export default function makeOverlay() { return new OverlayClass(); }",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/overlay-pkg/browser/sub.js",
    [
      'export const subValue = "sub";',
      "export class SubClass {",
      '  constructor() { this.veryLongSubPrivate = 1; this.subLabel = "sub"; }',
      "}",
      "",
    ].join("\n"),
  );

  await fixture.write(
    "node_modules/legacy-pkg/package.json",
    JSON.stringify({
      exports: {
        ".": {
          default: "./index.cjs",
          require: "./index.cjs",
          types: "./index.d.cts",
        },
      },
      name: "legacy-pkg",
    }),
  );
  await fixture.write(
    "node_modules/legacy-pkg/index.cjs",
    "module.exports = function legacy(value) { return value + 2; };\n",
  );
  await fixture.write(
    "node_modules/legacy-pkg/index.d.cts",
    [
      "declare const legacy: (value: number) => number;",
      "export = legacy;",
      "",
    ].join("\n"),
  );

  await fixture.write(
    "node_modules/source-vite-pkg/package.json",
    JSON.stringify({
      exports: { ".": "./index.ts" },
      name: "source-vite-pkg",
      type: "module",
    }),
  );
  await fixture.write(
    "node_modules/source-vite-pkg/index.ts",
    'export { default, SourceViteWidget } from "./widget.tsx";\nexport * from "./helpers.ts";\n',
  );
  await fixture.write(
    "node_modules/source-vite-pkg/widget.tsx",
    [
      "export class SourceViteWidget {",
      "  private veryLongSourceVitePrivate = 2;",
      "  read(value: number): number { return value + this.veryLongSourceVitePrivate; }",
      "}",
      "export default SourceViteWidget;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/source-vite-pkg/helpers.ts",
    'export const sourceTag: string = "source";\n',
  );

  await fixture.write(
    "src/view.tsx",
    [
      'import type { OverlayClass } from "overlay-pkg";',
      "export function viewLabel(model: OverlayClass): string {",
      "  return `view:${model.label}`;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/typed.js",
    "/** @param {string} value @return {string} */\nexport function jsTag(value) { return `js:${value}`; }\n",
  );
  await fixture.write(
    "src/lazy.ts",
    "export function typedLazy(value: number): number { return value + 1; }\n",
  );
  await fixture.write(
    "src/plain-lazy.js",
    "export function plainLazy(value) { return value + 2; }\n",
  );
  await fixture.write(
    "src/main.ts",
    [
      'import makeOverlay, { namedValue, starValue } from "overlay-pkg";',
      'import { subValue, SubClass } from "overlay-pkg/sub.js";',
      'import legacy from "legacy-pkg";',
      'import SourceViteWidget, { sourceTag } from "source-vite-pkg";',
      'import { jsTag } from "./typed.js";',
      'import { viewLabel } from "./view";',
      "const overlay = makeOverlay();",
      "const sub = new SubClass();",
      "const source = new SourceViteWidget();",
      'const reflective = { publicReflective: "keep", privateReflective: 1 };',
      "void reflective.privateReflective;",
      'const typed = import("./lazy");',
      'const plain = import("./plain-lazy.js");',
      '(globalThis as any)["__viteMatrixPromise"] = Promise.all([typed, plain]).then(([typedModule, plainModule]) => {',
      "  const result = [",
      "    viewLabel(overlay),",
      "    overlay.label + ':' + namedValue,",
      "    starValue,",
      "    subValue + ':' + sub.subLabel,",
      "    'cjs:' + legacy(source.read(1)),",
      "    sourceTag,",
      "    jsTag(String(typedModule.typedLazy(1))),",
      "    plainModule.plainLazy(1),",
      '    reflective["publicReflective"],',
      "  ].join('|');",
      '(globalThis as any)["__viteMatrixResult"] = result;',
      "  return result;",
      "});",
      "",
    ].join("\n"),
  );

  const pluginUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "vite", "index.mjs"),
  ).href;
  await fixture.write(
    "vite.config.mjs",
    [
      `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
      "export default {",
      "  build: { target: 'esnext' },",
      "  plugins: [gccTsBundler({",
      "    compiler: {",
      `      cache: { dir: ${JSON.stringify(cacheDir)}, mode: 'persistent' },`,
      "      chunks: { mode: 'bundler-runtime', outputType: 'esm' },",
      "      diagnostics: { preflight: 'off' },",
      "      platformExterns: 'full',",
      "    },",
      "  })],",
      "};",
      "",
    ].join("\n"),
  );
}

test.serial(
  "Vite strict metadata covers overlays, TS dependencies, CJS, lazy siblings, and type-only cache edits",
  { timeout: 90_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await writeViteMatrixFixture(fixture, cacheDir);
    const viteBin = path.join(
      process.cwd(),
      "node_modules",
      "vite",
      "bin",
      "vite.js",
    );
    const runVite = () =>
      execFileAsync(process.execPath, [viteBin, "build"], {
        cwd: fixture.projectRoot,
        env: {
          ...process.env,
          GCC_BUILD_TIMINGS: "1",
          GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS,
        },
        maxBuffer: 20 * 1024 * 1024,
      });

    const first = await runVite();
    expect(first.stdout).toContain("built in");
    expect(first.stderr).toContain("closure:type-metadata-job: metadata=true");
    expect(first.stderr).toContain("inference=true");

    const modelDeclaration = path.join(
      fixture.projectRoot,
      "node_modules",
      "overlay-pkg",
      "model.d.ts",
    );
    await fs.writeFile(
      modelDeclaration,
      (await fs.readFile(modelDeclaration, "utf8")).replace(
        "declarationOnlyOverlay?: string",
        "declarationOnlyOverlay?: number",
      ),
    );
    const second = await runVite();
    expect(second.stderr).toContain("cache:final-fast: miss");
    expect(second.stderr).toContain("cache:native-emit: miss");

    const html = await fs.readFile(
      path.join(fixture.outDir, "index.html"),
      "utf8",
    );
    const entryPath = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(entryPath).toBeTruthy();
    const entryFile = path.join(fixture.outDir, entryPath.replace(/^\//, ""));
    const previousRuntime = globalThis.__g;
    const previousLocation = globalThis.location;
    try {
      delete globalThis.__g;
      globalThis.location = { href: pathToFileURL(entryFile).href };
      await importOutput(entryFile);
      await globalThis.__viteMatrixPromise;
      expect(globalThis.__viteMatrixResult).toBe(
        "view:browser|browser:named|star|sub:sub|cjs:5|source|js:2|3|keep",
      );
    } finally {
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      globalThis.location = previousLocation;
      delete globalThis.__viteMatrixPromise;
      delete globalThis.__viteMatrixResult;
    }

    const metadata = await readLatestNativeMetadata(fixture, cacheDir);
    const fileFor = (suffix) =>
      metadata.typeMetadata.find((file) => file.emittedFile.endsWith(suffix));
    expect(
      fileFor("node_modules/legacy-pkg/index.js").counts.annotationCount,
    ).toBeGreaterThan(0);
    expect(
      fileFor("node_modules/overlay-pkg/browser/model.js").counts
        .memberAnnotationCount,
    ).toBeGreaterThan(0);
    expect(
      fileFor("node_modules/source-vite-pkg/widget__tsx.js").counts
        .memberAnnotationCount,
    ).toBeGreaterThan(0);
    expect(fileFor("src/lazy__ts.js").counts.annotationCount).toBeGreaterThan(
      0,
    );
    expect(fileFor("src/plain-lazy.js").counts.annotationCount).toBe(0);

    const barrier = await readLatestNamedCacheFile(
      fixture,
      cacheDir,
      "native-generated.externs.js",
    );
    expect(barrier.text).toContain("publicReflective");
    expect(barrier.text).not.toContain("declarationOnlyOverlay");
    const assetFiles = (await findFilesNamed(fixture.outDir, "index.html"))
      .length;
    expect(assetFiles).toBe(1);
    const assetsDir = path.join(fixture.outDir, "assets");
    const outputText = (
      await Promise.all(
        (await fs.readdir(assetsDir))
          .filter((name) => name.endsWith(".js"))
          .map((name) => fs.readFile(path.join(assetsDir, name), "utf8")),
      )
    ).join("\n");
    for (const absent of [
      "declarationOnlyOverlay",
      "veryLongOverlayPrivate",
      "veryLongSourceVitePrivate",
      "veryLongSubPrivate",
    ]) {
      expect(outputText).not.toContain(absent);
    }
  },
);

test.serial(
  "external typed declarations stay extern-only while their runtime bridge is compiled",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "node_modules/ext-runtime/package.json",
      JSON.stringify({
        main: "./index.js",
        name: "ext-runtime",
        types: "./index.d.ts",
      }),
    );
    await fixture.write(
      "node_modules/ext-runtime/index.d.ts",
      [
        "export interface Service { value: string; }",
        "export declare function make(label: string): Service;",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/ext-runtime/index.js",
      "exports.make = (label) => ({ value: label });\n",
    );
    await fixture.write(
      "src/main.ts",
      '(globalThis as any)["__bridgeEntry"] = true;\n',
    );

    const externs = await generateExterns({
      mode: "boundary-aware",
      modules: [{ runtime: "external", specifier: "ext-runtime" }],
      outputFile: path.join(fixture.projectRoot, "generated.externs.js"),
      projectRoot: fixture.projectRoot,
    });
    const moduleInfo = externs.typedDeclarations.moduleExports[0];
    const serviceName = moduleInfo.exports.find(
      ({ exportName }) => exportName === "Service",
    ).qualifiedName;
    const runtimeName = `${moduleInfo.namespace}$runtime`;
    expect(externs.typedDeclarations.text).toContain(serviceName);
    expect(externs.typedDeclarations.text).not.toContain(runtimeName);
    await fixture.write(
      "bridge-input.js",
      [
        'globalThis["__externalModules"] = {',
        '  "ext-runtime": { make(label) { return { value: label }; } },',
        "};",
        "/** @return {?} */",
        "function __gccExternalRuntimeLoad(specifier) {",
        '  return globalThis["__externalModules"][specifier];',
        "}",
        moduleInfo.runtimeBridge,
        `/** @type {function(string): !${serviceName}} */`,
        `const makeExternal = ${runtimeName}.make;`,
        'globalThis["__bridgeResult"] = makeExternal("bridge").value;',
        "",
      ].join("\n"),
    );

    const result = await withEnv(
      { GCC_CLOSURE_EXTRA_FLAGS: STRICT_CLOSURE_FLAGS },
      async () =>
        expectBuildSuccess(
          await build({
            cache: { dir: cacheDir, mode: "persistent" },
            chunks: { mode: "bundler-runtime", outputType: "esm" },
            diagnostics: { preflight: "off" },
            entries: ["./main.ts"],
            js: ["./bridge-input.js"],
            outDir: fixture.outDir,
            platformExterns: "full",
            projectRoot: fixture.projectRoot,
            srcDir: fixture.srcDir,
            typedExterns: [externs.typedDeclarations.outputFile],
          }),
        ),
    );
    const previousRuntime = globalThis.__g;
    const previousLocation = globalThis.location;
    try {
      delete globalThis.__g;
      const mainFile = result.outputFiles.find((filePath) =>
        filePath.endsWith("main.js"),
      );
      globalThis.location = { href: pathToFileURL(mainFile).href };
      await importOutput(mainFile);
      expect(globalThis.__bridgeResult).toBe("bridge");
    } finally {
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      globalThis.location = previousLocation;
      delete globalThis.__bridgeEntry;
      delete globalThis.__bridgeResult;
      delete globalThis.__externalModules;
    }

    const barrier = await readLatestNamedCacheFile(
      fixture,
      cacheDir,
      "native-generated.externs.js",
    );
    expect(barrier.text).not.toContain(serviceName);
    expect(barrier.text).not.toContain(moduleInfo.namespace);
  },
);

test.serial(
  "GCC_DISABLE_TYPE_INFERENCE keeps enum and decorator runtime semantics and separates cache keys",
  { timeout: 45_000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/main.ts",
      [
        "function increment(_value: unknown, _context: ClassAccessorDecoratorContext) {",
        "  return { init(value: number) { return value + 1; } };",
        "}",
        // See the note on the sibling fixture.
        'enum Mode { Ready = "1", Done = "2" }',
        "class Counter {",
        "  @increment accessor value = 1;",
        "}",
        '(globalThis as any)["__escapeResult"] = [Mode.Ready, new Counter().value];',
        "",
      ].join("\n"),
    );
    const options = {
      cache: { dir: cacheDir, mode: "persistent" },
      chunks: { mode: "bundler-runtime", outputType: "esm" },
      diagnostics: { preflight: "off" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      platformExterns: "full",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    };

    const disabled = await withEnv(
      {
        GCC_CLOSURE_EXTRA_FLAGS: undefined,
        GCC_DISABLE_TYPE_INFERENCE: "1",
      },
      async () => expectBuildSuccess(await build(options)),
    );
    const disabledMetadata = await readLatestNativeMetadata(fixture, cacheDir);
    const disabledCounts = sumTypeMetadata(disabledMetadata.typeMetadata);
    expect(disabledCounts.annotationCount).toBe(0);
    expect(disabledCounts.memberAnnotationCount).toBe(0);
    expect(disabledCounts.typeDeclarationCount).toBe(0);
    expect(disabledCounts.enumDeclarationCount).toBeGreaterThan(0);

    const previousRuntime = globalThis.__g;
    const previousLocation = globalThis.location;
    try {
      delete globalThis.__g;
      const mainFile = disabled.outputFiles.find((filePath) =>
        filePath.endsWith("main.js"),
      );
      globalThis.location = { href: pathToFileURL(mainFile).href };
      await importOutput(mainFile);
      // String-enum fixture (see the enum note above): the member is "1"; the
      // second element is the decorator-driven counter, still a number. The
      // point is that the escape hatch keeps both intact.
      expect(globalThis.__escapeResult).toEqual(["1", 2]);
    } finally {
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      globalThis.location = previousLocation;
      delete globalThis.__escapeResult;
    }

    const enabled = await withEnv(
      {
        GCC_CLOSURE_EXTRA_FLAGS: undefined,
        GCC_DISABLE_TYPE_INFERENCE: undefined,
      },
      async () => expectBuildSuccess(await build(options)),
    );
    expect(enabled.cacheHit).toBe(false);
    const enabledCounts = sumTypeMetadata(
      (await readLatestNativeMetadata(fixture, cacheDir)).typeMetadata,
    );
    expect(enabledCounts.annotationCount).toBeGreaterThan(0);
  },
);
