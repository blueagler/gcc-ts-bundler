# React SPA Example

This example is a real consumer fixture for `gcc-ts-bundler`. It has its own `package.json`, `tsconfig.json`, and local `node_modules`.

Current status:

- The example app source is valid and the bundler can resolve its package graph.
- `npm run build` currently fails on `react` because the published package entrypoint is CommonJS.
- That is expected in the current `packages.mode = "esm-only"` implementation, which only accepts browser-safe ESM dependencies.
