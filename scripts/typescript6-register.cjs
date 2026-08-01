// TEMPORARY M0/M1 bridge for tools that still require the legacy `typescript` API.
// Delete this register hook with @typescript/typescript6 once typescript-eslint supports TS7.
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
      target = requireFromRoot.resolve(`@typescript/typescript6${suffix}`);
      redirected.set(request, target);
    }
    return target;
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};
