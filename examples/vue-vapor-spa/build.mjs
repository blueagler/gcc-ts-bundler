import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse, compileScript } from "vue/compiler-sfc";

import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(projectRoot, "src");
const compiledDir = path.join(projectRoot, ".vue-compiled");
const vendorDir = path.join(compiledDir, "vendor");
const runtimeCompiledFile = path.join(
  vendorDir,
  "vue.runtime-with-vapor.esm-browser.js",
);
const runtimeSource = path.join(
  projectRoot,
  "node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js",
);

await compileVueProject(srcDir, compiledDir);

// Runtime-aware externs over the compiled app plus the vendored vapor
// runtime: vapor reaches DOM handlers through constructed keys
// (`node[\`$evt${type}\`]`) and bridges quoted kebab-case prop pass sites to
// camelCase declarations via camelize - both are rename hazards only the
// runtime scan can see.
const runtimeExternsFile = path.join(projectRoot, "vue.runtime.externs.js");
await generateExterns({
  mode: "runtime-aware",
  modules: ["vue"],
  outputFile: runtimeExternsFile,
  projectRoot,
  runtimeEntryFiles: await collectCompiledJsFiles(compiledDir),
  srcDir: "./.vue-compiled",
});

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "split", publicPath: "./dist/" },
  diagnostics: { preflight: "full" },
  entries: ["./main.js"],
  externs: ["./vue.runtime.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./.vue-compiled",
});

if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    const where = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}: `
      : "";
    console.error(`${where}${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(
  `Built Vue Vapor SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Compiled Vue SFCs into ${path.relative(projectRoot, compiledDir)}`,
);
console.log(
  `Generated runtime externs at ${path.relative(projectRoot, runtimeExternsFile)}`,
);

async function compileVueProject(sourceDir, outDir) {
  await fs.rm(outDir, { force: true, recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await writeVendoredVueRuntimeFiles();
  await copyAndCompileDirectory(sourceDir, outDir);
}

async function copyAndCompileDirectory(sourceDir, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outPath = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      await copyAndCompileDirectory(sourcePath, outPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".vue")) {
      await compileVueFile(sourcePath, `${outPath}.js`);
      continue;
    }
    if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      const source = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(
        outPath,
        rewriteVueSpecifiers(source, outPath),
        "utf8",
      );
    }
  }
}

async function compileVueFile(filePath, outputFile) {
  const source = await fs.readFile(filePath, "utf8");
  const { descriptor, errors } = parse(source, {
    filename: filePath,
    sourceMap: false,
  });

  if (errors.length > 0) {
    throw new Error(
      errors
        .map((error) => (typeof error === "string" ? error : error.message))
        .join("\n"),
    );
  }

  if (descriptor.script?.src || descriptor.scriptSetup?.src) {
    throw new Error(`External <script src> is not supported in ${filePath}`);
  }
  if (descriptor.styles.length > 0) {
    throw new Error(
      `Inline <style> blocks are not supported in this example compiler: ${filePath}`,
    );
  }
  if (!descriptor.scriptSetup) {
    throw new Error(
      `Expected <script setup vapor> in ${filePath} so the example stays on the Vapor path.`,
    );
  }

  const id = createHash("sha256")
    .update(path.relative(projectRoot, filePath))
    .digest("hex")
    .slice(0, 8);

  const script = compileScript(descriptor, {
    id,
    inlineTemplate: true,
    genDefaultAs: "__sfc__",
    isProd: true,
    sourceMap: false,
    vapor: true,
    templateOptions: {
      id,
      isProd: true,
      sourceMap: false,
      vapor: true,
    },
  });

  const output = `${rewriteVueSpecifiers(script.content, outputFile)}\nexport default __sfc__;\n`;
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, output, "utf8");
}

function rewriteVueSpecifiers(sourceText, outputFile) {
  const vaporRuntimeImport = toImportSpecifier(
    path.relative(path.dirname(outputFile), runtimeCompiledFile),
  );

  return sourceText
    .replace(
      /((?:import|export)\s[\s\S]*?\sfrom\s*["'])(\.{1,2}\/[^"']+)\.vue(["'])/g,
      "$1$2.vue.js$3",
    )
    .replace(
      /(import\s*\(\s*["'])(\.{1,2}\/[^"']+)\.vue(["']\s*\))/g,
      "$1$2.vue.js$3",
    )
    .replace(
      /((?:import|export)\s[\s\S]*?\sfrom\s*["'])vue(["'])/g,
      `$1${vaporRuntimeImport}$2`,
    );
}

function toImportSpecifier(value) {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

async function writeVendoredVueRuntimeFiles() {
  await fs.mkdir(vendorDir, { recursive: true });
  await fs.copyFile(runtimeSource, runtimeCompiledFile);
}

async function collectCompiledJsFiles(rootDir) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(".js")) {
        files.push(path.relative(projectRoot, entryPath));
      }
    }
  };
  await walk(rootDir);
  return files.sort();
}
