import type { GccTsBundlerVitePluginOptions } from "./types";

const invalidVitePluginOptions: GccTsBundlerVitePluginOptions = {
  compiler: {
    // @ts-expect-error Vite output compatibility must come from build.target.
    languageOut: "ECMASCRIPT5",
  },
};

void invalidVitePluginOptions;
