import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { generateExterns } from "../src/api/build.ts";
import { runClosureCompiler } from "../src/build/closure/compiler.ts";
import { createFixture } from "./helpers.mjs";

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
      await fs
        .stat(outputFile.replace(/\.js$/u, ".typed.externs.js"))
        .then(
          () => true,
          () => false,
        ),
    ).toBe(false);
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

    expect(result.text).toContain("No proven rename barriers");
    // The barrier *file* proves nothing here (every module is external), but
    // the typed declarations still pin names through `T.prototype.P` and
    // record keys, so `propertyNames` is their union — not an empty list.
    expect(result.renameBarriers.text).not.toContain("Object.prototype.");
    expect(result.renameBarriers.propertyNames).toEqual(
      result.typedDeclarations.propertyNames,
    );
    expect(result.typedDeclarations.text).toContain("@constructor");
    expect(result.typedDeclarations.text).toContain("@record");
    expect(result.typedDeclarations.text).toContain("@enum {number}");
    expect(result.typedDeclarations.text).toContain("@param");
    expect(result.typedDeclarations.text).toContain("@return");
    expect(result.typedDeclarations.text).not.toContain("Object.prototype.");
    expect(result.typedDeclarations.text).not.toMatch(
      /\bvar (Service|make|typed_runtime)\b/,
    );

    const [root, subpath] = result.typedDeclarations.moduleExports;
    expect(root.specifier).toBe("typed-runtime");
    expect(subpath.specifier).toBe("typed-runtime/subpath");
    expect(root.exports.map((item) => item.exportName)).toContain("default");
    expect(root.exports.map((item) => item.exportName)).toContain("make");
    expect(subpath.exports.map((item) => item.exportName)).toContain("Client");
    expect(subpath.exports.map((item) => item.exportName)).toContain("default");
    expect(subpath.runtimeBridge).toContain(
      '__gccExternalRuntimeLoad("typed-runtime/subpath")',
    );
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
      }),
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
    expect(used.typedDeclarations.text).not.toContain("@enum {number}");

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

const reactExampleRoot = path.resolve(
  import.meta.dirname,
  "../examples/react-vite-official",
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
      result.diagnostics.every((diagnostic) => typeof diagnostic.code === "string"),
    ).toBe(true);
  },
);

test("typed declaration barriers are counted, not invisible", async () => {
  const fixture = await createTypedExternFixture();
  const result = await generateExterns({
    mode: "boundary-aware",
    modules: [{ runtime: "external", specifier: "typed-runtime" }],
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  // Owner-qualified `T.prototype.P` and record keys `{"P": …}` are extern
  // properties exactly like `Object.prototype.P`, so they belong in the count.
  expect(result.typedDeclarations.propertyNames.length).toBeGreaterThan(0);
  for (const name of result.typedDeclarations.propertyNames) {
    expect(result.renameBarriers.propertyNames).toContain(name);
  }
  expect(Array.isArray(result.barrierWarnings)).toBe(true);
});
