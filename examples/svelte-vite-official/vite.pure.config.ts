import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Benchmark baseline: the same build without gccTsBundler().
// Usage: vite build --config vite.pure.config.ts
export default defineConfig({
  build: { target: 'esnext' },
  plugins: [svelte()],
})
