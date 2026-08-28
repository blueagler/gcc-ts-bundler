import fs from "fs/promises";

import type { ResolvedBuildOptions } from "../../build/types";
import { generateExterns } from "../index";
import { isPlatformBuiltin, resolveModuleTypeEntry } from "../compiler";
import type { TypeWorld } from "../context";
import {
  renderTypedBoundaryRecord,
  type TypedBoundaryRecord,
} from "../typed-render";

type GeneratedExternalExterns = Awaited<ReturnType<typeof generateExterns>>;

export interface ExternalExternPlan {
  opaqueSpecifiers: string[];
  typedResolutions: Array<{
    generated: GeneratedExternalExterns;
    specifier: string;
  }>;
}

export async function deriveExternalExternPlan(input: {
  /** Workspace-staged files that actually populate the type world. Authored
   * entry paths are not program members, so scanning those finds no imports
   * and every `exports: "used"` surface renders empty. */
  appEntryFiles: readonly string[];
  options: ResolvedBuildOptions;
  specifiers: string[];
  typeWorld: TypeWorld;
}): Promise<ExternalExternPlan> {
  const specifiers = selectExternCandidateSpecifiers(
    input.specifiers,
    input.options.target === "browser",
  );
  if (specifiers.length === 0) {
    return { opaqueSpecifiers: [], typedResolutions: [] };
  }

  const probed = await probeSpecifierDeclarations(input, specifiers);
  const opaqueSpecifiers = collectUnresolvedOpaqueSpecifiers(probed);
  const typedResolutions: ExternalExternPlan["typedResolutions"] = [];
  const typedSpecifiers = probed
    .filter(({ typed }) => typed)
    .map(({ specifier }) => specifier);
  if (typedSpecifiers.length === 0) {
    return { opaqueSpecifiers, typedResolutions };
  }

  try {
    const resolved = await resolveTypedExternSurfaces(input, typedSpecifiers);
    opaqueSpecifiers.push(...resolved.opaqueSpecifiers);
    typedResolutions.push(...resolved.typedResolutions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const specifier of typedSpecifiers) {
      opaqueSpecifiers.push(specifier);
      warnOpaqueExtern(specifier, message);
    }
  }
  return { opaqueSpecifiers, typedResolutions };
}

/**
 * Browser builds reject builtins outright. Every other target *preserves* them
 * as runtime imports, so members read off the preserved namespace still need
 * typed externs, or Closure renames them against a module it never compiled.
 */
function selectExternCandidateSpecifiers(
  specifiers: readonly string[],
  dropBuiltins: boolean,
): string[] {
  return [...new Set(specifiers)]
    .filter((specifier) => !dropBuiltins || !isPlatformBuiltin(specifier))
    .sort((left, right) => left.localeCompare(right));
}

interface ProbedSpecifier {
  specifier: string;
  typed: boolean;
}

/**
 * Resolve each declaration entry independently. `generateExterns` throws on the
 * first unresolvable specifier, so probing as a batch would let one builtin
 * with no installed types force every other module opaque.
 */
async function probeSpecifierDeclarations(
  input: { options: ResolvedBuildOptions; typeWorld: TypeWorld },
  specifiers: readonly string[],
): Promise<ProbedSpecifier[]> {
  return Promise.all(
    specifiers.map(async (specifier) => ({
      specifier,
      typed: await hasResolvableDeclarations({
        compilerOptions: input.typeWorld.compilerOptions,
        projectRoot: input.options.projectRoot,
        specifier,
        target: input.options.target,
      }),
    })),
  );
}

function collectUnresolvedOpaqueSpecifiers(
  probed: readonly ProbedSpecifier[],
): string[] {
  const opaqueSpecifiers: string[] = [];
  for (const { specifier, typed } of probed) {
    if (typed) continue;
    opaqueSpecifiers.push(specifier);
    // A builtin without installed platform types is ordinary, not a defect.
    if (isPlatformBuiltin(specifier)) continue;
    warnOpaqueExtern(specifier);
  }
  return opaqueSpecifiers;
}

