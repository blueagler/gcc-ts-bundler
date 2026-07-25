import fs from "node:fs/promises";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";
import { compileLitTemplates } from "@lit-labs/compiler";
import { build } from "../../dist/index.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const compiledDir = path.join(projectRoot, ".lit-compiled");

await compileLitProject();

const result = await build({
  cache: { mode: "off" },
  chunks: { mode: "bundler-runtime" },
  entries: ["./main.ts"],
  outDir: "./dist",
  projectRoot,
  srcDir: "./.lit-compiled",
  languageOut: "ECMASCRIPT5",
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
  `Built Lit playground to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Compiled Lit templates into ${path.relative(projectRoot, compiledDir)}`,
);

async function compileLitProject() {
  await fs.rm(compiledDir, { force: true, recursive: true });
  await fs.mkdir(compiledDir, { recursive: true });

  const configPath = ts.findConfigFile(
    projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    throw new Error("Unable to find tsconfig.json for Lit playground.");
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        [configFile.error],
        createCompilerHost(),
      ),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectRoot,
    {
      declaration: false,
      declarationMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      noEmit: false,
      outDir: compiledDir,
      sourceMap: false,
    },
    configPath,
  );

  if (parsedConfig.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsedConfig.errors,
        createCompilerHost(),
      ),
    );
  }

  const diagnostics = [];
  for (const fileName of parsedConfig.fileNames) {
    const sourceText = await fs.readFile(fileName, "utf8");
    const relativePath = path.relative(projectRoot, fileName);
    const outputFile = path.join(compiledDir, relativePath);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });

    const result = ts.transpileModule(sourceText, {
      compilerOptions: {
        ...parsedConfig.options,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
        target: ts.ScriptTarget.ESNext,
      },
      fileName,
      reportDiagnostics: true,
      transformers: {
        before: [compileLitTemplates()],
      },
    });

    if (result.diagnostics) {
      diagnostics.push(...result.diagnostics);
    }
    await fs.writeFile(
      outputFile,
      rewriteLocalJsSpecifiersToTs(result.outputText),
      "utf8",
    );
  }

  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        createCompilerHost(),
      ),
    );
  }
}

function createCompilerHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  };
}

function rewriteLocalJsSpecifiersToTs(sourceText) {
  return sourceText
    .replace(
      /((?:import|export)\s[\s\S]*?\sfrom\s*["'])(\.{1,2}\/[^"']+)\.js(["'])/g,
      "$1$2.ts$3",
    )
    .replace(
      /(import\s*\(\s*["'])(\.{1,2}\/[^"']+)\.js(["']\s*\))/g,
      "$1$2.ts$3",
    );
}
