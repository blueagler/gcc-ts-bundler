import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture } from "./helpers.mjs";

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
