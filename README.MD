# GCC-TS-Bundler
GCC-TS-Bundler is a unique tool that bundles TypeScript code using Google Closure Compiler and Tsickle. It stands out by leveraging Closure Compiler's advanced optimizations and dead code elimination, which are further enhanced by relying on TypeScript types. This tool is particularly notable for its ability to rename property names in objects and radically change the structure of your code, leading to significant performance improvements.

Unlike other compilers, GCC-TS-Bundler integrates deeply with Closure Compiler to provide advanced optimizations that are not possible with standard TypeScript compilers. It uses Tsickle to convert TypeScript to Closure-compatible JavaScript, allowing for more aggressive optimizations. This results in smaller, faster, and more efficient code, making it an excellent choice for performance-critical applications.

## Features

- Bundles TypeScript code using Google Closure Compiler and Tsickle.
- Utilizes Closure Compiler's advanced optimizations and dead code elimination.
- Enhances optimizations by relying on TypeScript types.
- Generates externs for Closure Compiler.
- Renames property names in objects for better performance.
- Radically restructures code for optimal performance.

## Install From NPM using bun

```sh
bun install gcc-ts-bundler
```

### GCC-TS-Bundler Flags

- `--src_dir`: The source directory.
- `--entry_point`: The entry point for the application. (if it is a relative path, it will be resolved from the `--src_dir` directory)
- `--output_dir`: The output file for the generated JS.
- `--language_out`: ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT.
- `--compilation_level`: WHITESPACE_ONLY | SIMPLE | ADVANCED.
- `--preserve_cache`: Whether to preserve the cache files for debugging
- `--fatalWarnings`: Whether warnings should be fatal, causing tsickle to return a non-zero exit code.
- `--verbose`: Print diagnostics to the console.
- `-h, --help`: Show this help message.

### Example

```sh
gcc-ts-bundler --src-dir='./src' --entry_point='./index.ts' --js_output_file='./dist/index.js'
```

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.