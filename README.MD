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

## Installation

To install the dependencies, run:

```sh
npm install
```

## Usage

To bundle your TypeScript code, use the following command:

```sh
gcc-ts-bundler --src-dir='./src' --entry_point='./index.ts' --js_output_file='./dist/index.js'
```

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.