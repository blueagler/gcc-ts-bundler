// Isolate dts-bundle-generator on TypeScript 5.9 because its legacy compiler
// API is incompatible with TypeScript 6.
const Module = require("node:module");
const { createRequire } = Module;

const requireFromRoot = createRequire(`${process.cwd()}/package.json`);
const redirected = new Map();
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "typescript" || request.startsWith("typescript/")) {
    let target = redirected.get(request);
    if (!target) {
      const suffix = request.slice("typescript".length);
      target = requireFromRoot.resolve(`typescript-dts${suffix}`);
      redirected.set(request, target);
    }
    return target;
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};
