import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { gccTsBundler } from 'gcc-ts-bundler/vite'
import { reactPreset } from 'gcc-ts-bundler/presets/react'

// https://vite.dev/config/
export default defineConfig({
  build: { target: 'esnext' },
  plugins: [react(), gccTsBundler(reactPreset())],
})
