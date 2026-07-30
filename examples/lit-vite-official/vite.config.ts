import { defineConfig } from 'vite'
import { gccTsBundler } from 'gcc-ts-bundler/vite'

// The official lit-ts template ships no vite.config; this adds only the
// gcc-ts-bundler plugin. Lit needs no preset.
export default defineConfig({
  build: { target: 'esnext' },
  plugins: [gccTsBundler()],
})
