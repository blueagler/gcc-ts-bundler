import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

import { parse, compileScript } from "vue/compiler-sfc";

import { build, generateExterns } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(projectRoot, "src");
const compiledDir = path.join(projectRoot, ".vue-compiled");
const externsFile = path.join(projectRoot, "vue.generated.externs.js");
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
await generateExterns({
  mode: "candidates",
  modules: ["vue"],
  outputFile: externsFile,
  projectRoot,
  srcDir: "./.vue-compiled",
});
await augmentGeneratedExterns(compiledDir, externsFile);

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "bundler-runtime", publicPath: "./dist/" },
  diagnostics: { preflight: "full" },
  entries: ["./main.js"],
  // externs: ["./vue.generated.externs.js"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./.vue-compiled",
});

if (result.exitCode !== 0) {
  for (const diagnostic of result.diagnostics) {
    const message =
      typeof diagnostic?.messageText === "string"
        ? diagnostic.messageText
        : ts.flattenDiagnosticMessageText(
            diagnostic?.messageText ?? diagnostic,
            "\n",
          );
    console.error(message);
  }
  process.exit(result.exitCode);
}

console.log(
  `Built Vue Vapor SPA to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Compiled Vue SFCs into ${path.relative(projectRoot, compiledDir)}`,
);
console.log(`Generated externs at ${path.relative(projectRoot, externsFile)}`);

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

async function augmentGeneratedExterns(rootDir, outputFile) {
  const protocolKeys = await collectVueProtocolKeys(rootDir);
  if (protocolKeys.length === 0) {
    return;
  }

  const existing = await fs.readFile(outputFile, "utf8");
  const existingLines = new Set(existing.split("\n"));
  const additions = [];
  for (const key of protocolKeys) {
    const line = `Object.prototype.${key};`;
    if (!existingLines.has(line)) {
      additions.push(line);
    }
  }

  if (additions.length === 0) {
    return;
  }

  const suffix = `\n// Preserved Vue Vapor runtime protocol keys.\n${additions.join("\n")}\n`;
  await fs.writeFile(outputFile, `${existing.trimEnd()}${suffix}`, "utf8");
}

async function collectVueProtocolKeys(rootDir) {
  const delegatedEventKeys = new Set();
  const dotAccessKeys = new Set();
  const propKeys = new Set();
  const stringAccessKeys = new Set();
  const blockedKeys = new Set(["this"]);
  await walkCompiledFiles(rootDir, async (filePath) => {
    if (!filePath.endsWith(".js")) {
      return;
    }
    const source = await fs.readFile(filePath, "utf8");
    collectVueComponentPropKeys(source, propKeys, blockedKeys);
    for (const match of source.matchAll(/\$evt[A-Za-z][A-Za-z0-9_$]*/g)) {
      delegatedEventKeys.add(match[0]);
    }
    for (const match of source.matchAll(/\.([$_A-Za-z][$_0-9A-Za-z]*)/g)) {
      if (!blockedKeys.has(match[1])) {
        dotAccessKeys.add(match[1]);
      }
    }
    for (const match of source.matchAll(
      /\[\s*["']([$_A-Za-z][$_0-9A-Za-z]*)["']\s*\]/g,
    )) {
      if (!blockedKeys.has(match[1])) {
        stringAccessKeys.add(match[1]);
      }
    }
    for (const match of source.matchAll(
      /["']([$_A-Za-z][$_0-9A-Za-z]*)["']\s+in\b/g,
    )) {
      if (!blockedKeys.has(match[1])) {
        stringAccessKeys.add(match[1]);
      }
    }
  });

  const hazardKeys = new Set(delegatedEventKeys);
  for (const key of propKeys) {
    hazardKeys.add(key);
  }
  for (const key of stringAccessKeys) {
    if (dotAccessKeys.has(key)) {
      hazardKeys.add(key);
    }
  }

  return [...hazardKeys].sort();
}

function collectVueComponentPropKeys(sourceText, target, blockedKeys) {
  const sourceFile = ts.createSourceFile(
    "compiled-vue.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === "props"
    ) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (
            !ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)
          ) {
            continue;
          }
          const key = propertyNameText(property.name);
          if (key && !blockedKeys.has(key)) {
            target.add(key);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
}

function propertyNameText(name) {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

async function walkCompiledFiles(rootDir, visitFile) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkCompiledFiles(fullPath, visitFile);
      continue;
    }
    if (entry.isFile()) {
      await visitFile(fullPath);
    }
  }
}
