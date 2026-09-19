# CLI reference

The package installs the `gcc-ts-bundler` executable. Use `build`, `externs`,
or `clean-cache`; `--help` (or `-h`) prints command help. Flags accept
`--name=value` or `--name value`. Unknown flags and positional arguments are
rejected; underscore and camelCase spellings are not aliases.

**Use a dedicated output directory.** Builds and final-cache restores can
replace all of `--out-dir`, including unrelated files. See
[output ownership](api.md#paths).

Core defaults and restrictions live in the [API reference](api.md). The CLI
exposes a subset of that API; use the programmatic interface for options such
as compatibility rules, vendor partitioning, or typed external-runtime
module descriptors.

## Build

Given `src/index.ts` and a project `tsconfig.json`:

```sh
gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
```

`build` may be omitted when invoking build flags directly. A successful build
returns exit status 0; reported build diagnostics go to stderr and return
status 1. Argument parsing, configuration, build, extern-generation, and
cache-clean failures all pass through the CLI's failure boundary: errors are
reported to stderr with status 1 rather than escaping as unhandled promise
rejections. Invalid arguments or configuration fail rather than being ignored.

| Flag                  | Values or meaning                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project-root`      | Root for tsconfig discovery, dependencies, and project-relative paths.                                                                                                                                            |
| `--src-dir`           | Source directory; relative entries resolve from here.                                                                                                                                                             |
| `--entry`             | Entry file. Repeat for multiple entries.                                                                                                                                                                          |
| `--out-dir`           | Published JavaScript output directory.                                                                                                                                                                            |
| `--language-out`      | `ECMASCRIPT3`, `ECMASCRIPT5`, `ECMASCRIPT6`, `ECMASCRIPT_2015`, `ECMASCRIPT_2016`, `ECMASCRIPT_2017`, `ECMASCRIPT_2018`, `ECMASCRIPT_2019`, `ECMASCRIPT_2020`, `ECMASCRIPT_2021`, `STABLE`, or `ECMASCRIPT_NEXT`. |
| `--compilation-level` | `WHITESPACE_ONLY`, `SIMPLE`, or `ADVANCED`.                                                                                                                                                                       |
| `--packages`          | `off` or `esm-only`.                                                                                                                                                                                              |
| `--target`            | `browser`, `node`, `bun`, `workerd`, or `webworker`.                                                                                                                                                              |
| `--external`          | Exact runtime-owned ESM specifier. Repeatable; requires off-mode ESM output.                                                                                                                                      |
| `--preserve-module`   | Project-relative authored module kept unoptimized and unrenamed. Repeatable; requires ESM output.                                                                                                                 |
| `--platform-externs`  | `minimal` or `full`; see [platform externs](api.md#platform-externs).                                                                                                                                             |
| `--extern`            | Explicit extern file consumed by Closure and scanned by native preservation. Repeatable.                                                                                                                          |
| `--typed-extern`      | Closure-only typed declaration file. Repeatable.                                                                                                                                                                  |
| `--js`                | Additional JavaScript input passed to Closure. Repeatable.                                                                                                                                                        |
| `--chunks`            | `off`, `split`, or `bundler-runtime`.                                                                                                                                                                             |
| `--chunk-output-type` | `auto`, `script`, or `esm`.                                                                                                                                                                                       |
| `--chunk-public-path` | Public URL prefix for chunk loading.                                                                                                                                                                              |
| `--chunk-base-name`   | Base chunk output name.                                                                                                                                                                                           |
| `--chunk-manifest`    | Safe relative manifest path inside the output directory.                                                                                                                                                          |
| `--cache-mode`        | `off`, `temp`, or `persistent`.                                                                                                                                                                                   |
| `--cache-dir`         | Explicit cache root directory.                                                                                                                                                                                    |
| `--preflight`         | `off`, `errors-only`, or `full`.                                                                                                                                                                                  |
| `--verbose`           | Enable verbose diagnostics.                                                                                                                                                                                       |
| `-h`, `--help`        | Print help without building.                                                                                                                                                                                      |

See [chunk options](api.md#chunk-options) for output-type gates, dynamic import
requirements, and the distinction between application and library entries.

## Externs

Generate rename barriers from dependency declarations and application usage:

```sh
gcc-ts-bundler externs --project-root=. --src-dir=./src --entry=./main.ts --module=lit --output-file=./closure-externs/lit.generated.js
```

For runtime-aware analysis, provide emitted JavaScript entries relative to the
selected source directory:

```sh
gcc-ts-bundler externs --project-root=. --src-dir=. --mode=runtime-aware --runtime-entry=./.prebundle/main.js --module=svelte --output-file=./closure-externs/runtime.generated.js
```

| Flag                     | Values or meaning                                                           |
| ------------------------ | --------------------------------------------------------------------------- |
| `-p`, `--project-root`   | Root for dependency and tsconfig resolution.                                |
| `--src-dir`              | Base for application/runtime entry paths; defaults to the project root.     |
| `-e`, `--entry`          | Application entry for usage analysis. Repeatable.                           |
| `--runtime-entry`        | Runtime JavaScript entry for runtime-aware analysis. Repeatable.            |
| `--module`               | Package or subpath specifier to scan. Repeatable; at least one is required. |
| `--mode`                 | `boundary-aware` (default) or `runtime-aware`.                              |
| `-o`, `--output-file`    | Project-relative rename-barrier output path; omitted means stdout.          |
| `--include-dependencies` | Follow imported declaration files across packages; off by default.          |
| `--target`               | `browser`, `node`, `bun`, `workerd`, or `webworker` analysis policy.        |
| `--tsconfig`             | Explicit project-relative tsconfig path.                                    |
| `-h`, `--help`           | Print help without generating externs.                                      |

Boundary-aware mode requires an application entry; runtime-aware mode requires
a runtime entry and can also use application entries to narrow usage. The CLI
uses compiled-runtime module specifiers. For typed external-runtime artifacts,
protocol helpers, and property policies, use the
[extern-generation API](api.md#generateexternsoptions).

## Clean cache

```sh
gcc-ts-bundler clean-cache --project-root=.
gcc-ts-bundler clean-cache --project-root=. --cache-dir=./custom-cache
```

This command accepts only `--project-root`, `--cache-dir`, and `--help` / `-h`.
The first two require string values and accept either `--name=value` or
`--name value`. Build/extern flags, positional arguments, unknown flags,
underscore/camelCase spellings, and missing values are rejected. There is no
`-p` or cache-mode shorthand for this command. Help does not delete the cache.

`--project-root` selects the project (default: current directory).
`--cache-dir` selects a non-default cache root, resolved from that project.
Only that project's hashed cache directory is removed, including saved
renaming maps; it does not clear other projects' caches.

Cleanup takes the same project lock as persistent builds. A detected stale
lock fails closed: check that no build or cache-clean operation is active,
then remove only the exact lock directory identified in the error and retry.
`clean-cache` never steals or bypasses that lock. See
[cache options](api.md#cache-options) for recovery details and platform default
locations.
