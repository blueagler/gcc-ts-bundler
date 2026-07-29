import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { REACT_ELEMENT_PROPS_CALLS } from "../src/presets/react.ts";
import { VUE_VNODE_PROPS_CALLS } from "../src/presets/vue.ts";
import { createFixture } from "./helpers.mjs";

let importCounter = 0;

async function buildFixture(source, options = {}) {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", source);
  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    platformExterns: "minimal",
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    ...options,
  });
  expect(
    result.ok,
    (result.diagnostics ?? []).map(({ message }) => message).join("\n"),
  ).toBe(true);
  const outputPath = path.join(fixture.outDir, "index.js");
  const output = await fixture.read("dist/index.js");
  await import(`${pathToFileURL(outputPath).href}?property-test=${importCounter++}`);
  return { fixture, output, result };
}

test.serial(
  "minimal platform externs and reflective reads preserve runtime property names",
  { timeout: 30_000 },
  async () => {
    try {
      await buildFixture(
        [
          "const host = { attachShadow(options) { return options; } };",
          'globalThis["shadowOptions"] = host.attachShadow({ mode: "open" });',
          "class Base { inherited() { return 41; } }",
          "class Sub extends Base { call() { return super[\"inherited\"]() + 1; } }",
          "class Value { templated = 42; }",
          'globalThis["computedSuperResult"] = new Sub().call();',
          'globalThis["templateReadResult"] = new Value()[`templ\\u0061ted`];',
          "",
        ].join("\n"),
      );

      expect(globalThis.shadowOptions["mode"]).toBe("open");
      expect(globalThis.computedSuperResult).toBe(42);
      expect(globalThis.templateReadResult).toBe(42);
    } finally {
      delete globalThis.shadowOptions;
      delete globalThis.computedSuperResult;
      delete globalThis.templateReadResult;
    }
  },
);

test.serial(
  "React cloneElement preserves proven host props without freezing component props",
  { timeout: 30_000 },
  async () => {
    try {
      const { output } = await buildFixture(
        [
          "const createElement = (_type, props) => props;",
          "const cloneElement = (_element, props) => props;",
          "const Panel = () => null;",
          'const base = createElement(("button"), null);',
          'globalThis["reactClone"] = cloneElement(base, { onClick: () => 42 });',
          'globalThis["reactComponentProps"] = createElement(Panel, { componentOnlyLongName: 7 });',
          "",
        ].join("\n"),
        { compat: { classMapCalls: [...REACT_ELEMENT_PROPS_CALLS] } },
      );

      expect(globalThis.reactClone["onClick"]()).toBe(42);
      expect(output).not.toContain("componentOnlyLongName");
    } finally {
      delete globalThis.reactClone;
      delete globalThis.reactComponentProps;
    }
  },
);

test.serial(
  "Vue compiled record contracts and hoisted DOM props stay literal",
  { timeout: 30_000 },
  async () => {
    try {
      const { output } = await buildFixture(
        [
          "const defineComponent = options => options;",
          "const createVNode = (_component, props) => props;",
          "const createElementVNode = (_tag, props) => props;",
          "const Child = defineComponent({",
          "  props: { msg: {} },",
          "  setup(componentProps) { return componentProps.msg; },",
          "});",
          'const hoisted = { class: "card" };',
          'globalThis["vueReadMsg"] = props => Child.setup(props);',
          'globalThis["vueAttrs"] = createElementVNode("div", hoisted);',
          'globalThis["vueComponentProps"] = createVNode(Child, { msg: "hello", componentOnlyLongName: 1 });',
          "",
        ].join("\n"),
        { compat: { classMapCalls: [...VUE_VNODE_PROPS_CALLS] } },
      );

      expect(globalThis.vueReadMsg({ msg: "hello" })).toBe("hello");
      expect(globalThis.vueAttrs["class"]).toBe("card");
      expect(globalThis.vueComponentProps["msg"]).toBe("hello");
      expect(output).not.toContain("componentOnlyLongName");
    } finally {
      delete globalThis.vueReadMsg;
      delete globalThis.vueAttrs;
      delete globalThis.vueComponentProps;
    }
  },
);

