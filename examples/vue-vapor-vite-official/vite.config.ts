import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { gccTsBundler } from 'gcc-ts-bundler/vite'
import { vuePreset } from 'gcc-ts-bundler/presets/vue'

// https://vite.dev/config/
export default defineConfig({
  build: { target: 'esnext' },
  plugins: [vue(), vueDevTools(), gccTsBundler(vuePreset())],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
