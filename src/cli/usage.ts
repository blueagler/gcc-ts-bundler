import {
  CACHE_MODES,
  CHUNK_MODES,
  CHUNK_OUTPUT_TYPES,
  COMPILATION_LEVELS,
  DIAGNOSTICS_PREFLIGHT_MODES,
  LANGUAGE_OUTPUTS,
  PACKAGE_MODES,
  PLATFORM_EXTERNS_MODES,
  TARGET_NAMES,
} from "../api/types";
import { EXTERN_MODES } from "../externs";

export function usage() {
  console.error(`Usage: gcc-ts-bundler [build] [options]
       gcc-ts-bundler clean-cache [options]
       gcc-ts-bundler externs [options]

Example:
  gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
  gcc-ts-bundler clean-cache --project-root=.
  gcc-ts-bundler externs --project-root=. --src-dir=. --entry=./main.ts --module=lit --module=@lit-labs/router --output-file=./closure-externs/lit.generated.js
  gcc-ts-bundler externs --project-root=. --src-dir=. --runtime-entry=./.prebundle/main.js --mode=runtime-aware --module=svelte --output-file=./closure-externs/runtime.generated.js

Commands:
  build               Build the requested entries
  clean-cache         Remove the persistent cache for a project root
  externs             Generate Closure externs from dependency types and runtime code

Build flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Bundler-owned output directory; builds and cache restores can replace it
  --language-out        ${LANGUAGE_OUTPUTS.join(" | ")}
  --compilation-level   ${COMPILATION_LEVELS.join(" | ")}
  --chunks              ${CHUNK_MODES.join(" | ")}
  --chunk-output-type   ${CHUNK_OUTPUT_TYPES.join(" | ")}
  --chunk-public-path   Public URL prefix for chunk files in chunk mode
  --chunk-base-name     Base chunk output name in chunk mode
  --chunk-manifest      Relative manifest path in chunk mode
  --packages            ${PACKAGE_MODES.join(" | ")}
  --target              ${TARGET_NAMES.join(" | ")}
  --external            Runtime-owned ESM module specifier. Repeatable
  --preserve-module     Authored module kept unoptimized and unrenamed. Repeatable
  --platform-externs    ${PLATFORM_EXTERNS_MODES.join(" | ")} (default minimal: typed per-job platform slice)
  --extern              Explicit extern file consumed by Closure and native preservation. Repeatable
  --typed-extern        Closure-only typed extern declaration file. Repeatable
  --js                  Additional Closure JS input. May be provided multiple times
  --cache-mode          ${CACHE_MODES.join(" | ")}
  --cache-dir           Explicit cache directory
  --preflight           ${DIAGNOSTICS_PREFLIGHT_MODES.join(" | ")}
  --verbose             Print verbose diagnostics
  -h, --help            Show this help message

Clean-cache flags:
  --project-root        Project root whose persistent cache should be removed
  --cache-dir           Explicit cache directory, resolved relative to --project-root
  -h, --help            Show this help message without deleting any cache

Extern flags:
  -p, --project-root      Project root used to resolve node_modules and tsconfig.json
  --src-dir               Base directory for application and runtime entry paths
  -e, --entry             App entry file for boundary-aware usage analysis. May be provided multiple times
  --module                Package or subpath specifier to scan. May be provided multiple times
  --runtime-entry         Runtime JS entry for runtime-aware analysis. May be provided multiple times
  --mode                  ${EXTERN_MODES.join(" | ")}
  -o, --output-file       Write generated externs to a file instead of stdout
  --include-dependencies  Follow imported declaration files across node_modules (default: false)
  --target                ${TARGET_NAMES.join(" | ")}
  --tsconfig              Explicit tsconfig path relative to --project-root
  -h, --help              Show this help message

Modes:
  boundary-aware          App usage + dependency types
  runtime-aware           Dependency runtime code + dependency types, with optional app usage filtering from --entry
`);
}
