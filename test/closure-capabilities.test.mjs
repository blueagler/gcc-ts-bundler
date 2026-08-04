import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { resolvePlatformExternCompilerJarPath } from "../src/build/closure/platform-externs/archive.ts";
import { closureCompilerCapabilities } from "../src/native/load.ts";
import { execFileAsync } from "./helpers.mjs";

const require = createRequire(import.meta.url);

const PARSE_FIXTURES = [
  {
    capability: "privateClassElements",
    fileName: "private-class-elements.mjs",
    source: "class Box { #field = 1; }\n",
  },
  {
    capability: "classStaticBlocks",
    fileName: "class-static-blocks.mjs",
    source: "class Box { static {} }\n",
  },
  {
    capability: "topLevelAwait",
    fileName: "top-level-await.mjs",
    source: "await Promise.resolve();\n",
  },
];

test.serial(
  "pinned Closure parser matches the declared Oxc envelope capabilities",
  async () => {
    const capabilities = closureCompilerCapabilities();
    const compilerPackage = require("google-closure-compiler/package.json");
    const compilerJarPath = resolvePlatformExternCompilerJarPath();
    expect(capabilities.compilerVersion).toBe(compilerPackage.version);
    expect(compilerJarPath).not.toBeNull();
    if (!compilerJarPath) throw new Error("Unable to resolve the pinned Closure jar.");

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gcc-closure-capabilities-"),
    );
    try {
      for (const fixture of PARSE_FIXTURES) {
        const inputPath = path.join(tempDir, fixture.fileName);
        const outputPath = path.join(tempDir, `${fixture.fileName}.out.js`);
        await fs.writeFile(inputPath, fixture.source, "utf8");
        let parseSucceeded = true;
        try {
          await execFileAsync("java", [
            "-jar",
            compilerJarPath,
            "--compilation_level",
            "WHITESPACE_ONLY",
            "--language_in",
            "UNSTABLE",
            "--language_out",
            "ECMASCRIPT_NEXT",
            "--js",
            inputPath,
            "--js_output_file",
            outputPath,
          ]);
        } catch {
          parseSucceeded = false;
        }
        expect(parseSucceeded).toBe(capabilities[fixture.capability]);
      }
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  },
);
