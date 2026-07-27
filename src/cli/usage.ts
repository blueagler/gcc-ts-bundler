export function usage() {
  console.error(`Usage: gcc-ts-bundler <command> [options]

Example:
  gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
  gcc-ts-bundler clean-cache --project-root=.
  gcc-ts-bundler externs --project-root=. --src-dir=. --entry=./main.ts --module=lit --module=@lit-labs/router --output-file=./closure-externs/lit.generated.js
  gcc-ts-bundler externs --project-root=. --src-dir=./src --entry=./main.ts --runtime-entry=./.prebundle/main.js --mode=runtime-aware --module=svelte --output-file=./closure-externs/runtime.generated.js

Commands:
  build               Build the requested entries
  clean-cache         Remove the persistent cache for a project root
  externs             Generate Closure externs from dependency types and runtime code

Build flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Output directory
  --language-out        ECMASCRIPT3 | ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT_NEXT
  --compilation-level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --chunks              off | bundler-runtime
  --chunk-public-path   Public URL prefix for chunk files in chunk mode
  --chunk-base-name     Base chunk output name in chunk mode
  --chunk-manifest      Relative manifest path in chunk mode
  --packages            off | esm-only
  --platform-externs    minimal | full (default minimal: generated flat platform externs)
  --extern              Closure extern file. May be provided multiple times
  --js                  Additional Closure JS input. May be provided multiple times
  --cache-mode          off | temp | persistent
  --cache-dir           Explicit cache directory
  --preflight           off | errors-only | full
  --verbose             Print verbose diagnostics
  --fatal-warnings      Treat typed transpile warnings as fatal
  -h, --help            Show this help message

Extern flags:
  --project-root          Project root used to resolve node_modules and tsconfig.json
  --src-dir               Source directory used to resolve extern analysis app entries
  --entry                 App entry file for boundary-aware usage analysis. May be provided multiple times
  --module                Package or subpath specifier to scan. May be provided multiple times
  --runtime-entry         Runtime JS entry for runtime-aware analysis. May be provided multiple times
  --mode                  boundary-aware | candidates | runtime-aware
  --output-file           Write generated externs to a file instead of stdout
  --include-dependencies  Follow imported declaration files across node_modules (default: true)
  --tsconfig              Explicit tsconfig path relative to --project-root

Modes:
  boundary-aware          App usage + dependency types
  candidates              Dependency types only
  runtime-aware           Dependency runtime code + dependency types, with optional app usage filtering from --entry
`);
}
