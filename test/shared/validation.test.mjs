import { expect, test } from "bun:test";

import {
  isBoolean,
  isFunction,
  isNumber,
  isObjectOf,
  isRecord,
  isString,
} from "../../src/shared/validation.ts";

const isPoint = isObjectOf({ x: isNumber, y: isNumber });

test("object schemas reject records missing a declared property", () => {
  expect(isPoint({ x: 1, y: 2 })).toBe(true);
  expect(isPoint({ x: 1 })).toBe(false);
});

test("object schemas reject wrongly typed properties and non-records", () => {
  expect(isPoint({ x: 1, y: "2" })).toBe(false);
  expect(isPoint(null)).toBe(false);
  expect(isPoint([])).toBe(false);
});

test("object schemas accept an explicitly undefined optional property", () => {
  const isLabelled = isObjectOf({
    name: isString,
    note: (value) => value === undefined || isString(value),
  });

  expect(isLabelled({ name: "a" })).toBe(true);
  expect(isLabelled({ name: "a", note: undefined })).toBe(true);
  expect(isLabelled({ name: "a", note: "b" })).toBe(true);
  expect(isLabelled({ name: "a", note: 1 })).toBe(false);
});

test("primitive guards reject boxed values, prototypes, and spoofed tags", () => {
  expect(isString("value")).toBe(true);
  expect(isNumber(1)).toBe(true);
  expect(isBoolean(false)).toBe(true);
  expect(isNumber(NaN)).toBe(false);
  expect(isNumber(Infinity)).toBe(false);
  expect(isNumber(-Infinity)).toBe(false);

  for (const [guard, primitive, prototype, tag] of [
    [isString, "value", String.prototype, "String"],
    [isNumber, 1, Number.prototype, "Number"],
    [isBoolean, false, Boolean.prototype, "Boolean"],
  ]) {
    expect(guard(Object(primitive))).toBe(false);
    expect(guard(Object.create(prototype))).toBe(false);
    expect(guard({ [Symbol.toStringTag]: tag })).toBe(false);
  }
});

test("function guards recognize callable values without inspecting tags", () => {
  const callables = [
    function ordinary() {},
    async function asynchronous() {},
    function* generator() {},
    async function* asyncGenerator() {},
    (() => {}).bind(null),
  ];
  for (const callable of callables) {
    Object.defineProperty(callable, Symbol.toStringTag, {
      get() {
        throw new Error("classification must not read this getter");
      },
    });
    expect(isFunction(callable)).toBe(true);
    expect(isRecord(callable)).toBe(false);
  }

  expect(isFunction(Object.create(Function.prototype))).toBe(false);
  expect(isFunction({ [Symbol.toStringTag]: "Function" })).toBe(false);
});

test("record guards preserve object admission without evaluating tag getters", () => {
  const value = {
    get [Symbol.toStringTag]() {
      throw new Error("classification must not read this getter");
    },
  };
  expect(isRecord(value)).toBe(true);
  expect(isFunction(value)).toBe(false);
  expect(isString(value)).toBe(false);
  expect(isNumber(value)).toBe(false);
  expect(isBoolean(value)).toBe(false);
  expect(isRecord(Object.create(null))).toBe(true);
  expect(isRecord(Object(1))).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
});
