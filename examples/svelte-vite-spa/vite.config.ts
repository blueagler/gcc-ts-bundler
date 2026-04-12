import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { tokenShaker } from "vite-plugin-token-shaker";

import { gccTsBundler } from "gcc-ts-bundler/vite";

export default defineConfig({
  build: {
    target: "es2018",
  },
  plugins: [
    svelte(),
    functionsMixins({ deps: ["m3-svelte"] }),
    tokenShaker(),
    gccTsBundler({
      compiler: {
        cache: { mode: "off" },
        diagnostics: { preflight: "full" },
        languageOut: "ECMASCRIPT5",
      },
      externs: {
        generate: {
          mode: "runtime-aware",
          modules: ["m3-svelte", "svelte"],
        },
      },
      runtime: {
        loader: "script",
      },
    }),
  ],
});
