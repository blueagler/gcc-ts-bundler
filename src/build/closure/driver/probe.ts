import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as closureCompilerPackage from "google-closure-compiler";

import { getPackageRootFromBundle } from "../../../shared/bundle-location";
import { getDefaultPersistentCacheRoot } from "../../../shared/cache-store";

export type ClosureDriverProbe =
  | { ok: false; reason: string }
  | {
      ok: true;
      kind: "jar-worker";
      jarPath: string;
      classesDir: string;
      javaPath: string;
    };

const JAVA_PATH = "java";
const CLASS_FILE_NAME = "ResidentCliWorker.class";
const SOURCE_FILE_NAME = "ResidentCliWorker.java";
const MANIFEST_FILE_NAME = "ResidentCliWorker.manifest";
const CACHE_DIR_NAME = "closure-driver";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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

  // The compiled class sits on the JVM classpath, so whoever can write it
  // chooses what the build executes. A content-addressed path under the shared
  // temp directory is guessable from public sources and pre-plantable, so the
  // cache lives under the per-user cache root instead, and a cached class is
  // only reused when its recorded fingerprint still matches.
  const cachedDir = ensurePrivateDirectory(getDefaultPersistentCacheRoot(), [
    CACHE_DIR_NAME,
    createHash("sha256").update(source).digest("hex").slice(0, 16),
  ]);
  if (cachedDir && hasVerifiedWorkerClass(cachedDir)) {
    return {
      ok: true,
      kind: "jar-worker",
      jarPath,
      classesDir: cachedDir,
      javaPath: JAVA_PATH,
    };
  }

  const classesDir = cachedDir ?? createEphemeralClassesDir();
  if (!classesDir) {
    return {
      ok: false,
      reason: "no private directory available for the resident worker classes",
    };
  }
  return compileWorker(jarPath, classesDir, source);
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

function ensurePrivateDirectory(
  root: string,
  segments: readonly string[],
): string | undefined {
  const uid = process.getuid?.();
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    dirs.push(current);
  }
  for (const dirPath of dirs) {
    let stats: Stats;
    try {
      stats = lstatSync(dirPath);
    } catch {
      try {
        mkdirSync(dirPath, {
          recursive: dirPath === root,
          mode: PRIVATE_DIR_MODE,
        });
        stats = lstatSync(dirPath);
      } catch {
        return undefined;
      }
    }
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      return undefined;
    }
    try {
      chmodSync(dirPath, PRIVATE_DIR_MODE);
    } catch {
      // Ownership is the gate; tightening mode is best-effort.
    }
  }
  return current;
}

function createEphemeralClassesDir(): string | undefined {
  try {
    const dir = mkdtempSync(
      path.join(os.tmpdir(), "gcc-ts-bundler-closure-driver-"),
    );
    const stats = lstatSync(dir);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}

function isOwnedRegularFile(
  filePath: string,
  uid: number | undefined,
): boolean {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() && (uid === undefined || stats.uid === uid);
  } catch {
    return false;
  }
}

function classManifestFor(
  classesDir: string,
  uid: number | undefined,
): string | undefined {
  let names: string[];
  try {
    names = readdirSync(classesDir).filter((name) => name.endsWith(".class"));
  } catch {
    return undefined;
  }
  if (!names.includes(CLASS_FILE_NAME)) {
    return undefined;
  }
  names.sort();
  const lines: string[] = [];
  for (const name of names) {
    const filePath = path.join(classesDir, name);
    if (!isOwnedRegularFile(filePath, uid)) {
      return undefined;
    }
    lines.push(
      `${name}:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function hasVerifiedWorkerClass(classesDir: string): boolean {
  const uid = process.getuid?.();
  const manifestFile = path.join(classesDir, MANIFEST_FILE_NAME);
  if (
    !isOwnedRegularFile(path.join(classesDir, CLASS_FILE_NAME), uid) ||
    !isOwnedRegularFile(manifestFile, uid)
  ) {
    return false;
  }
  const actual = classManifestFor(classesDir, uid);
  if (actual === undefined) {
    return false;
  }
  try {
    return readFileSync(manifestFile, "utf8") === actual;
  } catch {
    return false;
  }
}

function writeClassManifest(classesDir: string): boolean {
  const uid = process.getuid?.();
  const manifest = classManifestFor(classesDir, uid);
  if (manifest === undefined) {
    return false;
  }
  try {
    writeFileSync(path.join(classesDir, MANIFEST_FILE_NAME), manifest, {
      mode: PRIVATE_FILE_MODE,
    });
    return true;
  } catch {
    return false;
  }
}

async function compileWorker(
  jarPath: string,
  classesDir: string,
  source: string,
): Promise<ClosureDriverProbe> {
  const sourceFile = path.join(classesDir, SOURCE_FILE_NAME);
  try {
    writeFileSync(sourceFile, source, { mode: PRIVATE_FILE_MODE });
  } catch (error) {
    return {
      ok: false,
      reason: `failed to write worker source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  if (javac.code !== 0) {
    return {
      ok: false,
      reason: `javac failed: ${javac.stderr || javac.stdout}`,
    };
  }
  if (!writeClassManifest(classesDir)) {
    return {
      ok: false,
      reason: "compiled worker class is missing or not privately owned",
    };
  }
  return {
    ok: true,
    kind: "jar-worker",
    jarPath,
    classesDir,
    javaPath: JAVA_PATH,
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
