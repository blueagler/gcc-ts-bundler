import type { GccTsBundlerVitePluginOptions } from "./types";

const invalidVitePluginOptions: GccTsBundlerVitePluginOptions = {
  compiler: {
    // @ts-expect-error Vite output compatibility must come from build.target.
    languageOut: "ECMASCRIPT5",
  },
  runtime: {
    // @ts-expect-error gccTsBundler() only supports script loading in Vite mode.
    loader: "fetch",
  },
};

void invalidVitePluginOptions;
