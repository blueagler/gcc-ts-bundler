import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import perfectionistPlugin from "eslint-plugin-perfectionist";

export default tseslint.config([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      perfectionist: perfectionistPlugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
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
      "src/tsickle",
    ],
  },
]);
