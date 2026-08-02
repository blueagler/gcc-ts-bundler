import { expect, test } from "bun:test";

import { generateExterns } from "../src/api/build.ts";

const projectRoot = new URL("..", import.meta.url).pathname;

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
      expect(typed.text).toStartWith("/** @externs */");
      expect(typed.degradations.reachableSymbolCount).toBeGreaterThan(0);
      expect(typed.degradations.degradedOccurrences).toBeGreaterThanOrEqual(0);

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
