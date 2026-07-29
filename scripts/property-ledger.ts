/**
 * Property-name ledger: makes annotation quality observable.
 *
 * Implements the metric described in
 * `docs/research/externs-v3-boundary-model.md` Part II §5. Today a build is
 * judged only by bytes, so the thing that actually gates Closure's typed
 * optimizations — how many property names survive renaming, and why — is
 * invisible and therefore unregressable.
 *
 * For each example the harness runs an isolated probe build under a temp root
 * (never touching any `dist` inside the worktree), then reports per build:
 *
 *   (a) total distinct property names in the emitted output
 *   (b) renamed vs kept-original, from the property renaming report the jobs
 *       already write (`run-closure.ts` wires `--property_renaming_report`)
 *   (c) kept-original names attributed to the extern channel that pins them
 *   (d) invalidation suspects: kept-original, pinned by nothing we ship and
 *       not an ECMA core name — see the honesty note on `SUSPECT` below
 *   (e) a cost ranking: occurrences x name length
 *
 * Usage:
 *   bun run ledger                       # all examples, table to stdout
 *   bun run ledger -- --json out.json    # + machine-readable ledger
 *   bun run ledger -- --example react-spa
 *   bun run ledger -- --top 20           # rows in each cost table
 *
 * Deterministic: every collection is sorted, the probe root is fixed per
 * example, and no wall-clock value enters the JSON.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROBE_ROOT = process.env["GCC_LEDGER_PROBE_ROOT"] ?? "/tmp/gcc-ledger";
const CLOSURE_JAR = path.join(
  REPO_ROOT,
  "node_modules/google-closure-compiler-java/compiler.jar",
);

// ---------------------------------------------------------------------------
// Extern channels
// ---------------------------------------------------------------------------

/**
 * The boundary channels of `externs-v3-boundary-model.md` Part I §3, plus the
 * two non-extern pinning sources a name can legitimately land in. Order is
 * attribution precedence: a name declared in several channels is charged to
 * the first one here, and `channels` keeps the full list.
 */
const CHANNEL_ORDER = [
  "explicit", // B/C/D — extern files the example passes by hand
  "generated", // typed declarations rendered from .d.ts
  "native", // D repair — native preserved-property emission
  "runtime", // bundler-runtime shared externs
  "package", // closure-externs/ shipped with the package
  "platform", // A — the sliced platform externs this build actually shipped
  "platform-builtin", // A — declared by Closure's bundled browser externs but
  // outside our slice: reached only by text Closure never compiled (runtime
  // preludes are appended post-compile), so slice coverage, not a miss
  "ecma-core", // language contract: Closure's own es3/es5/es6 externs
] as const;
type Channel = (typeof CHANNEL_ORDER)[number];

const SUSPECT = "invalidation-suspect";

// ---------------------------------------------------------------------------
// Example descriptors
// ---------------------------------------------------------------------------

interface ExampleDescriptor {
  /** Build options, mirroring the example's own build.mjs. */
  buildOptions?: Record<string, unknown>;
  /** Preparation the example's build.mjs does before calling build(). */
  dependsOnGeneratedSources?: string[];
  kind: "api" | "vite";
  name: string;
  /** Directory under examples/. */
  dir: string;
  /** For vite examples: the config to build with. */
  viteConfig?: string;
}

