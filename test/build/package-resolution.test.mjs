import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../../dist/index.mjs";
import { createFixture } from "../helpers.mjs";

for (const mode of ["off", "split"]) {
  test.serial(
    `inert CommonJS text does not change ESM semantics in ${mode} output`,
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixture();
      await fixture.write(
        "node_modules/inert-esm/package.json",
        '{"name":"inert-esm","type":"module","exports":"./index.js"}',
      );
      await fixture.write(
        "node_modules/inert-esm/index.js",
        'export const value = 42; export const text = "module.exports exports.x exports[x] require(";',
      );
      await fixture.write(
        "node_modules/real-cjs/package.json",
        '{"name":"real-cjs","main":"./index.cjs"}',
      );
      await fixture.write("node_modules/real-cjs/dep.js", "exports.value = 6;");
      await fixture.write(
        "node_modules/real-cjs/index.cjs",
        'const dep = require ("./dep.js"); this.offset = 3; const read = () => dep.value + this.offset; module.exports = { value: dep.value + 1, read };',
      );
      await fixture.write(
        "src/index.ts",
        [
          'import { value, text } from "inert-esm";',
          'import * as esm from "inert-esm";',
          'import { value as cjsValue } from "real-cjs";',
          'import * as cjs from "real-cjs";',
          'globalThis["__packageProbe"] = [value, esm.value, text, cjsValue, cjs.value, cjs.read()];',
        ].join("\n"),
      );
      const result = await build({
        cache: { mode: "off" },
        chunks: { baseChunkName: "package-probe", mode, outputType: "esm" },
        entries: [{ file: "./index.ts", name: "package-probe.js" }],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      const outputPath = result.outputFiles.find(
        (file) => path.basename(file) === "package-probe.js",
      );
      expect(outputPath).toBeTruthy();
      await fixture.write(
        "run.mjs",
        `await import(${JSON.stringify(pathToFileURL(outputPath).href)}); console.log(JSON.stringify(globalThis["__packageProbe"]));`,
      );
      const child = Bun.spawnSync({ cmd: ["node", path.join(fixture.projectRoot, "run.mjs")] });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1))).toEqual([
        42, 42, "module.exports exports.x exports[x] require(", 7, 7, 9,
      ]);
    },
  );
}

for (const inputs of [["a-b.ts", "a_b.ts"], ["same.ts", "same.js"]]) {
  test.serial(
    `rejects colliding module inputs ${inputs.join(" and ")} before publishing`,
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixture();
      const sources = ["export const value = 1;", "export const value = 2;"];
      for (let index = 0; index < inputs.length; index++) {
        await fixture.write(`src/${inputs[index]}`, sources[index]);
      }
      await fixture.write("src/index.ts", inputs.map((input) => `import "./${input}";`).join("\n"));
      await fixture.write("dist/index.js", "previous successful output");
      const result = await build({
        cache: { mode: "off" },
        entries: ["./index.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expect(result.ok).toBe(false);
      const diagnostic = (result.diagnostics ?? []).map(({ message }) => message).join("\n");
      for (const input of inputs) expect(diagnostic).toContain(input);
      expect(await fixture.read("dist/index.js")).toBe("previous successful output");
      for (let index = 0; index < inputs.length; index++) {
        expect(await fixture.read(`src/${inputs[index]}`)).toBe(sources[index]);
      }
    },
  );
}

test.serial(
  "applies a browser object mapping to the package root",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'export { value } from "demo-browser-map";\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/package.json",
      JSON.stringify({
        browser: { "./node.js": "./browser.js" },
        main: "./fallback.js",
        module: "./node.js",
        name: "demo-browser-map",
        type: "module",
      }),
    );
    await fixture.write(
      "node_modules/demo-browser-map/node.js",
      'import fs from "node:fs"; export const value = fs ? "node" : "none";\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/fallback.js",
      'export const value = "fallback";\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/browser.js",
      'export const value = "browser";\n',
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await import(
      `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?browser-root`
    );
    expect(output.value).toBe("browser");
  },
);

test.serial(
  "applies browser object mappings to relative package imports",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'export { value } from "demo-browser-map";\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/package.json",
      JSON.stringify({
        browser: { "./feature.js": "./feature-browser.js" },
        main: "./index.js",
        name: "demo-browser-map",
        type: "module",
      }),
    );
    await fixture.write(
      "node_modules/demo-browser-map/index.js",
      'import { feature } from "./feature.js"; export const value = `browser-${feature}`;\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/feature.js",
      'import fs from "node:fs"; export const feature = fs ? "node" : "none";\n',
    );
    await fixture.write(
      "node_modules/demo-browser-map/feature-browser.js",
      'export const feature = "feature";\n',
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await import(
      `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?browser-relative`
    );
    expect(output.value).toBe("browser-feature");
  },
);

test.serial("resolves the nearest hoisted workspace dependency", async () => {
  const fixture = await createFixture();
  const appRoot = path.join(fixture.projectRoot, "packages", "app");
  const appSrcDir = path.join(appRoot, "src");
  const appOutDir = path.join(appRoot, "dist");
  await fixture.write(
    "packages/app/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
      },
    }),
  );
  await fixture.write(
    "packages/app/src/index.ts",
    'export { value } from "hoisted-demo";\n',
  );
  await fixture.write(
    "packages/node_modules/hoisted-demo/package.json",
    '{"name":"hoisted-demo","type":"module","exports":"./index.js"}\n',
  );
  await fixture.write(
    "packages/node_modules/hoisted-demo/index.js",
    'export const value = "nearest-hoist";\n',
  );
  await fixture.write(
    "node_modules/hoisted-demo/package.json",
    '{"name":"hoisted-demo","type":"module","exports":"./index.js"}\n',
  );
  await fixture.write(
    "node_modules/hoisted-demo/index.js",
    'export const value = "far-hoist";\n',
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: appOutDir,
    projectRoot: appRoot,
    srcDir: appSrcDir,
  });

  expect(result.ok).toBe(true);
  const output = await import(
    `${pathToFileURL(path.join(appOutDir, "index.js")).href}?hoisted`
  );
  expect(output.value).toBe("nearest-hoist");
});
