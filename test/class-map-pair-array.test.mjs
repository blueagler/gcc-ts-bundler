import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { build } from "../dist/index.mjs";
import { VUE_SFC_EXPORT_HELPER_CALLS } from "../dist/presets/vue.mjs";
import { createFixture } from "./helpers.mjs";

/**
 * The ABI a template-only SFC crosses, reduced to its shape.
 *
 * plugin-vue attaches `render`/`__scopeId` to a component through its export
 * helper as `_export_sfc(component, [["render", fn], ["__scopeId", id]])`,
 * whose body is `target[key] = value`. The Vue runtime then reads
 * `component.render` as a dot property. Under ADVANCED the dot side renames
 * and the string side cannot, so the component silently loses its render and
 * mounts empty — the failure that dropped every vapor slot child in
 * examples/vue-vapor-vite-official (890 rendered characters instead of 8912).
 * `<script setup>` SFCs never hit it because their render is inlined into
 * setup, so no vdom example ever caught it.
 */
const EXPORT_HELPER_FIXTURE = {
  "src/main.ts": `
    import { mount } from "./runtime.ts";
    import Component from "./component.ts";

    // Quoted so ADVANCED cannot rename the probe itself.
    globalThis["__rendered"] = mount(Component);
  `,
  // Stands in for the plugin-vue:export-helper virtual module: the rule must
  // match this by import identity, never by the local alias spelling.
  "src/plugin-vue-export-helper.js": `
    export default function exportSfc(target, entries) {
      for (const [key, value] of entries) {
        target[key] = value;
      }
      return target;
    }
  `,
  "src/component.ts": `
    import _export_sfc from "./plugin-vue-export-helper.js";

    const _sfc_main = { name: "template-only" };
    function _sfc_render() {
      return "<p>slot content</p>";
    }

    export default _export_sfc(_sfc_main, [
      ["render", _sfc_render],
      ["__scopeId", "data-v-abc123"],
    ]);
  `,
  "src/runtime.ts": `
    export function mount(component: { render?: () => string }) {
      return component.render ? component.render() : "";
    }
  `,
};

async function buildFixture(overrides = {}) {
  const fixture = await createFixture();
  for (const [relativePath, contents] of Object.entries(EXPORT_HELPER_FIXTURE)) {
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
  const code = await fs.readFile(path.join(fixture.outDir, "main.js"), "utf8");
  return code;
}

function evaluateRendered(code) {
  const previousRendered = globalThis.__rendered;
  delete globalThis.__rendered;
  try {
    (0, eval)(code);
    return globalThis.__rendered;
  } finally {
    if (previousRendered === undefined) delete globalThis.__rendered;
    else globalThis.__rendered = previousRendered;
  }
}

test(
  "pair-array class-map keys survive ADVANCED so a string-attached render still runs",
  { timeout: 300_000 },
  async () => {
    const code = await buildFixture({
      compat: { classMapCalls: [...VUE_SFC_EXPORT_HELPER_CALLS] },
    });

    expect(evaluateRendered(code)).toBe("<p>slot content</p>");
  },
);

// Negative control: without the rule the same fixture must actually lose the
// render, otherwise the test above proves nothing about the mechanism.
test(
  "without the pair-array rule the same shape loses its string-attached member",
  { timeout: 300_000 },
  async () => {
    const code = await buildFixture();

    expect(evaluateRendered(code)).toBe("");
  },
);
