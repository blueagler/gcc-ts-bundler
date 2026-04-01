# React SPA Example

This example is a real consumer fixture for `gcc-ts-bundler`. It has its own `package.json`, `tsconfig.json`, and local `node_modules`.

Current status:

- The example app source builds successfully with React 19 and `react-dom` from npm.
- This now validates the browser-safe CommonJS package support path, including production `process.env.NODE_ENV` folding and React JSX runtime package resolution.
