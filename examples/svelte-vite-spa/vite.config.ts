import { defineConfig } from "vite";
import checker from "vite-plugin-checker";
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
    checker({
      overlay: false,
      typescript: {
        tsconfigPath: "./tsconfig.vite-checker.json",
      },
    }),
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