const EXAMPLES: ExampleDescriptor[] = [
  {
    name: "jquery-demo",
    dir: "jquery-demo",
    kind: "api",
    buildOptions: {
      diagnostics: { preflight: "full" },
      entries: ["./main.ts"],
      externs: ["./jquery.boundary.externs.js", "./jquery.runtime.externs.js"],
      srcDir: ".",
    },
  },
  {
    name: "lazy-chunks-demo",
    dir: "lazy-chunks-demo",
    kind: "api",
    buildOptions: {
      chunks: { mode: "split", publicPath: "./" },
      entries: ["./main.ts"],
      srcDir: ".",
    },
  },
  {
    name: "lit-playground",
    dir: "lit-playground",
    kind: "api",
    dependsOnGeneratedSources: [".lit-compiled"],
    buildOptions: {
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      languageOut: "ECMASCRIPT5",
      srcDir: "./.lit-compiled",
    },
  },
  {
    name: "react-spa",
    dir: "react-spa",
    kind: "api",
    buildOptions: {
      diagnostics: { preflight: "full" },
      entries: ["./main.tsx"],
      externs: ["./react.generated.externs.js"],
      srcDir: "./src",
    },
    // classMapCalls are loaded from the shipped preset at run time.
  },
  {
    name: "svelte-spa",
    dir: "svelte-spa",
    kind: "api",
    dependsOnGeneratedSources: [".prebundle"],
    buildOptions: {
      chunks: { mode: "bundler-runtime" },
      diagnostics: { preflight: "full" },
      entries: ["./main.js"],
      externs: ["./svelte.generated.externs.js"],
      languageOut: "ECMASCRIPT_NEXT",
      srcDir: "./.prebundle",
    },
  },
  {
    name: "vue-vapor-spa",
    dir: "vue-vapor-spa",
    kind: "api",
    dependsOnGeneratedSources: [".vue-compiled"],
    buildOptions: {
      chunks: { mode: "split", publicPath: "./dist/" },
      diagnostics: { preflight: "full" },
      entries: ["./main.js"],
      externs: ["./vue.runtime.externs.js"],
      srcDir: "./.vue-compiled",
    },
  },
  {
    name: "svelte-vite-spa",
    dir: "svelte-vite-spa",
    kind: "vite",
    viteConfig: "vite.config.ts",
  },
  { name: "vue-spa", dir: "vue-spa", kind: "vite", viteConfig: "vite.config.ts" },
];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Blanks out string, template and regex literal bodies, preserving offsets.
 *
 * Without this, CSS text carried in string literals reads as property access:
 * Svelte ships scoped rules like `.svelte-1qfyjnx{...}` inside a style string,
 * and a naive `\.name` scan counts `svelte` as a 171-occurrence property. A
 * property access can never occur inside a literal, so blanking them is exact
 * for this purpose.
 *
 * Regex literals are detected with the standard previous-significant-token
 * heuristic, which is what keeps a quote inside `/["']/` from opening a string.
 */
export function blankLiterals(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let cursor = from; cursor < to && cursor < out.length; cursor += 1) {
      if (out[cursor] !== "\n") out[cursor] = " ";
    }
  };
  // Stack of open template literals; a `}` closes an interpolation only when
  // brace depth returns to the level the interpolation opened at.
  const templates: number[] = [];
  let braceDepth = 0;
  let index = 0;
  let previous = "";

  while (index < source.length) {
    const char = source[index] ?? "";

    if (char === "{") {
      braceDepth += 1;
      previous = char;
      index += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      if (templates.length > 0 && braceDepth === templates[templates.length - 1]) {
        // Interpolation closed: resume the enclosing template's text run.
        index = blankTemplateText(source, blank, index + 1, templates, () => braceDepth);
        previous = "literal";
        continue;
      }
      previous = char;
      index += 1;
      continue;
    }
    if (char === "`") {
      templates.push(braceDepth);
      index = blankTemplateText(source, blank, index + 1, templates, () => braceDepth);
      previous = "literal";
      continue;
    }
    if (char === '"' || char === "'") {
      const startIndex = index;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === char) break;
        index += 1;
      }
      blank(startIndex + 1, index);
      index += 1;
      previous = "literal";
      continue;
    }
    if (char === "/" && regexCanStart(previous)) {
      const startIndex = index;
      index += 1;
      let inClass = false;
      let closed = false;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === "\n") break;
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          closed = true;
          break;
        }
        index += 1;
      }
      if (closed) {
        blank(startIndex + 1, index);
        index += 1;
        previous = "literal";
        continue;
      }
      index = startIndex + 1;
      previous = "/";
      continue;
    }
    if (!/\s/u.test(char)) previous = char;
    index += 1;
  }
  return out.join("");
}