test.serial(
  "registered custom elements keep inherited and decorated public properties",
  { timeout: 30_000 },
  async () => {
    try {
      const { output } = await buildFixture(
        [
          "const registry = new Map<string, new () => Motion>();",
          "const elementRegistry = { define(name: string, ctor: new () => Motion) { registry.set(name, ctor); } };",
          "function registered(name: string) {",
          "  return (value: new () => Motion) => { elementRegistry.define(name, value); };",
          "}",
          "function reactive(_value: unknown, _context: ClassAccessorDecoratorContext) {}",
          "class ReactiveBase {",
          "  renderRoot = { ready: true };",
          "  hasUpdated = false;",
          "  requestUpdate() { this.hasUpdated = true; }",
          "  get updateComplete() { return Promise.resolve(this.hasUpdated); }",
          "}",
          "@registered(\"x-motion\")",
          "class Motion extends ReactiveBase {",
          "  @reactive accessor letters = [\"L\", \"I\", \"T\"];",
          "  private veryLongInternalDetail = 1;",
          "  internalValue() { return this.veryLongInternalDetail; }",
          "}",
          '(globalThis as any)["makeMotion"] = () => new (registry.get("x-motion")!)();',
          "",
        ].join("\n"),
      );

      const motion = globalThis.makeMotion();
      expect("letters" in motion).toBe(true);
      expect("updateComplete" in motion).toBe(true);
      expect("requestUpdate" in motion).toBe(true);
      expect("hasUpdated" in motion).toBe(true);
      expect("renderRoot" in motion).toBe(true);
      motion.letters = ["X"];
      motion.requestUpdate();
      expect(await motion.updateComplete).toBe(true);
      expect(motion.letters).toEqual(["X"]);
      expect(motion.renderRoot.ready).toBe(true);
      expect(output).not.toContain("veryLongInternalDetail");
    } finally {
      delete globalThis.makeMotion;
    }
  },
);

test.serial(
  "unsupported compat regex syntax returns an actionable build diagnostic",
  { timeout: 10_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      'globalThis["regexResult"] = jsx("button", { onClick: () => 1 });\n',
    );
    const result = await build({
      cache: { mode: "off" },
      compat: {
        classMapCalls: [
          {
            argIndex: 1,
            callee: "jsx",
            keyExcludePattern: "^(?!children$).+$",
            stringLiteralArgIndex: 0,
          },
        ],
      },
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(false);
    const diagnostics = result.diagnostics.map(({ message }) => message).join("\n");
    expect(diagnostics).toContain("compat.classMapCalls");
    expect(diagnostics).toContain("jsx");
    expect(diagnostics).toContain("keyExcludePattern");
    expect(diagnostics).toContain("unsupported regex syntax");
  },
);

// A property name that appears in element-access position ANYWHERE in the
// Closure job stays consistent: Closure's own quoted/dotted rule keeps the
// dot-defined key unrenamed, so a string read of it still resolves. This holds
// both when the quoted read is in the defining module and when it is in another
// one. Locking it here because the alternative — quoting one side only — is the
// failure shape that killed `$.Deferred` in the jQuery ablation.
test.serial(
  "string element access keeps dot-defined object literal keys resolvable",
  { timeout: 30_000 },
  async () => {
    const { output } = await buildFixture(
      [
        "const settings: Record<string, number> = { retries: 3, unrelated: 1 };",
        "function readDynamic(key: string): number {",
        "  const value = settings[key];",
        "  return value === undefined ? -1 : value;",
        "}",
        "// Quoted read of the same key, in the same module.",
        "function readQuoted(): number {",
        "  const value = settings[\"retries\"];",
        "  return value === undefined ? -1 : value;",
        "}",
        "(globalThis as unknown as Record<string, unknown>)[\"__settingsProbe\"] = (seed: string) => [",
        "  readQuoted(),",
        "  readDynamic(seed.length > 99 ? \"nope\" : \"retries\"),",
        "];",
      ].join("\n"),
    );

    const probe = globalThis["__settingsProbe"];
    expect(typeof probe).toBe("function");
    // Both the quoted read and the dynamic read resolve to the real value.
    expect(probe("seed")).toEqual([3, 3]);
    // `retries` is pinned by the quoted access; `unrelated` is free to rename.
    expect(output).toContain("retries");
    delete globalThis["__settingsProbe"];
  },
);
