import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { build } from "../dist/index.mjs";
import { REACT_ELEMENT_PROPS_CALLS } from "../dist/presets/react.mjs";
import { createFixture } from "./helpers.mjs";

/**
 * The React-only prop ABI, reduced to its shape.
 *
 * The React preset quotes host-element prop keys at the creation site, so
 * `precedence` survives ADVANCED as a literal key. react-dom reads the same
 * prop with dot access (`props.precedence` in `isHostHoistableType`). Without
 * a matching extern pin the read side renames to `props.Oe`, the stylesheet
 * <link> loses hoistable status, and hydration fails with React #418.
 * `className` is the control: it is a real DOM property, so the generated
 * externs already pin it and it needs nothing new.
 */
const REACT_PROP_FIXTURE = {
  "src/main.ts": `
    import { jsx } from "./runtime.ts";
    import { readPrecedence, readClassName } from "./react-dom.ts";

    const element = jsx("link", { precedence: "default", className: "sheet" });
    // Quoted so ADVANCED cannot rename the probes themselves.
    globalThis["__precedence"] = readPrecedence(element.props);
    globalThis["__className"] = readClassName(element.props);
  `,
  "src/runtime.ts": `
    export function jsx(type: string, props: Record<string, unknown>) {
      return { type, props };
    }
  `,
  // Stands in for compiled react-dom: reads the same props with dot access.
  "src/react-dom.ts": `
    export function readPrecedence(props: { precedence?: string }) {
      return props.precedence ?? "";
    }
    export function readClassName(props: { className?: string }) {
      return props.className ?? "";
    }
  `,
};

async function buildFixture(overrides = {}) {
  const fixture = await createFixture();
  for (const [relativePath, contents] of Object.entries(REACT_PROP_FIXTURE)) {
    await fixture.write(relativePath, contents);
  }
  const result = await build({
    cache: { mode: "off" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(
      `fixture build failed: ${result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n")}`,
    );
  }
  return await fs.readFile(path.join(fixture.outDir, "main.js"), "utf8");
}

function evaluateProbes(code) {
  delete globalThis.__precedence;
  delete globalThis.__className;
  (0, eval)(code);
  return {
    className: globalThis.__className,
    precedence: globalThis.__precedence,
  };
}

test(
  "a React-only prop quoted at the creation site keeps its dot-access read side",
  { timeout: 300_000 },
  async () => {
    const code = await buildFixture({
      compat: { classMapCalls: [...REACT_ELEMENT_PROPS_CALLS] },
    });

    expect(evaluateProbes(code)).toEqual({
      className: "sheet",
      precedence: "default",
    });
  },
);

// Control: a real DOM property renames on neither side even without the rule,
// so the test above is about React-only names, not about props in general.
test(
  "a DOM-attribute prop round-trips without any class-map rule",
  { timeout: 300_000 },
  async () => {
    const code = await buildFixture();

    expect(evaluateProbes(code).className).toBe("sheet");
  },
);
