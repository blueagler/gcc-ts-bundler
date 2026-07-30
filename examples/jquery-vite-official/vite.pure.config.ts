import { defineConfig } from 'vite'

// Benchmark baseline: the same build without gccTsBundler().
// Usage: vite build --config vite.pure.config.ts
export default defineConfig({
  build: { target: 'esnext' },
})
