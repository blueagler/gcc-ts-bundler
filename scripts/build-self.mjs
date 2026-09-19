import { runCommand, runTasksInParallel } from "./command.mjs";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import ts from "@typescript/typescript6";
import { hostNativeTarget, validateNativePackage } from "./native-targets.mjs";
import {
  countInternalWork,
  withInternalBuildProfile,
  withInternalTiming,
} from "../src/shared/timing.ts";

await withInternalBuildProfile("selfbuild", async () => {
  const gzipAsync = promisify(gzip);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== "--native-package")
  ) {
    throw new Error("Usage: build-self.mjs [--native-package directory]");
  }
  const packageManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const publicSpecifiers = Object.keys(packageManifest.exports).map(
    (specifier) =>
      specifier === "."
        ? packageManifest.name
        : `${packageManifest.name}/${specifier.slice(2)}`,
  );
  const runtimeExternals = [
    "@typescript/typescript6",
    "google-closure-compiler",
    "vite",
  ];
  const preservedModules = ["src/native/load.ts"];
  /**
   * Declaration sources whose property names must survive ADVANCED property
   * renaming in the self-build.
   *
   * Objects handed over by the napi addon, and objects revived from sidecar
   * or content-snapshot JSON, keep their boundary property names at runtime.
   * The self-compiled bundler reads them through renamed accessors, so any
   * boundary property that is not pinned reads back `undefined`. Writing a
   * boundary object as an explicit literal only keeps the write and the read
   * consistent with each other; it does not pin the JSON/napi spelling.
   *
   * `roots: "all"` takes every type the file declares. An array names the entry
   * types; same-file references from those entries are followed. Types in a
   * listed file that the boundary does not reach are left unpinned.
   */
  const boundaryDeclarationSources = [
    { path: "src/native/abi.ts", roots: "all" },
    { path: "src/shared/file-state.ts", roots: ["ContentIdentity"] },
    {
      path: "src/build/types.ts",
      roots: ["BuildTypeMetadataSidecar", "PreservedImport"],
    },
    {
      path: "src/build/transpile/type-metadata/types.ts",
      roots: [
        "ClosureAnnotation",
        "ClosureEnumDeclaration",
        "ClosureTypeDeclaration",
        "ClosureTypeMetadataFile",
        "ClosureTypeReference",
        "ClosureTypeSymbol",
        "TypeMetadataCounts",
        "TypeMetadataDiagnostic",
      ],
    },
  ];
  /**
   * Boundary reads that already broke: sidecar.extractedCounts was renamed away,
   * and serialized content digests stopped matching their runtime validators
   * when unrelated Node externs no longer happened to pin `digest`. Fail the
   * self-build rather than rely on incidental properties from platform types.
   */
  const requiredBoundaryNames = [
    "annotationCount",
    "counts",
    "digest",
    "extractedCounts",
    "files",
    "typeMetadata",
  ];
  const libraryEntries = Object.entries(packageManifest.exports).map(
    ([specifier, conditions]) => {
      const outputPath = conditions.default;
      if (typeof outputPath !== "string" || !outputPath.startsWith("./dist/")) {
        throw new Error(`Unsupported package export output for ${specifier}`);
      }
      const name = outputPath.slice("./dist/".length);
      return {
        file: name.replace(/\.mjs$/u, ".ts"),
        name,
        specifier:
          specifier === "."
            ? packageManifest.name
            : `${packageManifest.name}/${specifier.slice(2)}`,
      };
    },
  );
  const cliOutputRelative = Object.values(packageManifest.bin)[0];
  if (
    typeof cliOutputRelative !== "string" ||
    !cliOutputRelative.startsWith("bin/")
  ) {
    throw new Error("Unsupported package bin output");
  }
  const packageEntries = (stageRoot) => [
    ...libraryEntries.map(({ file, name }) => ({ file, name })),
    {
      file: "cli/main.ts",
      name: "gcc-ts-bundler.mjs",
      outFile: path.join(stageRoot, cliOutputRelative),
    },
  ];
  const generatedPackageRoots = new Set(
    [
      packageManifest.types,
      ...Object.values(packageManifest.exports).flatMap((conditions) =>
        Object.values(conditions),
      ),
      ...Object.values(packageManifest.bin),
    ].map(packagePathRoot),
  );
  const runtimeAssetExtensions = new Set([
    ".cjs",
    ".java",
    ".js",
    ".json",
    ".mjs",
    ".node",
    ".wasm",
  ]);

  /**
   * Build-lane knobs. The default build is stage-1 only: the published bytes
   * are always stage-1, so a single self-compile already produces the exact
   * artifact shape that ships.
   *
   * Stage-2 exists only to prove the
   * compiler is a fixpoint (compiling the compiler with itself twice yields
   * byte-identical output), and it costs a second full ADVANCED compile —
   * measured 155s of a 363s build, 43% of wall time. That proof runs in the
   * verify lane (`bun run verify:selfbuild`, which sets GCC_SELFBUILD_STAGES=2)
   * and during release preparation, not on every build.
   */
  const fixpointStages = (() => {
    const requested = process.env.GCC_SELFBUILD_STAGES ?? "1";
    if (requested !== "1" && requested !== "2") {
      throw new Error(
        `GCC_SELFBUILD_STAGES must be "1" or "2", received ${JSON.stringify(requested)}`,
      );
    }
    return Number(requested);
  })();
  const selfBuildCacheMode = (() => {
    const requested = process.env.GCC_SELFBUILD_CACHE ?? "off";
    if (requested !== "off" && requested !== "persistent") {
      throw new Error(
        `GCC_SELFBUILD_CACHE must be "off" or "persistent", received ${JSON.stringify(requested)}`,
      );
    }
    return requested;
  })();

  if (args.length) {
    validateNativePackage(
      JSON.parse(await readFile(path.resolve(args[1], "package.json"), "utf8")),
      hostNativeTarget(),
      packageManifest,
    );
  }
  const runtimeAssets = await withInternalTiming(
    "selfbuild:discover-assets",
    discoverRuntimePackageAssets,
  );
  const boundaryExterns = await withInternalTiming(
    "selfbuild:native-boundary-externs",
    generateBoundaryExterns,
  );
  const temporaryRoot = await withInternalTiming(
    "selfbuild:temporary-root",
    () => mkdtemp(path.join(os.tmpdir(), "gcc-selfbuild-")),
  );
  const stage0 = path.join(temporaryRoot, "stage-0");
  try {
    await withInternalTiming("selfbuild:bootstrap-preparation", () =>
      runTasksInParallel([
        () =>
          withInternalTiming("selfbuild:native", () =>
            args.length
              ? cp(
                  path.resolve(args[1], "index.node"),
                  path.join(root, "native", "index.node"),
                )
              : runCommand(process.execPath, ["./scripts/build-native.mjs"], {
                  cwd: root,
                  label: "selfbuild:native",
                }),
          ),
        () =>
          withInternalTiming("selfbuild:bootstrap", () =>
            runCommand(process.execPath, ["./scripts/build-js.mjs", stage0], {
              cwd: root,
              label: "selfbuild:bootstrap",
            }),
          ),
      ]),
    );
    await withInternalTiming("selfbuild:prepare-stage-0", () =>
      prepareStageRoot(stage0),
    );

    const stage1 = path.join(temporaryRoot, "stage-1");
    await withInternalTiming("selfbuild:stage-1", () =>
      buildStage(path.join(stage0, "dist/index.mjs"), stage1, "stage-1"),
    );
    if (fixpointStages === 2) {
      const stage2 = path.join(temporaryRoot, "stage-2");
      await withInternalTiming("selfbuild:stage-2", () =>
        buildStage(path.join(stage1, "dist/index.mjs"), stage2, "stage-2"),
      );
      await withInternalTiming("selfbuild:fixpoint", () =>
        assertTreesEqual(stage1, stage2),
      );
      console.log(
        "Self-build fixpoint: stage-1 and stage-2 are byte-identical.",
      );
    } else {
      console.log(
        "Self-build: stage-1 only — the published artifact shape. The byte-identity fixpoint is verified by `bun run verify:selfbuild` and `bun run prepare:release`, not on every build.",
      );
    }
    await withInternalTiming("selfbuild:size-report", () =>
      printSizeReport(stage0, stage1),
    );
    await withInternalTiming("selfbuild:publish", () => publishStage(stage1));
  } finally {
    await withInternalTiming("selfbuild:cleanup", () =>
      rm(temporaryRoot, { force: true, recursive: true }),
    );
  }

  async function buildStage(compilerPath, stageRoot, label) {
    await withInternalTiming("selfbuild:prepare-stage", () =>
      prepareStageRoot(stageRoot),
    );
    await withInternalTiming("selfbuild:copy-declarations-before", () =>
      copyBootstrapDeclarations(path.join(stageRoot, "dist")),
    );
    const compiler = await withInternalTiming(
      "selfbuild:load-compiler",
      () =>
        import(
          `${pathToFileURL(compilerPath).href}?selfbuild=${encodeURIComponent(label)}`
        ),
    );
    const typedExternPath = path.join(stageRoot, "public-api.typed.externs.js");
    const sourceEntries = new Map(
      libraryEntries.map(({ file, specifier }) => [
        specifier,
        path.join(root, "src", file),
      ]),
    );
    const boundaryExternPath = path.join(
      stageRoot,
      "native-boundary.externs.js",
    );
    await writeFile(boundaryExternPath, boundaryExterns);
    const externResult = await withInternalTiming(
      "selfbuild:public-externs",
      () =>
        compiler.generateExterns({
          modules: publicSpecifiers.map((specifier) => ({
            exports: "all",
            runtime: "external",
            specifier,
          })),
          projectRoot: stageRoot,
          srcDir: ".",
          target: "node",
          typedModuleFragmentsDir: "public-api",
          typedOutputFile: typedExternPath,
        }),
    );
    assertCompletePublicExterns(externResult);

    await withInternalTiming("selfbuild:compiler-build", () =>
      runCompilerBuild(compiler.build, {
        boundaryExternPath,
        entries: packageEntries(stageRoot),
        outDir: path.join(stageRoot, "dist"),
        typedExterns: externResult.typedDeclarations.moduleFragments.map(
          ({ modules, outputFile }) => ({
            entries: modules.map((specifier) => sourceEntries.get(specifier)),
            path: outputFile,
          }),
        ),
      }),
    );
    await withInternalTiming("selfbuild:copy-declarations-after", () =>
      copyBootstrapDeclarations(path.join(stageRoot, "dist")),
    );
    await withInternalTiming("selfbuild:validate-stage", async () => {
      await assertDeclaredPackageEntrypoints(stageRoot);
      await assertCliShebang(path.join(stageRoot, cliOutputRelative));
    });
  }

  async function runCompilerBuild(
    build,
    { boundaryExternPath, entries, outDir, typedExterns },
  ) {
    const result = await build({
      cache: { mode: selfBuildCacheMode },
      chunks: { mode: "off", outputType: "esm" },
      compilationLevel: "ADVANCED",
      diagnostics: { preflight: "errors-only", verbose: true },
      entries,
      externs: [boundaryExternPath],
      externals: runtimeExternals,
      languageOut: "ECMASCRIPT_NEXT",
      outDir,
      packages: "esm-only",
      preserveModules: preservedModules,
      projectRoot: root,
      srcDir: "src",
      target: "node",
      typedExterns,
    });
    if (!result.ok) {
      throw new Error(
        `Self-build compile failed:\n${result.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join("\n")}`,
      );
    }
  }

  async function generateBoundaryExterns() {
    const names = await collectBoundaryPropertyNames();
    countInternalWork("boundarySources", boundaryDeclarationSources.length);
    countInternalWork("boundaryProperties", names.size);
    for (const required of requiredBoundaryNames) {
      if (!names.has(required)) {
        throw new Error(
          `Native boundary extern generation missed required property ${JSON.stringify(required)}`,
        );
      }
    }
    const declarations = [...names]
      .sort((left, right) => left.localeCompare(right))
      .map((name) =>
        /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
          ? `Object.prototype.${name};`
          : `Object.prototype[${JSON.stringify(name)}];`,
      );
    return [
      "/** @externs */",
      "",
      "/**",
      " * Generated from native ABI and type-metadata sidecar declarations.",
      " * Napi results and JSON-revived sidecars keep original property names;",
      " * ADVANCED renaming of the matching accessors would read undefined.",
      " */",
      ...declarations,
      "",
    ].join("\n");
  }

  async function collectBoundaryPropertyNames() {
    const names = new Set();
    for (const source of boundaryDeclarationSources) {
      const sourceFile = await readBoundarySourceFile(source.path);
      const fileTypes = indexBoundaryFileTypes(sourceFile);
      const { enqueueTypeName, queue } = createBoundaryTypeQueue(
        fileTypes,
        source,
      );
      const walk = { enqueueTypeName, names };
      while (queue.length > 0) {
        collectBoundaryDeclaration(fileTypes.get(queue.shift()), walk);
      }
    }
    return names;
  }

  async function readBoundarySourceFile(relativePath) {
    const filePath = path.join(root, relativePath);
    return ts.createSourceFile(
      filePath,
      await readFile(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  }

  function indexBoundaryFileTypes(sourceFile) {
    const fileTypes = new Map();
    for (const statement of sourceFile.statements) {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        fileTypes.set(statement.name.text, statement);
      }
    }
    return fileTypes;
  }

  function createBoundaryTypeQueue(fileTypes, source) {
    const queued = new Set();
    const queue = [];
    const roots = source.roots === "all" ? [...fileTypes.keys()] : source.roots;
    for (const typeName of roots) {
      if (!fileTypes.has(typeName)) {
        throw new Error(
          `Native boundary extern generation expected ${source.path} to declare ${typeName}`,
        );
      }
      queued.add(typeName);
      queue.push(typeName);
    }
    const enqueueTypeName = (typeName) => {
      if (fileTypes.has(typeName) && !queued.has(typeName)) {
        queued.add(typeName);
        queue.push(typeName);
      }
    };
    return { enqueueTypeName, queue };
  }

  function collectBoundaryDeclaration(declaration, walk) {
    if (ts.isInterfaceDeclaration(declaration)) {
      collectBoundaryMembers(declaration.members, walk);
      walkBoundaryHeritageTypes(declaration, walk);
      return;
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      walkBoundaryType(declaration.type, walk);
    }
  }

  function walkBoundaryHeritageTypes(declaration, walk) {
    for (const clause of declaration.heritageClauses ?? []) {
      walkBoundaryTypeList(clause.types, walk);
    }
  }

  function collectBoundaryMembers(members, walk) {
    for (const member of members) {
      collectBoundaryMember(member, walk);
    }
  }

  function collectBoundaryMember(member, walk) {
    if (ts.isIndexSignatureDeclaration(member)) {
      if (member.type) walkBoundaryType(member.type, walk);
      return;
    }
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member))
      return;
    const name = boundaryMemberName(member.name);
    if (name) walk.names.add(name);
    if (member.type) walkBoundaryType(member.type, walk);
    if (ts.isMethodSignature(member)) {
      walkBoundaryParameterTypes(member.parameters, walk);
    }
  }

  function walkBoundaryParameterTypes(parameters, walk) {
    for (const parameter of parameters) {
      if (parameter.type) walkBoundaryType(parameter.type, walk);
    }
  }

  function walkBoundaryType(node, walk) {
    if (!node) return;
    if (ts.isTypeReferenceNode(node)) {
      walkBoundaryTypeReference(node, walk);
      return;
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      walkBoundaryHeritageType(node, walk);
      return;
    }
    if (ts.isTypeLiteralNode(node)) {
      collectBoundaryMembers(node.members, walk);
      return;
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      walkBoundaryTypeList(node.types, walk);
      return;
    }
    if (ts.isArrayTypeNode(node)) {
      walkBoundaryType(node.elementType, walk);
      return;
    }
    if (
      ts.isParenthesizedTypeNode(node) ||
      ts.isTypeOperatorNode(node) ||
      ts.isRestTypeNode(node)
    ) {
      walkBoundaryType(node.type, walk);
      return;
    }
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
      walkBoundaryFunctionType(node, walk);
      return;
    }
    if (ts.isTupleTypeNode(node)) {
      walkBoundaryTypeList(node.elements, walk);
      return;
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      walkBoundaryIndexedAccess(node, walk);
    }
  }

  function walkBoundaryTypeReference(node, walk) {
    const typeName = boundaryEntityName(node.typeName);
    if (typeName) walk.enqueueTypeName(typeName);
    walkBoundaryTypeList(node.typeArguments ?? [], walk);
  }

  function walkBoundaryHeritageType(node, walk) {
    if (ts.isIdentifier(node.expression)) {
      walk.enqueueTypeName(node.expression.text);
    }
    walkBoundaryTypeList(node.typeArguments ?? [], walk);
  }

  function walkBoundaryFunctionType(node, walk) {
    walkBoundaryParameterTypes(node.parameters, walk);
    walkBoundaryType(node.type, walk);
  }

  function walkBoundaryIndexedAccess(node, walk) {
    walkBoundaryType(node.objectType, walk);
    walkBoundaryType(node.indexType, walk);
  }

  function walkBoundaryTypeList(nodes, walk) {
    for (const node of nodes) {
      walkBoundaryType(node, walk);
    }
  }

  function boundaryMemberName(name) {
    if (!name) return null;
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name)
    ) {
      return name.text;
    }
    if (!ts.isComputedPropertyName(name)) return null;
    if (!ts.isStringLiteralLike(name.expression)) return null;
    return name.expression.text;
  }

  function boundaryEntityName(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isQualifiedName(node)) return node.right.text;
    return null;
  }

  async function assertDeclaredPackageEntrypoints(stageRoot) {
    const declared = [
      ["types", packageManifest.types],
      ...Object.entries(packageManifest.exports).flatMap(
        ([specifier, conditions]) =>
          ["types", "default"].map((condition) => [
            `exports[${JSON.stringify(specifier)}].${condition}`,
            conditions[condition],
          ]),
      ),
      ...Object.entries(packageManifest.bin).map(([name, filePath]) => [
        `bin.${name}`,
        filePath,
      ]),
    ];
    for (const [label, declaredPath] of declared) {
      if (typeof declaredPath !== "string") {
        throw new Error(`Package entrypoint ${label} is not a string path`);
      }
      const normalized = declaredPath.replace(/^\.\//u, "");
      const resolved = path.resolve(stageRoot, normalized);
      if (!resolved.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) {
        throw new Error(`Package entrypoint ${label} escapes the package root`);
      }
      if (!existsSync(resolved)) {
        throw new Error(
          `Self-build did not publish package entrypoint ${label}: ${declaredPath}`,
        );
      }
    }
    console.log(
      `Self-build package entrypoints: verified ${declared.length} declared paths.`,
    );
  }

  function assertCompletePublicExterns(result) {
    const degradation = result.typedDeclarations.degradations;
    const failures = [];
    if (result.diagnostics.length > 0) {
      failures.push(`diagnostics: ${JSON.stringify(result.diagnostics)}`);
    }
    if (result.warnings.length > 0) {
      failures.push(`warnings: ${JSON.stringify(result.warnings)}`);
    }
    if (
      degradation.degradedOccurrences !== 0 ||
      degradation.degradedSymbolCount !== 0
    ) {
      failures.push(`degradations: ${JSON.stringify(degradation)}`);
    }
    if (
      result.typedDeclarations.moduleExports.length !== publicSpecifiers.length
    ) {
      failures.push(
        `rendered ${result.typedDeclarations.moduleExports.length} of ${publicSpecifiers.length} public declaration modules`,
      );
    }
    if (result.typedDeclarations.propertyNames.length === 0) {
      failures.push("renderer produced no public property names");
    }
    if (failures.length > 0) {
      throw new Error(
        `Public API extern generation failed closed: ${failures.join("; ")}`,
      );
    }
  }

  async function prepareStageRoot(stageRoot) {
    await mkdir(path.join(stageRoot, "dist"), { recursive: true });
    await cp(
      path.join(root, "package.json"),
      path.join(stageRoot, "package.json"),
    );
    await stageRuntimePackageAssets(stageRoot);
    await symlink(
      path.join(root, "node_modules"),
      path.join(stageRoot, "node_modules"),
      "dir",
    );
    await symlink(
      path.join(root, "native"),
      path.join(stageRoot, "native"),
      "dir",
    );
  }

  async function discoverRuntimePackageAssets() {
    if (!Array.isArray(packageManifest.files)) {
      throw new Error(
        "package.json files must declare the shipped package tree",
      );
    }
    const assets = [];
    for (const declaredPath of packageManifest.files) {
      if (typeof declaredPath !== "string") {
        throw new Error("package.json files entries must be strings");
      }
      const relativePath = normalizePackagePath(declaredPath);
      if (generatedPackageRoots.has(packagePathRoot(relativePath))) continue;
      const sourcePath = path.join(root, relativePath);
      if (existsSync(sourcePath) && (await containsRuntimeAsset(sourcePath))) {
        assets.push(relativePath);
      }
    }
    console.log(`Self-build runtime assets: ${assets.sort().join(", ")}`);
    return assets;
  }

  async function stageRuntimePackageAssets(stageRoot) {
    for (const relativePath of runtimeAssets) {
      await cp(
        path.join(root, relativePath),
        path.join(stageRoot, relativePath),
        {
          recursive: true,
        },
      );
    }
  }

  async function containsRuntimeAsset(candidatePath) {
    const stats = await lstat(candidatePath);
    if (stats.isFile()) {
      return runtimeAssetExtensions.has(path.extname(candidatePath));
    }
    if (!stats.isDirectory()) return false;
    for (const entry of await readdir(candidatePath, { withFileTypes: true })) {
      if (await containsRuntimeAsset(path.join(candidatePath, entry.name)))
        return true;
    }
    return false;
  }

  function packagePathRoot(packagePath) {
    return normalizePackagePath(packagePath).split("/")[0];
  }

  function normalizePackagePath(packagePath) {
    const normalized = packagePath.replace(/^\.\//u, "").replace(/\\/gu, "/");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../")
    ) {
      throw new Error(`Package path escapes the package root: ${packagePath}`);
    }
    return normalized;
  }

  async function copyBootstrapDeclarations(outDir) {
    for (const { name } of libraryEntries) {
      const relativePath = name.replace(/\.mjs$/u, ".d.ts");
      const destination = path.join(outDir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(stage0, "dist", relativePath), destination);
    }
  }

  async function publishStage(stageRoot) {
    for (const directory of ["dist", "bin"]) {
      await rm(path.join(root, directory), { force: true, recursive: true });
      await cp(path.join(stageRoot, directory), path.join(root, directory), {
        recursive: true,
      });
    }
  }

  async function assertTreesEqual(leftRoot, rightRoot) {
    const leftFiles = (
      await Promise.all(
        ["bin", "dist"].map((directory) =>
          listRegularFiles(path.join(leftRoot, directory)),
        ),
      )
    ).flat();
    const rightFiles = (
      await Promise.all(
        ["bin", "dist"].map((directory) =>
          listRegularFiles(path.join(rightRoot, directory)),
        ),
      )
    ).flat();
    const leftNames = leftFiles.map((file) => path.relative(leftRoot, file));
    const rightNames = rightFiles.map((file) => path.relative(rightRoot, file));
    if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
      throw new Error(
        `Self-build fixpoint file set differs:\n${JSON.stringify({ leftNames, rightNames }, null, 2)}`,
      );
    }
    for (const relativePath of leftNames) {
      const [left, right] = await Promise.all([
        readFile(path.join(leftRoot, relativePath)),
        readFile(path.join(rightRoot, relativePath)),
      ]);
      if (!left.equals(right)) {
        throw new Error(`Self-build fixpoint differs at ${relativePath}`);
      }
    }
  }

  async function listRegularFiles(directory, excludedNames = []) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedNames.includes(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listRegularFiles(entryPath, excludedNames)));
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        const stats = await lstat(entryPath);
        if (stats.isFile()) files.push(entryPath);
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  async function printSizeReport(stage0, stage1) {
    const stage0Entries = await shippedJavaScriptEntries(stage0);
    const stage1Entries = await shippedJavaScriptEntries(stage1);
    const names = [...new Set([...stage0Entries, ...stage1Entries])].sort();
    // Raw is parse/compile CPU; gzip -9 is transfer. On the trial app they
    // disagree in sign (+4.0% gzip / -3.3% raw), so a raw-only win is not a
    // wire win.
    console.log(
      "Self-build size report (raw = parse/compile CPU bytes; gzip -9 = transfer bytes):",
    );
    for (const relativePath of names) {
      const before = await sizes(path.join(stage0, relativePath));
      const after = await sizes(path.join(stage1, relativePath));
      console.log(
        `${relativePath}: raw ${before.raw} / gzip ${before.gzip} -> raw ${after.raw} / gzip ${after.gzip}`,
      );
    }
  }

  async function shippedJavaScriptEntries(stageRoot) {
    const files = await listRegularFiles(stageRoot);
    return files
      .map((file) => path.relative(stageRoot, file).replace(/\\/gu, "/"))
      .filter((file) => file.endsWith(".mjs"));
  }

  async function sizes(filePath) {
    try {
      const content = await readFile(filePath);
      return {
        gzip: (await gzipAsync(content, { level: 9 })).length,
        raw: content.length,
      };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return { gzip: 0, raw: 0 };
      }
      throw error;
    }
  }

  async function assertCliShebang(filePath) {
    const contents = await readFile(filePath, "utf8");
    if (!contents.startsWith("#!/usr/bin/env node\n")) {
      throw new Error("Self-built CLI is missing its first-line Node shebang.");
    }
  }
});