/**
 * Blanks a template literal's text run starting at `from`, stopping at the
 * closing backtick or at a `${` interpolation (whose expression is left for
 * the main scanner, because property accesses do occur there).
 * Returns the index to resume from.
 */
function blankTemplateText(
  source: string,
  blank: (from: number, to: number) => void,
  from: number,
  templates: number[],
  braceDepth: () => number,
): number {
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      blank(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      blank(from, index);
      templates.pop();
      return index + 1;
    }
    if (char === "$" && source[index + 1] === "{") {
      blank(from, index);
      templates[templates.length - 1] = braceDepth();
      return index + 1; // main loop sees `{` and increments brace depth
    }
    index += 1;
  }
  blank(from, index);
  return index;
}

/**
 * After these, a `/` starts a regex rather than a division. Identifier and
 * literal characters, `)` and `]` mean division.
 */
function regexCanStart(previous: string) {
  if (previous === "") return true;
  if (previous === "literal") return false;
  return !/[\w$)\]]/u.test(previous);
}

/**
 * Property names declared by a Closure extern file.
 *
 * Deliberately syntactic rather than a parse: extern files are a restricted
 * dialect (declaration statements only) and every form below is what Closure's
 * own externs and our generators emit. Anything unrecognised is simply not
 * attributed, which pushes a name toward the suspect column — the fail-loud
 * direction for a metric whose job is to find unpinned names.
 */
export function extractExternPropertyNames(source: string): Set<string> {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    if (name && name !== "prototype") {
      names.add(name);
    }
  };
  // `Owner.prototype.name;` and `Owner.prototype.name = function(){};`
  for (const match of source.matchAll(
    /\.prototype\.([A-Za-z_$][\w$]*)/gu,
  )) {
    add(match[1]);
  }
  // `Owner.name;` / `Owner.name = ...` static declarations (not prototype).
  for (const match of source.matchAll(
    /^[ \t]*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.([A-Za-z_$][\w$]*)\s*(?:;|=)/gmu,
  )) {
    add(match[1]);
  }
  // `Owner.prototype = { name: ... }` and @record bodies.
  for (const match of source.matchAll(/^[ \t]+([A-Za-z_$][\w$]*)\s*:/gmu)) {
    add(match[1]);
  }
  // Quoted pins: `Owner.prototype["name"]`, `obj["name"]`.
  for (const match of source.matchAll(
    /\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/gu,
  )) {
    add(match[2]);
  }
  return names;
}

/** `original:renamed` per line; only renamed properties are listed. */
export function parseRenamingReport(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0) continue;
    map.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return map;
}

interface NameUse {
  count: number;
  firstSite: string | null;
}

/**
 * Distinct property names in emitted JavaScript, with occurrence counts.
 *
 * `.name` and `["name"]` only: those are the two forms a renamed or pinned
 * property can take in output. Numeric and computed accesses are not property
 * names in the renamer's sense.
 */
