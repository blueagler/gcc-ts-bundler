import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

// TEMPORARY M0/M1 parser bridge; remove with the legacy compiler-API migration.
import ts from "@typescript/typescript6";

const BUN = process.platform === "win32" ? "bun.exe" : "bun";
const SHOW_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";

await Promise.all([
  rm("./dist", { force: true, recursive: true }),
  rm("./bin", { force: true, recursive: true }),
]);

await runCommandsInParallel([
  {
    args: [
      "build",
      "./src/index.ts",
      "./src/vite/index.ts",
      "./src/presets/react.ts",
      "./src/presets/svelte.ts",
      "./src/presets/vue.ts",
      "--outdir",
      "./dist",
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "[dir]/[name].mjs",
      "--target",
      "node",
      "--root",
      "./src",
    ],
    label: "build-js:esm",
  },
  {
    args: [
      "build",
      "./src/cli/main.ts",
      "--outdir",
      "./bin",
      "--format",
      "esm",
      "--packages",
      "external",
      "--banner",
      "const __gcc_current_module_url = import.meta.url;",
      "--entry-naming",
      "gcc-ts-bundler.mjs",
      "--target",
      "node",
    ],
    label: "build-js:cli",
  },
]);

await runCommand(
  process.execPath,
  ["./scripts/run-typescript.mjs", "-p", "./tsconfig.types.json"],
  { label: "build-js:types" },
);
await rewriteDeclarationSpecifiers("./dist");

async function rewriteDeclarationSpecifiers(directory) {
  const declarationFiles = await collectDeclarationFiles(directory);
  await Promise.all(declarationFiles.map(rewriteDeclarationFile));
}

async function collectDeclarationFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function rewriteDeclarationFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = [];

  const visit = (node) => {
    const moduleSpecifier = getModuleSpecifier(node);
    if (moduleSpecifier) {
      const nextSpecifier = resolveDeclarationSpecifier(
        filePath,
        moduleSpecifier.text,
      );
      if (nextSpecifier !== moduleSpecifier.text) {
        edits.push({
          end: moduleSpecifier.getEnd() - 1,
          start: moduleSpecifier.getStart(sourceFile) + 1,
          text: nextSpecifier,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  if (output !== source) {
    await writeFile(filePath, output, "utf8");
  }
}

function getModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  return null;
}

function resolveDeclarationSpecifier(filePath, specifier) {
  if (
    (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
    path.posix.extname(specifier)
  ) {
    return specifier;
  }

  const target = path.resolve(path.dirname(filePath), specifier);
  if (existsSync(`${target}.d.ts`)) {
    return `${specifier}.js`;
  }
  if (existsSync(path.join(target, "index.d.ts"))) {
    return `${specifier.replace(/\/$/u, "")}/index.js`;
  }
  throw new Error(
    `Cannot resolve declaration import ${specifier} from ${filePath}`,
  );
}

async function runCommandsInParallel(commands) {
  const running = commands.map(({ args, label }) =>
    startCommand(BUN, args, { label }),
  );
  try {
    await Promise.all(running.map(({ done }) => done));
  } catch (error) {
    for (const { child } of running) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

async function runCommand(command, args, options = {}) {
  await startCommand(command, args, options).done;
}

function startCommand(command, args, { label } = {}) {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    stdio: "inherit",
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        logTiming(label, startedAt);
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited via signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code ?? 1}`,
        ),
      );
    });
  });
  return { child, done };
}

function logTiming(label, startedAt) {
  if (!SHOW_TIMINGS || !label) {
    return;
  }

  const durationMs = performance.now() - startedAt;
  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}
