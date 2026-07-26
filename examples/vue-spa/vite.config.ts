import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

import { gccTsBundler } from "gcc-ts-bundler/vite";
import { vuePreset } from "gcc-ts-bundler/presets/vue";

// The standard Vue + Vite setup, plus gccTsBundler().
export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [vue(), gccTsBundler(vuePreset())],
});
