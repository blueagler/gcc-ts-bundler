export function usage() {
  console.error(`Usage: gcc-ts-bundler [options]

Example:
  gcc-ts-bundler --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist

Primary flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Output directory
  --language-out        ECMASCRIPT3 | ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT_NEXT
  --compilation-level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --cache-mode          off | temp | persistent
  --cache-dir           Explicit cache directory
  --preflight           off | errors-only | full
  --post-minify         false | swc
  --no-rewrite-exports  Disable SWC export rewriting
  --verbose             Print verbose diagnostics
  --fatal-warnings      Treat tsickle warnings as fatal
  -h, --help            Show this help message

Deprecated aliases still accepted for one transition release:
  --src_dir --entry_point --output_dir --language_out --compilation_level
  --fatal_warnings --preserve_cache
`);
}
