import { realpath } from "node:fs/promises";
import { expect, test } from "bun:test";

import { generateExterns } from "../../src/api/build.ts";
import { createNodeAmbientGlobalsRenderer } from "../../src/externs/ambient-globals.ts";
import { createTypeWorld } from "../../src/externs/context.ts";
import ts from "@typescript/typescript6";
import { createFixture } from "../helpers.mjs";

const projectRoot = new URL("../..", import.meta.url).pathname;

test.serial(
  "Node extern selection respects emitted lexical scopes and Closure exports",
  async () => {
    const fixture = await createFixture();
    await fixture.write("authored.ts", "export const api = { fetch };\n");
    await fixture.write(
      "shadowed.js",
      [
        'goog.module("shadowed");',
        "function fetch() { return 1; }",
        "function load(require, process) {",
        "  const { Buffer } = { Buffer: 2 };",
        "  return [fetch(), require('node:fs'), require('node:fs'), process, { Buffer }];",
        "}",
        "exports.value = load;",
      ].join("\n"),
    );
    await fixture.write(
      "actual.js",
      'goog.module("actual"); exports.api = { fetch, again: fetch };\n',
    );
    await fixture.write(
      "required.js",
      [
        'goog.module("required");',
        "exports.fs = require('node:fs');",
        "exports.again = require('node:fs');",
      ].join("\n"),
    );
    await fixture.write(
      "local.js",
      [
        'goog.module("local");',
        "const require = (name) => name;",
        "const fetch = () => 1;",
        "exports.api = [require('node:fs'), require('node:fs'), fetch(), { fetch }];",
      ].join("\n"),
    );
    const authoredFile = `${fixture.projectRoot}/authored.ts`;
    const shadowedFile = `${fixture.projectRoot}/shadowed.js`;
    const actualFile = `${fixture.projectRoot}/actual.js`;
    const requiredFile = `${fixture.projectRoot}/required.js`;
    const localFile = `${fixture.projectRoot}/local.js`;
    const typeWorld = createTypeWorld(
      [
        await realpath(`${projectRoot}/node_modules/@types/node/index.d.ts`),
        authoredFile,
      ],
      {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.Latest,
        types: [],
      },
    );
    const render = createNodeAmbientGlobalsRenderer({
      jsFiles: [
        authoredFile,
        shadowedFile,
        actualFile,
        requiredFile,
        localFile,
      ],
      packageRoot: projectRoot,
      projectRoot,
      typeWorld,
    });

    expect((await render([shadowedFile])).globalNames).toEqual([]);
    expect((await render([localFile])).globalNames).toEqual([]);
    expect((await render([requiredFile])).globalNames).toEqual(["require"]);
    // A local in another Closure module cannot hide this real shorthand read.
    expect((await render([shadowedFile, actualFile])).globalNames).toEqual([
      "fetch",
    ]);
    expect(
      (await render([shadowedFile, localFile, requiredFile, actualFile]))
        .globalNames,
    ).toEqual(["fetch", "require"]);
    expect(
      (await render([actualFile, requiredFile, localFile, shadowedFile]))
        .globalNames,
    ).toEqual(["fetch", "require"]);
    expect((await render([authoredFile])).globalNames).toEqual(["fetch"]);
  },
);

test.serial(
  "target declaration roots render typed boundary surfaces",
  async () => {
    const surfaces = [
      ["node", "node:fs", "readFile"],
      ["node", "node:path", "join"],
      ["bun", "bun", undefined],
      ["workerd", "workerd", "FetchEvent"],
    ];

    for (const [target, specifier, expectedExport] of surfaces) {
      const result = await generateExterns({
        modules: [{ runtime: "external", specifier }],
        projectRoot,
        target,
      });
      const typed = result.typedDeclarations;

      const exports = [
        ...typed.moduleExports.flatMap((module) => module.exports),
        ...typed.globalSurfaces.flatMap((surface) => surface.exports),
      ];
      if (expectedExport) {
        expect(exports.map((item) => item.exportName)).toContain(
          expectedExport,
        );
      }
      if (target === "bun" || target === "workerd") {
        expect(typed.globalSurfaces).toEqual([
          expect.objectContaining({
            collisionPolicy: "owner-qualified",
            name: target,
          }),
        ]);
      }
    }
  },
);
