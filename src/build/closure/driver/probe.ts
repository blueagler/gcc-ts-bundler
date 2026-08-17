import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as closureCompilerPackage from "google-closure-compiler";

import { getPackageRootFromBundle } from "../../../shared/bundle-location";

export type ClosureDriverProbe =
  | { ok: false; reason: string }
  | {
      ok: true;
      kind: "jar-worker";
      jarPath: string;
      classesDir: string;
      javaPath: string;
    };

const ECJ_JAR = "/tmp/ecj/ecj.jar";
const JAVA_PATH = "java";

let cachedProbe: Promise<ClosureDriverProbe> | undefined;

export function isDriverForcedOff() {
  return process.env["GCC_CLOSURE_DRIVER"] === "0";
}


export function probeClosureDriver(): Promise<ClosureDriverProbe> {
  cachedProbe ??= runProbe();
  return cachedProbe;
}

async function runProbe(): Promise<ClosureDriverProbe> {
  if (isDriverForcedOff()) {
    return { ok: false, reason: "GCC_CLOSURE_DRIVER=0" };
  }

  const jarPath = resolveJarPath();
  if (!jarPath) {
    return { ok: false, reason: "closure compiler jar is not installed" };
  }

  const version = await runOnce(JAVA_PATH, [
    "-XX:+IgnoreUnrecognizedVMOptions",
    "--sun-misc-unsafe-memory-access=allow",
    "-jar",
    jarPath,
    "--version",
  ]);
  if (version.code !== 0) {
    return {
      ok: false,
      reason: `compiler --version failed: ${version.stderr || version.stdout}`,
    };
  }

  const source = loadWorkerSource();
  if (!source) {
    return { ok: false, reason: "ResidentCliWorker.java is missing" };
  }

  const classesDir = path.join(
    os.tmpdir(),
    "gcc-ts-bundler-closure-driver",
    createHash("sha256").update(source).digest("hex").slice(0, 16),
  );
  mkdirSync(classesDir, { recursive: true });
  const classFile = path.join(classesDir, "ResidentCliWorker.class");
  if (!existsSync(classFile)) {
    const sourceFile = path.join(classesDir, "ResidentCliWorker.java");
    writeFileSync(sourceFile, source);
    const compiled = await compileWorker(jarPath, classesDir, sourceFile);
    if (!compiled.ok) {
      return compiled;
    }
  }

  return {
    ok: true,
    kind: "jar-worker",
    jarPath,
    classesDir,
    javaPath: JAVA_PATH,
  };
}

function resolveJarPath(): string | undefined {
  const fromExport = asNonEmptyString(
    (closureCompilerPackage as { JAR_PATH?: unknown }).JAR_PATH,
  );
  if (fromExport) {
    return fromExport;
  }
  const instance = new closureCompilerPackage.compiler({}) as unknown as {
    JAR_PATH?: unknown;
  };
  return asNonEmptyString(instance.JAR_PATH);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function loadWorkerSource(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("./ResidentCliWorker.java", import.meta.url)),
  ];
  try {
    candidates.push(
      path.join(
        getPackageRootFromBundle(),
        "src/build/closure/driver/ResidentCliWorker.java",
      ),
    );
  } catch {
    // Bundled builds may not sit next to package.json.
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }
  return undefined;
}

async function compileWorker(
  jarPath: string,
  classesDir: string,
  sourceFile: string,
): Promise<ClosureDriverProbe> {
  const javac = await runOnce(JAVA_PATH, [
    "com.sun.tools.javac.Main",
    "-encoding",
    "UTF-8",
    "-cp",
    jarPath,
    "-d",
    classesDir,
    sourceFile,
  ]);
  if (
    javac.code === 0 &&
    existsSync(path.join(classesDir, "ResidentCliWorker.class"))
  ) {
    return {
      ok: true,
      kind: "jar-worker",
      jarPath,
      classesDir,
      javaPath: JAVA_PATH,
    };
  }

  if (!existsSync(ECJ_JAR)) {
    return {
      ok: false,
      reason: `javac failed and ${ECJ_JAR} is missing: ${javac.stderr || javac.stdout}`,
    };
  }

  const ecj = await runOnce(JAVA_PATH, [
    "-jar",
    ECJ_JAR,
    "-encoding",
    "UTF-8",
    "-source",
    "17",
    "-target",
    "17",
    "-cp",
    jarPath,
    "-d",
    classesDir,
    sourceFile,
  ]);
  if (
    ecj.code === 0 &&
    existsSync(path.join(classesDir, "ResidentCliWorker.class"))
  ) {
    return {
      ok: true,
      kind: "jar-worker",
      jarPath,
      classesDir,
      javaPath: JAVA_PATH,
    };
  }
  return {
    ok: false,
    reason: `worker compile failed: ${ecj.stderr || ecj.stdout || javac.stderr}`,
  };
}

function runOnce(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
