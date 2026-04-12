import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { tokenShaker } from "vite-plugin-token-shaker";

import { gccTsBundler } from "gcc-ts-bundler/vite";

export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [
    svelte(),
    functionsMixins({ deps: ["m3-svelte"] }),
    tokenShaker(),
    gccTsBundler({
      externs: {
        generate: {
          mode: "runtime-aware",
          modules: ["m3-svelte", "svelte"],
        },
      },
    }),
  ],
});