export function extractOutputPropertyNames(
  files: { path: string; source: string }[],
): Map<string, NameUse> {
  const uses = new Map<string, NameUse>();
  for (const file of files) {
    const scannable = blankLiterals(file.source);
    const lineStarts = computeLineStarts(file.source);
    const record = (name: string, index: number) => {
      const existing = uses.get(name);
      if (existing) {
        existing.count += 1;
        return;
      }
      uses.set(name, {
        count: 1,
        firstSite: `${path.basename(file.path)}:${lineOf(lineStarts, index)}`,
      });
    };
    for (const match of scannable.matchAll(/\.([A-Za-z_$][\w$]*)/gu)) {
      record(match[1] ?? "", match.index + 1);
    }
    // Quoted access survives literal-blanking because the key is the literal;
    // read those from the original text.
    for (const match of file.source.matchAll(
      /\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/gu,
    )) {
      record(match[2] ?? "", match.index);
    }
  }
  uses.delete("");
  return uses;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// ---------------------------------------------------------------------------
// Probe builds
// ---------------------------------------------------------------------------

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function probeDirFor(example: ExampleDescriptor) {
  return path.join(PROBE_ROOT, example.name);
}

function buildApiExample(example: ExampleDescriptor) {
  const probeDir = probeDirFor(example);
  const outDir = path.join(probeDir, "out");
  const cacheDir = path.join(probeDir, "cache");
  fs.rmSync(probeDir, { force: true, recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });

  const projectRoot = path.join(REPO_ROOT, "examples", example.dir);
  for (const generated of example.dependsOnGeneratedSources ?? []) {
    if (!fs.existsSync(path.join(projectRoot, generated))) {
      return {
        error: `missing generated sources ${generated}; run the example's own build.mjs once first`,
        outDir,
        cacheDir,
      };
    }
  }

  // React's build.mjs supplies classMapCalls from the shipped preset; load it
  // the same way so the probe compiles the same program.
  const needsReactPreset = example.name === "react-spa";
  const script = `
import path from "node:path";
import { build } from ${JSON.stringify(path.join(REPO_ROOT, "dist/index.mjs"))};
${
  needsReactPreset
    ? `import { REACT_ELEMENT_PROPS_CALLS } from ${JSON.stringify(path.join(REPO_ROOT, "dist/presets/react.mjs"))};`
    : ""
}
const result = await build({
  ...${JSON.stringify(example.buildOptions ?? {})},
${needsReactPreset ? "  compat: { classMapCalls: [...REACT_ELEMENT_PROPS_CALLS] }," : ""}
  cache: { mode: "persistent", dir: ${JSON.stringify(cacheDir)} },
  outDir: ${JSON.stringify(outDir)},
  projectRoot: ${JSON.stringify(projectRoot)},
});
if (!result.ok) {
  console.error(result.diagnostics.map((d) => d.message).join("\\n"));
  process.exit(1);
}
`;
  const scriptPath = path.join(probeDir, "probe.mjs");
  fs.writeFileSync(scriptPath, script, "utf8");
  const outcome = run(process.execPath, [scriptPath], probeDir);
  return {
    error: outcome.status === 0 ? null : outcome.stderr.trim() || "build failed",
    outDir,
    cacheDir,
  };
}

function buildViteExample(example: ExampleDescriptor) {
  const probeDir = probeDirFor(example);
  const projectRoot = path.join(REPO_ROOT, "examples", example.dir);
  fs.rmSync(probeDir, { force: true, recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });

  // Copy the project (minus node_modules/dist) so the plugin's capture root
  // and the gcc cache land under the probe root, never in the worktree.
  const copy = run(
    "bash",
    [
      "-c",
      `tar cf - --exclude=node_modules --exclude=dist --exclude=.gcc-ts-bundler-vite -C ${JSON.stringify(projectRoot)} . | tar xf - -C ${JSON.stringify(probeDir)}`,
    ],
    probeDir,
  );
  if (copy.status !== 0) {
    return { error: `copy failed: ${copy.stderr}`, outDir: "", cacheDir: "" };
  }
  fs.symlinkSync(
    path.join(projectRoot, "node_modules"),
    path.join(probeDir, "node_modules"),
  );
  const outDir = path.join(probeDir, "dist");
  // The plugin does not take a cache dir from us, and defaults to the user
  // persistent cache root. Redirect that root into the probe so the sweep
  // never reads or writes shared cache state.
  const cacheHome = path.join(probeDir, "xdg-cache");
  fs.mkdirSync(cacheHome, { recursive: true });
  const outcome = run(
    path.join(projectRoot, "node_modules/.bin/vite"),
    ["build", "--config", example.viteConfig ?? "vite.config.ts", "--outDir", outDir, "--emptyOutDir"],
    probeDir,
    { XDG_CACHE_HOME: cacheHome },
  );
  return {
    error: outcome.status === 0 ? null : `${outcome.stdout}\n${outcome.stderr}`.trim(),
    outDir,
    // Both the plugin capture root and the redirected persistent cache.
    cacheDir: probeDir,
  };
}

// ---------------------------------------------------------------------------
// Artifact discovery
// ---------------------------------------------------------------------------

function walk(dir: string, predicate: (filePath: string) => boolean): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...walk(filePath, predicate));
    else if (predicate(filePath)) found.push(filePath);
  }
  return found;
}

