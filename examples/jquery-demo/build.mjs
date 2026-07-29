import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, generateExterns } from "../../dist/index.mjs";

// ===========================================================================
// WHEN IS EACH EXTERN MODE ACTUALLY REQUIRED?
//
// Measured, not reasoned. The same app was built four ways and every
// interaction exercised in a browser (full matrix in the report; sizes are
// raw/gzip of dist/main.js):
//
//   A  boundary + runtime   86,599 / 31,881   everything works
//   B  boundary only        86,294 / 31,834   DEAD ON LOAD
//                                             `readyList.resolveWith` renamed
//   C  runtime only         85,587 / 31,800   loads, DOM works, `$.Deferred`
//                                             and every animation DEAD
//   D  neither              85,285 / 31,755   DEAD ON LOAD (same as B)
//
// So both files are load-bearing here, and they fail in different ways:
//
//   * Without RUNTIME-AWARE (B, D) the page never reaches first paint.
//     jQuery breaks its own internal dot-read of a key it built itself, so it
//     dies during `jQuery.ready` before any of this app's code runs. Nothing
//     the app does can avoid this -- it is the library miscompiling itself.
//
//   * Without BOUNDARY-AWARE (C) the page loads and instance methods are fine
//     -- `.hasClass`, `.on`, `.text`, `.append`, `.data` all work, because
//     jQuery is compiled in this same Closure job and Closure renames the
//     library's definition and this app's call site consistently. What breaks
//     is the *static* surface: `$.Deferred`, `$.when`. The emitter quotes
//     app-side static access (`$["Deferred"]`), which pins this side to the
//     literal name while the library side renames -- so the two stop agreeing.
//
// The polarity INVERTS when jQuery is not compiled. Loaded as a plain
// <script> with the app compiled against it as an external global, a probe
// showed boundary-aware becomes the only thing keeping the page alive
// (without it: `.on` renames to `.g`, dead on load), while runtime-aware is
// pointless -- jQuery is not in the Closure job, so nothing can rename its
// internals.
//
//   deployment shape          boundary-aware      runtime-aware
//   ----------------------    ----------------    ----------------
//   library compiled in       required (statics)  required (self-hazards)
//   library external script   required            useless
//
// ===========================================================================

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Extern set 1 of 2: BOUNDARY-AWARE — the app -> library ABI.
//
// EVIDENCE SOURCE: this app's TypeScript, type-checked against jquery's
// `.d.ts`. A name lands here only because `main.ts` actually reaches it
// through a jQuery contract.
//
// FAILURE IT PREVENTS: the app calling a renamed name on an object jQuery
// never renamed. jQuery ships as pre-minified vendor code whose own member
// names are already fixed; if Closure renames `hasClass` to `a` on the call
// site in `main.ts` while the jQuery object still answers to `hasClass`, the
// call resolves to `undefined` and the page throws.
//
// Note the scope: five names, derived from usage — not from jQuery's 761-member
// declared type surface. Pinning that surface instead cost +4,442 raw / +748
// gzip on this demo and returned 142 fewer properties to the renamer.
// ---------------------------------------------------------------------------
const boundaryExternsFile = path.join(
  projectRoot,
  "jquery.boundary.externs.js",
);
const boundary = await generateExterns({
  appEntryFiles: ["./main.ts"],
  mode: "boundary-aware",
  modules: ["jquery"],
  outputFile: boundaryExternsFile,
  projectRoot,
  srcDir: ".",
});

