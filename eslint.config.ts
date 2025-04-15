import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import perfectionistPlugin from "eslint-plugin-perfectionist";

export default tseslint.config([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      perfectionist: perfectionistPlugin,
    },
    rules: {
      "perfectionist/sort-array-includes": [
        "error",
        { order: "asc", type: "natural" },
      ],
      "perfectionist/sort-classes": [
        "error",
        {
          groups: [
            "index-signature",
            "static-property",
            "private-property",
            "property",
            "constructor",
            "static-method",
            "private-method",
            "method",
          ],
          order: "asc",
          type: "natural",
        },
      ],
      "no-console": "off",
    },
  },
  {
    ignores: [
      ".DS_Store",
      "*.json",
      ".history",
      "dist",
      "node_modules",
      "temp",
      "tsc-out",
      "build",
      ".vscode",
      "*.js",
      "closure-*",
      "src/tsickle/*.ts",
    ],
  },
]);
