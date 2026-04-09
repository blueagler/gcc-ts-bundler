import { createFixture } from "./base-fixture.mjs";

export async function createExternFixture() {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'import { Controller, RouterLike } from "contract-pkg";',
      "",
      "class Host {",
      "  updateComplete = Promise.resolve(true);",
      "  readonly controller = new Controller(this);",
      '  readonly router = new RouterLike(this, { attribute: "demo", reflect: true });',
      "  addController(_controller: unknown) {}",
      "  removeController(_controller: unknown) {}",
      "  requestUpdate() {}",
      "  click() {",
      "    if (this.controller.isAnimating) {",
      "      this.controller.togglePlay();",
      "    }",
      '    return this.router.link("/home");',
      "  }",
      "}",
      "",
      "new Host().click();",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/base-host/package.json",
    JSON.stringify(
      {
        name: "base-host",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/base-host/index.d.ts",
    [
      "export interface BaseHost {",
      "  addController(controller: unknown): void;",
      "  removeController(controller: unknown): void;",
      "  requestUpdate(): void;",
      "  readonly updateComplete: Promise<boolean>;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/contract-pkg/package.json",
    JSON.stringify(
      {
        exports: {
          ".": "./index.js",
          "./decorators.js": "./decorators.js",
        },
        name: "contract-pkg",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/contract-pkg/index.js",
    [
      "export class RouterLike {",
      "  constructor(host, options) {",
      "    this.host = host;",
      "    this.options = options;",
      "  }",
      "  link(pathname) {",
      '    return pathname ?? "/";',
      "  }",
      "  hostConnected() {}",
      "  hostDisconnected() {}",
      "}",
      "",
      "export class Controller {",
      "  constructor(host) {",
      "    this.host = host;",
      "    this.isAnimating = false;",
      "  }",
      "  togglePlay() {",
      "    this.isAnimating = !this.isAnimating;",
      "  }",
      "  hostConnected() {}",
      "  hostDisconnected() {}",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/contract-pkg/index.d.ts",
    [
      'import type { BaseHost } from "base-host";',
      "export interface ReactiveControllerLike {",
      "  hostConnected(): void;",
      "  hostDisconnected(): void;",
      "}",
      "export interface PropertyOptions {",
      "  attribute?: boolean | string;",
      "  reflect?: boolean;",
      "}",
      "export declare class RouterLike implements ReactiveControllerLike {",
      "  constructor(host: BaseHost, options?: PropertyOptions);",
      "  link(pathname?: string): string;",
      "}",
      "export declare class Controller {",
      "  constructor(host: BaseHost);",
      "  pause(): void;",
      "  play(): void;",
      "  togglePlay(): void;",
      "  get isAnimating(): boolean;",
      "  hostConnected(): void;",
      "  hostDisconnected(): void;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write("node_modules/contract-pkg/decorators.js", "export {};\n");
  await fixture.write(
    "node_modules/contract-pkg/decorators.d.ts",
    [
      "export declare function customElement(tagName: string): ClassDecorator;",
      "export interface PropertyOptions {",
      "  attribute?: boolean | string;",
      "  reflect?: boolean;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

export async function createRuntimeExternFixture() {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      'import { Counter } from "runtime-pkg";',
      "const counter = new Counter();",
      'export const first = counter.bump("demo");',
      'export const second = counter.bump("demo");',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/runtime-pkg/package.json",
    JSON.stringify(
      {
        name: "runtime-pkg",
        module: "./index.js",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/runtime-pkg/index.js",
    [
      "const __defProp = Object.defineProperty;",
      "const __defNormalProp = (obj, key, value) =>",
      "  key in obj",
      "    ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value })",
      "    : (obj[key] = value);",
      "const __publicField = (obj, key, value) =>",
      '  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);',
      "",
      "const node = { addEventListener() {} };",
      'node.addEventListener("click", () => {});',
      "(function invoke(fn) {",
      "  return fn.apply(null, []);",
      "})(() => 1);",
      "const list = [1, 2, 3];",
      "void list.length;",
      "",
      "export class Counter {",
      "  constructor() {",
      '    __publicField(this, "counts", new Map());',
      '    Object.defineProperty(this, "label", {',
      '      value: "demo",',
      "      enumerable: true,",
      "      configurable: true,",
      "      writable: true,",
      "    });",
      "  }",
      "  bump(key) {",
      "    const next = (this.counts.get(key) ?? 0) + 1;",
      "    this.counts.set(key, next);",
      '    return `${this.label}:${next}`;',
      "  }",
      "}",
      'Object.defineProperty(Counter.prototype, "reset", {',
      "  value: function () {",
      "    this.counts.clear();",
      "  },",
      "});",
      'Object.defineProperty(Counter, "from", {',
      "  value: function () {",
      "    return new Counter();",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/runtime-pkg/index.d.ts",
    [
      "export declare class Counter {",
      "  constructor();",
      "  bump(key: string): string;",
      "  reset(): void;",
      "  static from(): Counter;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}