// ---------------------------------------------------------------------------
// Extern set 2 of 2: RUNTIME-AWARE — jQuery's own internal hazards.
//
// EVIDENCE SOURCE: `node_modules/jquery/dist/jquery.js` itself — the shipped
// library body, not its declarations. The app is not consulted at all.
//
// FAILURE IT PREVENTS: jQuery breaking its own internal dot-read of a key it
// built at runtime. Two classes appear here:
//
//   * concatenated keys — `deferred[tuple[0] + "With"] = list.fireWith`
//     (jquery.js:3705) defines `resolveWith` through a key Closure cannot see,
//     and `readyList.resolveWith(document, [jQuery])` (jquery.js:3844) reads it
//     back with a plain dot. Only the dot side renames, so the page dies with
//     `TypeError: <x>.ga is not a function` on first paint;
//   * string-keyed private state — `dataPriv.get(elem, "events")` reads a
//     member jQuery's own code writes with dot syntax, which is why the data
//     helpers are declared as key-read protocol callees below.
//
// NEITHER SET IS A SUPERSET OF THE OTHER, and the assertion below proves it on
// every build. They are answers to different questions: boundary-aware asks
// "what does the app call?", runtime-aware asks "what does the library call on
// itself?". A name the app never touches (`fireWith`) still has to survive; a
// name the app calls constantly (`hasClass`) is not an internal hazard at all.
// ---------------------------------------------------------------------------
const runtimeExternsFile = path.join(projectRoot, "jquery.runtime.externs.js");
const runtime = await generateExterns({
  appEntryFiles: ["./main.ts"],
  mode: "runtime-aware",
  modules: ["jquery"],
  outputFile: runtimeExternsFile,
  projectRoot,
  protocolHelpers: {
    keyExclusionListCallees: [],
    keyReadCallees: ["access", "data", "get"],
  },
  runtimeEntryFiles: ["./node_modules/jquery/dist/jquery.js"],
  srcDir: ".",
});

// ---------------------------------------------------------------------------
// The claim above, checked. Parsed back out of the emitted files rather than
// read off the in-memory result, so this also catches a rendering bug.
// ---------------------------------------------------------------------------
async function readExternNames(file) {
  const text = await fs.readFile(file, "utf8");
  return new Set(
    [
      ...text.matchAll(
        /^Object\.prototype(?:\.([A-Za-z_$][\w$]*)|\["([^"]+)"\])\s*;/gmu,
      ),
    ].map((match) => match[1] ?? match[2]),
  );
}

const boundaryNames = await readExternNames(boundaryExternsFile);
const runtimeNames = await readExternNames(runtimeExternsFile);
const overlap = [...boundaryNames].filter((name) => runtimeNames.has(name));

if (boundaryNames.size === 0 || runtimeNames.size === 0) {
  console.error(
    `Expected both extern sets to be non-empty, got boundary=${boundaryNames.size} runtime=${runtimeNames.size}. ` +
      `An empty set means the corresponding evidence source stopped being read.`,
  );
  process.exit(1);
}

if (overlap.length > 0) {
  console.error(
    `Extern sets are no longer disjoint: ${overlap.join(", ")}.\n` +
      `Boundary-aware pins what the app calls on jQuery; runtime-aware pins what jQuery calls on itself. ` +
      `A shared name means one of the two analyses has started answering the other's question, ` +
      `and the demo no longer shows that both are required.`,
  );
  process.exit(1);
}

console.log(
  `Externs: boundary ${boundaryNames.size} names (app->lib ABI) and ` +
    `runtime ${runtimeNames.size} names (lib self-hazards), 0 overlap.`,
);

// Cheap sanity that the accounting agrees with the files on disk.
if (boundary.renameBarriers.propertyNames.length !== boundaryNames.size) {
  console.error("Boundary barrier accounting disagrees with the emitted file.");
  process.exit(1);
}
if (runtime.renameBarriers.propertyNames.length !== runtimeNames.size) {
  console.error("Runtime barrier accounting disagrees with the emitted file.");
  process.exit(1);
}

// Two generated files, no hand-written third. jQuery's self-referential
// `easing._default: "swing"` key is now derived by the runtime-aware analyzer's
// sibling-key rule (a string-literal value naming a sibling key of the same
// object literal); see the `swing` line in the runtime file and the audit test
// "the sibling-key rule fires exactly once across real jquery.js".
const result = await build({
  cache: { mode: "off" },
  diagnostics: { preflight: "full" },
  entries: ["./main.ts"],
  externs: [
    "./jquery.boundary.externs.js",
    "./jquery.runtime.externs.js",
  ],
  outDir: "./dist",
  projectRoot,
  srcDir: ".",
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
  `Built jQuery demo to ${path.relative(projectRoot, result.outputFiles[0] ?? "./dist/main.js")}`,
);
console.log(
  `Generated externs at ${path.relative(projectRoot, boundaryExternsFile)} and ${path.relative(projectRoot, runtimeExternsFile)}`,
);