async function resolveTypedExternSurfaces(
  input: {
    appEntryFiles: readonly string[];
    options: ResolvedBuildOptions;
    typeWorld: TypeWorld;
  },
  typedSpecifiers: readonly string[],
): Promise<ExternalExternPlan> {
  const generated = await generateExterns({
    appEntryFiles: [...input.appEntryFiles],
    includeDependencies: false,
    // These specifiers stay runtime-owned: Closure never compiles them, so
    // their declarations exist to name the boundary, not to describe it. The
    // unbounded closure of one used export reaches the whole dependency's type
    // graph — 51 MB / 875,460 lines for this repo's own three externals — and
    // every name in it also becomes an unrenamable property program-wide.
    maxSymbolDepth: 0,
    // Depth 0 emits seed exports only: measured against depth 1 (32.8 MB /
    // 561K lines), ingestion cost tracks declaration count, not type detail
    // — a barriers-plus-declarations floor parses in ~0s vs ~13s per job.
    mode: "boundary-aware",
    modules: typedSpecifiers.map((specifier) => ({
      exports: "used",
      runtime: "external",
      specifier,
    })),
    projectRoot: input.options.projectRoot,
    srcDir: input.options.srcDir,
    target: input.options.target,
    typeWorld: input.typeWorld,
  });
  const partitioned = partitionGeneratedTypedSurfaces(
    generated,
    typedSpecifiers,
  );
  warnGeneratedExternDiagnostics(generated);
  return partitioned;
}

/**
 * Declarations can resolve while the generated boundary still carries no module
 * surface for the specifier, which leaves that specifier opaque.
 */
function partitionGeneratedTypedSurfaces(
  generated: GeneratedExternalExterns,
  typedSpecifiers: readonly string[],
): ExternalExternPlan {
  const opaqueSpecifiers: string[] = [];
  const typedResolutions: ExternalExternPlan["typedResolutions"] = [];
  for (const specifier of typedSpecifiers) {
    const hasModuleSurface = generated.typedDeclarations.moduleExports.some(
      (module) => module.specifier === specifier,
    );
    if (hasModuleSurface) {
      typedResolutions.push({ generated, specifier });
      continue;
    }
    opaqueSpecifiers.push(specifier);
    warnOpaqueExtern(specifier, "no declaration module surface was produced");
  }
  return { opaqueSpecifiers, typedResolutions };
}

function warnGeneratedExternDiagnostics(generated: GeneratedExternalExterns) {
  for (const warning of generated.warnings) {
    console.warn(`gcc-ts-bundler: ${warning}`);
  }
  for (const warning of generated.barrierWarnings) {
    console.warn(`gcc-ts-bundler: ${warning.message}`);
  }
}

function warnOpaqueExtern(specifier: string, detail?: string) {
  const reason =
    detail === undefined
      ? "declarations could not be resolved"
      : `declarations could not be resolved: ${detail}`;
  console.warn(
    `gcc-ts-bundler: using opaque externs for external module ${JSON.stringify(specifier)} because ${reason}`,
  );
}

async function hasResolvableDeclarations(input: {
  compilerOptions: TypeWorld["compilerOptions"];
  projectRoot: string;
  specifier: string;
  target: ResolvedBuildOptions["target"];
}) {
  try {
    const resolved = await resolveModuleTypeEntry(input);
    return resolved.declarationEntry.length > 0;
  } catch {
    return false;
  }
}

const BOUNDARY_IDENTIFIER = /^[$A-Z_a-z][$\w]*$/u;

