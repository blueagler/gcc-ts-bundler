import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { tokenShaker } from "vite-plugin-token-shaker";

import { gccTsBundler } from "gcc-ts-bundler/vite";
import { sveltePreset } from "gcc-ts-bundler/presets/svelte";

// The standard Svelte + Vite setup, plus gccTsBundler(). The preset carries
// all Svelte-specific compiler knowledge.
export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [
    svelte(),
    functionsMixins({ deps: ["m3-svelte"] }),
    tokenShaker(),
    gccTsBundler(sveltePreset({ externModules: ["m3-svelte"] })),
  ],
});
