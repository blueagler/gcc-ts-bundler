import fs from "fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";

import type { ResolvedBuildOptions } from "../../build/types";
import { ensureParentDirectory } from "../../shared/files";
import { generateExterns } from "../index";
import { isPlatformBuiltin, resolveModuleTypeEntry } from "../compiler";
import type { TypeWorld } from "../context";
import type {
  GeneratedExternExport,
  GeneratedTypedExternArtifact,
} from "../types";
import { renderTypedBoundaryDeclaration } from "../typed-render";

type GeneratedExternalExterns = Awaited<ReturnType<typeof generateExterns>>;

export interface ExternalExternPlan {
  opaqueSpecifiers: string[];
  typedDeclarations?: GeneratedTypedExternArtifact | undefined;
}

export async function probeExternalExternSpecifiers(input: {
  compilerOptions: ts.CompilerOptions;
  options: ResolvedBuildOptions;
  specifiers: readonly string[];
}): Promise<{ opaqueSpecifiers: string[]; typedSpecifiers: string[] }> {
  const specifiers = selectExternCandidateSpecifiers(
    input.specifiers,
    input.options.target === "browser",
  );
  if (specifiers.length === 0) {
    return { opaqueSpecifiers: [], typedSpecifiers: [] };
  }

  const probed = await probeSpecifierDeclarations(input, specifiers);
  return {
    opaqueSpecifiers: collectUnresolvedOpaqueSpecifiers(probed),
    typedSpecifiers: probed
      .filter(({ typed }) => typed)
      .map(({ specifier }) => specifier),
  };
}