/** Closure's bundled es3/es5/es6 externs: the language contract. */
function ecmaCoreNames(): Set<string> {
  const extractDir = path.join(PROBE_ROOT, ".closure-externs");
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
    run("bash", ["-c", `unzip -o -q ${JSON.stringify(CLOSURE_JAR)} externs.zip -d ${JSON.stringify(extractDir)} && cd ${JSON.stringify(extractDir)} && unzip -o -q externs.zip`], PROBE_ROOT);
  }
  const names = new Set<string>();
  for (const file of walk(extractDir, (f) => /\/(?:es\d[\w]*|asynccontext)\.js$/u.test(f))) {
    for (const name of extractExternPropertyNames(fs.readFileSync(file, "utf8"))) {
      names.add(name);
    }
  }
  return names;
}

/** Closure's bundled `browser/` externs: the platform set under --env BROWSER. */
function builtinBrowserNames(): Set<string> {
  const extractDir = path.join(PROBE_ROOT, ".closure-externs");
  const names = new Set<string>();
  for (const file of walk(extractDir, (f) => f.includes(`${path.sep}browser${path.sep}`))) {
    for (const name of extractExternPropertyNames(fs.readFileSync(file, "utf8"))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Probe caches are keyed by content hashes and rooted at a temp path, so the
 * raw path is neither stable across runs nor meaningful in a report. Anything
 * inside the probe root collapses to `<cache>/<basename>`; worktree files keep
 * their repo-relative path.
 */
function stableFileLabel(file: string) {
  const resolved = path.resolve(file);
  if (resolved.startsWith(path.resolve(PROBE_ROOT) + path.sep)) {
    return `<probe>/${path.basename(resolved)}`;
  }
  return path.relative(REPO_ROOT, resolved);
}

interface ChannelSource {
  channel: Channel;
  file: string;
  names: Set<string>;
}

function collectChannels(
  example: ExampleDescriptor,
  probe: { cacheDir: string; outDir: string },
): ChannelSource[] {
  const sources: ChannelSource[] = [];
  const push = (channel: Channel, file: string) => {
    if (!fs.existsSync(file)) return;
    sources.push({
      channel,
      file: stableFileLabel(file),
      names: extractExternPropertyNames(fs.readFileSync(file, "utf8")),
    });
  };

  const projectRoot = path.join(REPO_ROOT, "examples", example.dir);
  const declaredExterns: unknown = example.buildOptions?.["externs"];
  if (Array.isArray(declaredExterns)) {
    for (const relative of declaredExterns) {
      if (typeof relative === "string") {
        push("explicit", path.resolve(projectRoot, relative));
      }
    }
  }
  for (const file of walk(
    path.join(REPO_ROOT, "closure-externs"),
    (f) => f.endsWith(".js"),
  )) {
    push("package", file);
  }
  for (const file of walk(probe.cacheDir, (f) =>
    f.endsWith("native-generated.externs.js"),
  )) {
    push("native", file);
  }
  for (const file of walk(probe.cacheDir, (f) =>
    path.basename(f).startsWith("platform-externs."),
  )) {
    push("platform", file);
  }
  for (const file of walk(probe.cacheDir, (f) =>
    /(?:runtime-shared|runtime)\.externs\.js$/u.test(path.basename(f)),
  )) {
    push("runtime", file);
  }
  // Vite renders typed declarations into its capture root.
  for (const file of walk(probe.cacheDir, (f) =>
    /(?:generated|typed)[\w.-]*\.externs\.js$/u.test(path.basename(f)),
  )) {
    push("generated", file);
  }

  const usesSlice = sources.some((source) => source.channel === "platform");
  sources.push({
    channel: usesSlice ? "platform-builtin" : "platform",
    file: "<closure bundled browser externs>",
    names: builtinBrowserNames(),
  });
  const ecma = ecmaCoreNames();
  // `Owner.prototype.x` declares `x`, so the extractor never sees `prototype`
  // itself; it is a language name and is never renameable.
  for (const reserved of ["prototype", "__proto__", "constructor"]) {
    ecma.add(reserved);
  }
  sources.push({
    channel: "ecma-core",
    file: "<closure bundled es3/es5/es6 externs> + language names",
    names: ecma,
  });
  return sources;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface LedgerName {
  channels: string[];
  cost: number;
  firstOutputSite: string | null;
  firstInputSite: string | null;
  name: string;
  occurrences: number;
  primaryChannel: string;
}

interface ExampleLedger {
  channelTotals: Record<string, { cost: number; names: number }>;
  distinctOutputNames: number;
  error: string | null;
  externFiles: { channel: string; file: string; declaredNames: number }[];
  jobs: { renamed: number; report: string }[];
  keptOriginal: number;
  name: string;
  outputFiles: string[];
  renamedDistinct: number;
  renamedShareOfSeen: number;
  suspects: LedgerName[];
  topCost: LedgerName[];
}

/**
 * Where a kept-original name is first read in the program Closure actually
 * compiled (the native-emit output), which is a real access site — unlike the
 * output position, which is post-optimization.
 */
function indexInputSites(cacheDir: string): Map<string, string> {
  const sites = new Map<string, string>();
  // Only the emitted program: `native-generated.externs.js` sits beside it and
  // is a declaration file, not an access site.
  const inputs = walk(
    cacheDir,
    (f) =>
      f.includes(`${path.sep}native-emit${path.sep}`) &&
      f.includes(`${path.sep}out${path.sep}`) &&
      f.endsWith(".js"),
  );
  for (const file of inputs) {
    const source = fs.readFileSync(file, "utf8");
    const lineStarts = computeLineStarts(source);
    for (const match of blankLiterals(source).matchAll(/\.([A-Za-z_$][\w$]*)/gu)) {
      const name = match[1] ?? "";
      if (!name || sites.has(name)) continue;
      sites.set(name, `${inputLabel(file)}:${lineOf(lineStarts, match.index + 1)}`);
    }
  }
  return sites;
}

/**
 * Stable label for a renaming report. The job directory is a content hash, so
 * only the job class survives; jobs are numbered in discovery order instead.
 */
function reportLabel(file: string) {
  return file.includes("closure-jobs") ? "closure-jobs" : "final/raw";
}

/** `native-emit/<hash>/out/src/main.js` -> `out/src/main.js`. */
function inputLabel(file: string) {
  const marker = `${path.sep}native-emit${path.sep}`;
  const index = file.indexOf(marker);
  if (index < 0) return path.basename(file);
  const tail = file.slice(index + marker.length);
  const slash = tail.indexOf(path.sep);
  return slash < 0 ? tail : tail.slice(slash + 1);
}

function buildLedger(
  example: ExampleDescriptor,
  probe: { cacheDir: string; error: string | null; outDir: string },
  topCount: number,
): ExampleLedger {
  const empty: ExampleLedger = {
    channelTotals: {},
    distinctOutputNames: 0,
    error: probe.error,
    externFiles: [],
    jobs: [],
    keptOriginal: 0,
    name: example.name,
    outputFiles: [],
    renamedDistinct: 0,
    renamedShareOfSeen: 0,
    suspects: [],
    topCost: [],
  };
  if (probe.error) return empty;

  const outputFiles = walk(probe.outDir, (f) => f.endsWith(".js"));
  if (outputFiles.length === 0) {
    return { ...empty, error: "no .js outputs found in probe out dir" };
  }
  const outputs = outputFiles.map((filePath) => ({
    path: filePath,
    source: fs.readFileSync(filePath, "utf8"),
  }));
  const uses = extractOutputPropertyNames(outputs);

  // Persistent job cache first; a build whose cache mode is not persistent
  // still leaves the report Closure wrote in the job's `raw/` directory.
  const allReports = walk(probe.cacheDir, (f) =>
    f.endsWith("property-renaming-report.txt"),
  );
  const jobReports = allReports.filter((f) =>
    f.includes(`${path.sep}closure-jobs${path.sep}`),
  );
  const reports = jobReports.length > 0 ? jobReports : allReports;
  const renameOriginals = new Set<string>();
  const renameTargets = new Set<string>();
  const jobs: { renamed: number; report: string }[] = [];
  for (const report of reports) {
    const map = parseRenamingReport(fs.readFileSync(report, "utf8"));
    for (const [original, renamed] of map) {
      renameOriginals.add(original);
      renameTargets.add(renamed);
    }
    jobs.push({ renamed: map.size, report: reportLabel(report) });
  }
  jobs.sort((a, b) => a.report.localeCompare(b.report) || a.renamed - b.renamed);

  const channels = collectChannels(example, probe);
  const inputSites = indexInputSites(probe.cacheDir);

  // A name in the output that is not a renaming *target* survived verbatim.
  const keptOriginalNames = [...uses.keys()]
    .filter((name) => !renameTargets.has(name))
    .sort();

  const entries: LedgerName[] = keptOriginalNames.map((name) => {
    const use = uses.get(name);
    const matched = channels
      .filter((source) => source.names.has(name))
      .map((source) => source.channel);
    const ordered = CHANNEL_ORDER.filter((channel) => matched.includes(channel));
    return {
      channels: ordered,
      cost: (use?.count ?? 0) * name.length,
      firstInputSite: inputSites.get(name) ?? null,
      firstOutputSite: use?.firstSite ?? null,
      name,
      occurrences: use?.count ?? 0,
      primaryChannel: ordered[0] ?? SUSPECT,
    };
  });

  const channelTotals: Record<string, { cost: number; names: number }> = {};
  for (const entry of entries) {
    const bucket = (channelTotals[entry.primaryChannel] ??= {
      cost: 0,
      names: 0,
    });
    bucket.cost += entry.cost;
    bucket.names += 1;
  }

  const byCost = [...entries].sort(
    (a, b) => b.cost - a.cost || a.name.localeCompare(b.name),
  );
  const seen = renameOriginals.size + keptOriginalNames.length;

  return {
    channelTotals,
    distinctOutputNames: uses.size,
    error: null,
    externFiles: channels
      .map((source) => ({
        channel: source.channel,
        declaredNames: source.names.size,
        file: source.file,
      }))
      .sort(
        (a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file),
      ),
    jobs,
    keptOriginal: keptOriginalNames.length,
    name: example.name,
    outputFiles: outputFiles.map((f) => path.basename(f)).sort(),
    renamedDistinct: renameOriginals.size,
    renamedShareOfSeen: seen === 0 ? 0 : renameOriginals.size / seen,
    suspects: byCost
      .filter((entry) => entry.primaryChannel === SUSPECT)
      .slice(0, topCount),
    topCost: byCost.slice(0, topCount),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const CHANNEL_ABBREVIATION: Record<string, string> = {
  "ecma-core": "ecma",
  explicit: "explicit",
  generated: "generated",
  [SUSPECT]: "SUSPECT",
  native: "native",
  package: "package",
  platform: "platform",
  "platform-builtin": "plat-blt",
  runtime: "runtime",
};

function abbreviateChannel(channel: string) {
  return CHANNEL_ABBREVIATION[channel] ?? channel.slice(0, 9);
}

function pad(value: string | number, width: number) {
  return String(value).padStart(width);
}

function printTable(ledgers: ExampleLedger[], topCount: number) {
  const channelNames = [...CHANNEL_ORDER, SUSPECT];
  console.log("");
  console.log("PROPERTY LEDGER — externs-v3-boundary-model.md Part II §5");
  console.log("");
  console.log(
    "example".padEnd(18) +
      pad("names", 7) +
      pad("renamed", 9) +
      pad("kept", 6) +
      pad("renamed%", 10) +
      "  " +
      channelNames.map((c) => pad(abbreviateChannel(c), 10)).join(""),
  );
  for (const ledger of ledgers) {
    if (ledger.error) {
      console.log(ledger.name.padEnd(18) + "  ERROR: " + ledger.error.split("\n")[0]);
      continue;
    }
    console.log(
      ledger.name.padEnd(18) +
        pad(ledger.distinctOutputNames, 7) +
        pad(ledger.renamedDistinct, 9) +
        pad(ledger.keptOriginal, 6) +
        pad((ledger.renamedShareOfSeen * 100).toFixed(1) + "%", 10) +
        "  " +
        channelNames
          .map((c) => pad(ledger.channelTotals[c]?.names ?? 0, 10))
          .join(""),
    );
  }

  for (const ledger of ledgers) {
    if (ledger.error) continue;
    console.log("");
    console.log(`--- ${ledger.name}: top ${topCount} kept-original names by cost (occurrences x name length)`);
    console.log(
      "  " +
        "name".padEnd(34) +
        pad("occ", 5) +
        pad("cost", 7) +
        "  channel".padEnd(24) +
        "first input site",
    );
    for (const entry of ledger.topCost) {
      console.log(
        "  " +
          entry.name.slice(0, 33).padEnd(34) +
          pad(entry.occurrences, 5) +
          pad(entry.cost, 7) +
          ("  " + entry.primaryChannel).padEnd(24) +
          (entry.firstInputSite ?? entry.firstOutputSite ?? "-"),
      );
    }
    const suspectCost = ledger.channelTotals[SUSPECT]?.cost ?? 0;
    console.log(
      `  invalidation suspects: ${ledger.channelTotals[SUSPECT]?.names ?? 0} names, ${suspectCost} cost units`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const options: { example: string | null; json: string | null; top: number } = {
    example: null,
    json: null,
    top: 10,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--example") options.example = argv[++index] ?? null;
    else if (arg === "--json") options.json = argv[++index] ?? null;
    else if (arg === "--top") options.top = Number(argv[++index] ?? "10");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.example
    ? EXAMPLES.filter((example) => example.name === options.example)
    : EXAMPLES;
  if (selected.length === 0) {
    console.error(`unknown example: ${options.example}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(PROBE_ROOT, { recursive: true });
  ecmaCoreNames();

  const ledgers: ExampleLedger[] = [];
  for (const example of selected) {
    process.stderr.write(`building ${example.name}... `);
    const probe =
      example.kind === "vite" ? buildViteExample(example) : buildApiExample(example);
    const ledger = buildLedger(example, probe, options.top);
    process.stderr.write(ledger.error ? "FAILED\n" : "ok\n");
    ledgers.push(ledger);
  }

  printTable(ledgers, options.top);

  if (options.json) {
    const payload = {
      channelOrder: [...CHANNEL_ORDER, SUSPECT],
      closureVersion: readClosureVersion(),
      examples: ledgers,
      schema: 1,
    };
    fs.writeFileSync(options.json, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stderr.write(`wrote ${options.json}\n`);
  }
  if (ledgers.some((ledger) => ledger.error)) process.exitCode = 1;
}

function readClosureVersion() {
  try {
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    if (typeof packageJson === "object" && packageJson !== null) {
      const record: Record<string, unknown> = { ...packageJson };
      const dependencies: unknown = record["dependencies"];
      if (typeof dependencies === "object" && dependencies !== null) {
        const entries: Record<string, unknown> = { ...dependencies };
        const value: unknown = entries["google-closure-compiler"];
        if (typeof value === "string") return value;
      }
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

// Importable for unit checks; only the CLI entry point runs the sweep.
if (import.meta.main) {
  await main();
}
