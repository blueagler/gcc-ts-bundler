import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { tokenShaker } from "vite-plugin-token-shaker";

// Benchmark baseline: the same build without gccTsBundler().
// Usage: vite build --config vite.pure.config.ts
export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [svelte(), functionsMixins({ deps: ["m3-svelte"] }), tokenShaker()],
});