export async function appendExternalTypedExterns(input: {
  externsPath: string;
  imports: Array<{
    boundaryExports: string[];
    boundaryNames: string[];
    externalSpecifier?: string | undefined;
  }>;
  typedResolutions: ExternalExternPlan["typedResolutions"];
}) {
  const seenTargets = new Set<string>();
  const typedDeclaredNames = new Set<string>();
  const typedTexts = input.typedResolutions.map(({ generated, specifier }) => {
    const moduleSurface = generated.typedDeclarations.moduleExports.find(
      (module) => module.specifier === specifier,
    );
    const boundaryLines = input.imports
      .filter((item) => item.externalSpecifier === specifier)
      .flatMap((item) =>
        item.boundaryExports.flatMap((exportName, index) => {
          const boundaryName = item.boundaryNames[index];
          if (!boundaryName || !moduleSurface) return [];
          if (exportName === "*") {
            return moduleSurface.exports
              .filter(({ exportName: name }) => BOUNDARY_IDENTIFIER.test(name))
              .flatMap((exported) =>
                takeTypedBoundaryRecord(
                  renderTypedBoundaryRecord(
                    exported,
                    `${boundaryName}.${exported.exportName}`,
                    false,
                  ),
                  seenTargets,
                  typedDeclaredNames,
                ),
              );
          }
          const exported = moduleSurface.exports.find(
            (item) => item.exportName === exportName,
          );
          return exported
            ? takeTypedBoundaryRecord(
                renderTypedBoundaryRecord(exported, boundaryName),
                seenTargets,
                typedDeclaredNames,
              )
            : [];
        }),
      );
    return `${generated.typedDeclarations.text}\n// Exact typed external boundaries.\n${boundaryLines.join("\n")}\n`;
  });
  if (typedTexts.length === 0) return;
  const existing = await fs.readFile(input.externsPath, "utf8");
  const assembled = `${stripUntypedBoundaryDeclarations(existing, typedDeclaredNames)}\n// Typed external runtime declarations.\n${typedTexts.join("\n")}`;
  assertUniqueExternVarDeclarations(assembled, input.externsPath);
  await fs.writeFile(input.externsPath, assembled, "utf8");
}

/**
 * Whole-file post-condition on the assembled extern file: every uninitialized
 * boundary declaration (`var X;`, bare or JSDoc-annotated) appears exactly
 * once. The file has two producers (the native emitter and this typed append
 * step); a duplicate declaration is
 * `JSC_VAR_MULTIPLY_DECLARED_ERROR`, which normal builds mask at their warning
 * level — so it must fail closed here, at assembly, not surface only under
 * `GCC_DISABLE_TYPE_INFERENCE=1`. Initialized namespace roots
 * (`var __gccExtern$… = {};`) legitimately repeat across typed sections and
 * are exempt.
 */
function assertUniqueExternVarDeclarations(text: string, externsPath: string) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^(?:\/\*\*.*\*\/\s*)?var ([$A-Za-z_][$\w]*);$/u.exec(
      line.trim(),
    );
    const name = match?.[1];
    if (name === undefined) continue;
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  if (duplicated.size === 0) return;
  throw new Error(
    `gcc-ts-bundler: assembled externs at ${externsPath} declare ${[...duplicated].sort().join(", ")} more than once; every producer must declare each boundary variable exactly once.`,
  );
}

function takeTypedBoundaryRecord(
  record: TypedBoundaryRecord,
  seenTargets: Set<string>,
  typedDeclaredNames: Set<string>,
) {
  if (record.lines.length === 0 || seenTargets.has(record.target)) return [];
  seenTargets.add(record.target);
  if (record.declaredName) typedDeclaredNames.add(record.declaredName);
  return record.lines;
}

function stripUntypedBoundaryDeclarations(
  text: string,
  names: ReadonlySet<string>,
) {
  if (names.size === 0) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    const untypedVar = untypedVarDeclarationName(trimmed);
    if (untypedVar !== undefined && names.has(untypedVar)) continue;
    if (startsStrippedBoundaryPair(trimmed, lines[index + 1], names)) {
      index += 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
/**
 * True when `trimmed` is a bare unknown-type JSDoc line whose following line
 * declares a boundary var being stripped. The declaration spans two lines, so
 * the caller consumes both.
 */
function startsStrippedBoundaryPair(
  trimmed: string,
  next: string | undefined,
  names: ReadonlySet<string>,
) {
  if (trimmed !== "/** @type {?} */" || next === undefined) return false;
  const nextName = bareVarDeclarationName(next.trim());
  return nextName !== undefined && names.has(nextName);
}

function untypedVarDeclarationName(trimmed: string) {
  const prefix = "/** @type {?} */ var ";
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(";")) return undefined;
  const name = trimmed.slice(prefix.length, -1);
  return BOUNDARY_IDENTIFIER.test(name) ? name : undefined;
}

function bareVarDeclarationName(trimmed: string) {
  const prefix = "var ";
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(";")) return undefined;
  const name = trimmed.slice(prefix.length, -1);
  return BOUNDARY_IDENTIFIER.test(name) ? name : undefined;
}