export async function deriveExternalExternPlan(input: {
  /** Workspace-staged files that actually populate the type world. Authored
   * entry paths are not program members, so scanning those finds no imports
   * and every `exports: "used"` surface renders empty. */
  appEntryFiles: readonly string[];
  options: ResolvedBuildOptions;
  opaqueSpecifiers: readonly string[];
  typedSpecifiers: readonly string[];
  typeWorld?: TypeWorld | undefined;
}): Promise<ExternalExternPlan> {
  if (input.typedSpecifiers.length === 0) {
    return { opaqueSpecifiers: [...input.opaqueSpecifiers] };
  }

  try {
    const resolved = await resolveTypedExternSurfaces(
      input,
      input.typedSpecifiers,
    );
    return {
      opaqueSpecifiers: [
        ...input.opaqueSpecifiers,
        ...resolved.opaqueSpecifiers,
      ],
      typedDeclarations: resolved.typedDeclarations,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const opaqueSpecifiers = [...input.opaqueSpecifiers];
    for (const specifier of input.typedSpecifiers) {
      opaqueSpecifiers.push(specifier);
      warnOpaqueExtern(specifier, message);
    }
    return { opaqueSpecifiers };
  }
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
  input: {
    compilerOptions: ts.CompilerOptions;
    options: ResolvedBuildOptions;
  },
  specifiers: readonly string[],
): Promise<ProbedSpecifier[]> {
  const resolutionCache = ts.createModuleResolutionCache(
    input.options.projectRoot,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    input.compilerOptions,
  );
  return Promise.all(
    specifiers.map(async (specifier) => ({
      specifier,
      typed: await hasResolvableDeclarations({
        compilerOptions: input.compilerOptions,
        projectRoot: input.options.projectRoot,
        resolutionCache,
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
    typeWorld?: TypeWorld | undefined;
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
  for (const specifier of typedSpecifiers) {
    const hasModuleSurface = generated.typedDeclarations.moduleExports.some(
      (module) => module.specifier === specifier,
    );
    if (hasModuleSurface) continue;
    opaqueSpecifiers.push(specifier);
    warnOpaqueExtern(specifier, "no declaration module surface was produced");
  }
  return { opaqueSpecifiers, typedDeclarations: generated.typedDeclarations };
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
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  resolutionCache: ts.ModuleResolutionCache;
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

/**
 * Native externs are a published cache artifact. Assemble the Closure-only typed
 * channel in caller-owned invocation scratch without ever rewriting that input.
 */
export async function assembleExternalExterns(input: {
  externsPath: string;
  imports: readonly {
    boundaryExports: readonly string[];
    boundaryNames: readonly string[];
    externalSpecifier?: string | undefined;
  }[];
  plan: ExternalExternPlan;
  outputPath: string;
}): Promise<string> {
  const typed = input.plan.typedDeclarations;
  if (!typed || typed.moduleExports.length === 0) return input.externsPath;
  if (path.resolve(input.outputPath) === path.resolve(input.externsPath)) {
    throw new Error("Assembled externs must not overwrite native externs.");
  }

  const modules = new Map(
    typed.moduleExports.map((surface) => [surface.specifier, surface]),
  );
  const seenTargets = new Set<string>();
  const typedDeclaredNames = new Set<string>();
  const boundaryLines: string[] = [];
  const take = (
    exported: GeneratedExternExport,
    target: string,
    declareVariable = true,
  ) => {
    const lines = renderTypedBoundaryDeclaration(
      exported,
      target,
      declareVariable,
    );
    if (lines.length === 0 || seenTargets.has(target)) return;
    seenTargets.add(target);
    if (
      declareVariable &&
      exported.kind !== "type" &&
      BOUNDARY_IDENTIFIER.test(target)
    ) {
      typedDeclaredNames.add(target);
    }
    boundaryLines.push(...lines);
  };
  for (const item of input.imports) {
    const surface = item.externalSpecifier
      ? modules.get(item.externalSpecifier)
      : undefined;
    if (!surface) continue;
    for (const [index, exportName] of item.boundaryExports.entries()) {
      const boundaryName = item.boundaryNames[index];
      if (!boundaryName) continue;
      if (exportName === "*") {
        for (const exported of surface.exports) {
          if (!BOUNDARY_IDENTIFIER.test(exported.exportName)) continue;
          take(exported, `${boundaryName}.${exported.exportName}`, false);
        }
      } else {
        const exported = surface.exports.find(
          (candidate) => candidate.exportName === exportName,
        );
        if (exported) {
          take(exported, boundaryName);
        }
      }
    }
  }

  const existing = await fs.readFile(input.externsPath, "utf8");
  const nativeText = stripReplacedBoundaryDeclarations(
    existing,
    typedDeclaredNames,
    seenTargets,
  );
  const assembled = [
    nativeText,
    "// Typed external runtime declarations.",
    typed.text,
    "// Exact typed external boundaries.",
    ...boundaryLines,
    "",
  ].join("\n");
  assertUniqueExternVarDeclarations(assembled, input.outputPath);
  await ensureParentDirectory(input.outputPath);
  await fs.writeFile(input.outputPath, assembled, "utf8");
  return input.outputPath;
}

/**
 * Replace only declarations for exact typed targets. Namespace roots are not
 * declared by member records, and unrelated property carriers remain additive.
 * Parse statements rather than making native JSDoc/initializer spelling an API.
 */
function stripReplacedBoundaryDeclarations(
  text: string,
  declaredNames: ReadonlySet<string>,
  targets: ReadonlySet<string>,
) {
  const source = ts.createSourceFile(
    "native.externs.js",
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const kept: string[] = [];
  let cursor = 0;
  for (const statement of source.statements) {
    const declarations = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : undefined;
    const replacedVariable =
      declarations?.length === 1 &&
      declarations.every(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaredNames.has(declaration.name.text),
      );
    const replacedMember =
      ts.isExpressionStatement(statement) &&
      ts.isPropertyAccessExpression(statement.expression) &&
      targets.has(statement.expression.getText(source));
    if (!replacedVariable && !replacedMember) continue;
    kept.push(text.slice(cursor, statement.getStart(source, true)));
    cursor = statement.end;
  }
  kept.push(text.slice(cursor));
  return kept.join("");
}

/** Every variable, including initialized namespace roots and constructors, has
 * exactly one producer in the complete Closure artifact. */
function assertUniqueExternVarDeclarations(text: string, externsPath: string) {
  const source = ts.createSourceFile(
    externsPath,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (seen.has(name)) duplicated.add(name);
      seen.add(name);
    }
  }
  if (duplicated.size === 0) return;
  throw new Error(
    `gcc-ts-bundler: assembled externs at ${externsPath} declare ${[...duplicated].sort().join(", ")} more than once; every producer must declare each boundary variable exactly once.`,
  );
}
