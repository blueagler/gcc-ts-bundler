import { expect, test } from "bun:test";

import { isResolveMetadata } from "../src/pipeline/resolve-build/cache.ts";
import { isObjectOf, isNumber, isString } from "../src/internal/validation.ts";

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
  expect(isLabelled({ name: "a", note: "b" })).toBe(true);
  expect(isLabelled({ name: "a", note: 1 })).toBe(false);
});

function resolveMetadata(chunk) {
  return {
    chunkPlan: [{ dependencies: [], files: ["a.js"], name: "main", ...chunk }],
    entryFiles: [],
    lazyImports: [],
  };
}

test("cached chunk plans reject unknown chunk kinds", () => {
  expect(isResolveMetadata(resolveMetadata({ kind: "lazy" }))).toBe(true);
  expect(isResolveMetadata(resolveMetadata({}))).toBe(true);
  // Previously accepted: `kind` was validated as a bare string, so any value
  // was trusted and then read as the ChunkKind union.
  expect(isResolveMetadata(resolveMetadata({ kind: "bogus" }))).toBe(false);
});

test("cached resolve metadata rejects a malformed chunk plan", () => {
  expect(
    isResolveMetadata({ chunkPlan: [], entryFiles: [], lazyImports: [] }),
  ).toBe(true);
  expect(isResolveMetadata({ chunkPlan: [], entryFiles: [] })).toBe(false);
  expect(isResolveMetadata(resolveMetadata({ files: "a.js" }))).toBe(false);
});
