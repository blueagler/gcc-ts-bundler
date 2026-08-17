import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { gccTsBundler } from 'gcc-ts-bundler/vite'
import { sveltePreset } from 'gcc-ts-bundler/presets/svelte'

// https://vite.dev/config/
export default defineConfig({
  preview: { host: true, allowedHosts: true },
  build: { target: 'esnext' },
  plugins: [svelte(), gccTsBundler(sveltePreset({ compiler: { hideWarningsFor: [] } }))],
})
