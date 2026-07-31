import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Benchmark baseline: the same build without gccTsBundler().
// Usage: vite build --config vite.pure.config.ts
export default defineConfig({
  build: { target: 'esnext', outDir: 'dist-pure' },
  plugins: [react()],
})
