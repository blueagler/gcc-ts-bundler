import fs from "fs/promises";
import path from "path";

import {
  copyOrLinkFiles,
  ensureDirectory,
  ensureParentDirectory,
} from "../../internal/files";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import {
  prepareClosureJobs,
  rewriteBundlerRuntimeEs5Helpers,
  rewriteDecoratorMetadata,
  rewriteGccExports,
} from "../../native/load";
import {
  ClosureCompilerOptions,
  configureClosureCompilerOptions,
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
} from "./compiler";
import {
  getCompileJobArtifactFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "./cache";
import { determineClosureConcurrency, runWithConcurrency } from "./concurrency";

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

export async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
  projectCacheDir,
  supportFiles,
  packageRoot,
}: {
  chunkPlan: ChunkPlanChunk[];
  emittedOutDir: string;
  explicitExternPaths: string[];
  finalCacheDir: string;
  generatedExternPaths: string[];
  nativeExternPath: string;
  options: NormalizedBuildOptions;
  outDir: string;
  projectCacheDir: string;
  supportFiles: string[];
  packageRoot: string;
}): Promise<ClosureStageResult> {
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  const prepared = prepareClosureJobs({
    chunkLoader: options.chunks.loader,
    chunkMode: options.chunks.mode,
    chunkPlan,
    compilationLevel: options.compilationLevel,
    diagnosticsVerbose: options.diagnostics.verbose,
    emittedOutDir,
    explicitExternPaths,
    explicitJsInputs: options.js,
    finalCacheDir,
    generatedExternPaths,
    languageOut: options.languageOut,
    manifestFile: options.chunks.manifestFile,
    nativeExternPath,
    outDir,
    packageRoot,
    publicPath: options.chunks.publicPath,
    supportFiles,
  });

  await Promise.all(
    prepared.generatedAssets.map(async (asset) => {
      await ensureParentDirectory(asset.path);
      await fs.writeFile(asset.path, asset.text, "utf-8");
    }),
  );

  const closureJobCacheDir =
    options.cache.mode === "off"
      ? null
      : path.join(projectCacheDir, "closure-jobs");
  const concurrency =
    options.chunks.mode === "bundler-runtime"
      ? determineClosureConcurrency(prepared.compileJobs.length)
      : 1;
  const exitCodes = await runWithConcurrency(
    prepared.compileJobs,
    concurrency,
    async (job) =>
      runPreparedClosureJob({
        cacheDir: closureJobCacheDir,
        job,
      }),
  );
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }

  const propertyRenamingReports = new Map<string, Promise<string>>();
  const es5HelperRewrite = await rewriteBundlerRuntimeEs5ChunksIfNeeded(
    prepared,
    options.chunks.mode,
    options.languageOut,
  );
  await Promise.all(
    prepared.postprocessActions.map(async (action) => {
      await ensureParentDirectory(action.outputPath);
      const reportText = action.propertyRenamingReportPath
        ? await readPropertyRenamingReport(
            action.propertyRenamingReportPath,
            propertyRenamingReports,
          )
        : "";
      if (action.kind === "copy" && !reportText) {
        await fs.copyFile(action.inputPath, action.outputPath);
        return;
      }
      let contents = await fs.readFile(action.inputPath, "utf-8");
      if (
        action.kind === "rewrite-gcc-exports" ||
        action.kind === "rewrite-gcc-exports-and-decorator-metadata"
      ) {
        contents = rewriteGccExports(contents);
      }
      if (
        reportText &&
        (action.kind === "rewrite-decorator-metadata" ||
          action.kind === "rewrite-gcc-exports-and-decorator-metadata")
      ) {
        contents = rewriteDecoratorMetadata(contents, reportText);
      }
      await fs.writeFile(action.outputPath, contents);
    }),
  );
  if (es5HelperRewrite?.baseOutputPath && es5HelperRewrite.helperBag) {
    const baseOutput = await fs.readFile(
      es5HelperRewrite.baseOutputPath,
      "utf-8",
    );
    const injected = injectBundlerRuntimeEs5HelperBag(
      baseOutput,
      es5HelperRewrite.helperBag,
    );
    if (injected !== baseOutput) {
      await fs.writeFile(es5HelperRewrite.baseOutputPath, injected);
    }
  }

  await copyOrLinkFiles(prepared.publishedOutputs, cacheOutputDir);
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) =>
    path.join(cacheOutputDir, path.relative(outDir, outputFile)),
  );

  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs,
  };
}

async function rewriteBundlerRuntimeEs5ChunksIfNeeded(
  prepared: ReturnType<typeof prepareClosureJobs>,
  chunkMode: string,
  languageOut: string,
) {
  if (
    chunkMode !== "bundler-runtime" ||
    !/ECMASCRIPT(?:3|5)/.test(languageOut) ||
    !prepared.bundlerRuntimeBaseInputPath
  ) {
    return null;
  }

  const helperKeys = new Set<string>();
  const inputPaths = [
    ...new Set(prepared.postprocessActions.map((action) => action.inputPath)),
  ];
  for (const inputPath of inputPaths) {
    if (inputPath === prepared.bundlerRuntimeBaseInputPath) {
      continue;
    }
    const contents = await fs.readFile(inputPath, "utf-8");
    const rewritten = rewriteBundlerRuntimeEs5Helpers(contents);
    for (const helperKey of rewritten.helperKeys) {
      helperKeys.add(helperKey);
    }
    if (rewritten.code !== contents) {
      await fs.writeFile(inputPath, rewritten.code);
    }
  }

  if (helperKeys.size === 0) {
    return null;
  }

  return {
    baseOutputPath: prepared.postprocessActions.find(
      (action) => action.inputPath === prepared.bundlerRuntimeBaseInputPath,
    )?.outputPath,
    helperBag: renderBundlerRuntimeEs5HelperBag(helperKeys),
  };
}

function injectBundlerRuntimeEs5HelperBag(code: string, helperBag: string) {
  const marker = "}).call(this,globalThis);";
  const markerIndex = code.indexOf(marker);
  if (markerIndex === -1) {
    return `${helperBag}${code}`;
  }
  const insertAt = markerIndex + marker.length;
  return `${code.slice(0, insertAt)}${helperBag}${code.slice(insertAt)}`;
}

function renderBundlerRuntimeEs5HelperBag(helperKeys: Set<string>) {
  const lines = ["var _=globalThis.__g._||(globalThis.__g._=[]);"];
  if (helperKeys.has("class-private-field-set")) {
    lines.push(
      '_[0]=function(a,b,c,d,e){if(d==="m")throw new TypeError("Private method is not writable");if(d==="a"&&!e)throw new TypeError("Private accessor was defined without a setter");if(typeof b==="function"?a!==b||!e:!b.has(a))throw new TypeError("Cannot write private member to an object whose class did not declare it");return d==="a"?e.call(a,c):e?e.value=c:b.set(a,c),c;};',
    );
  }
  if (helperKeys.has("class-private-field-get")) {
    lines.push(
      '_[1]=function(a,b,c,d){if(c==="a"&&!d)throw new TypeError("Private accessor was defined without a getter");if(typeof b==="function"?a!==b||!d:!b.has(a))throw new TypeError("Cannot read private member from an object whose class did not declare it");return c==="m"?d:c==="a"?d.call(a):d?d.value:b.get(a);};',
    );
  }
  if (helperKeys.has("set-function-name")) {
    lines.push(
      '_[2]=function(a,b,c){typeof b==="symbol"&&(b=b.description?"["+b.description+"]":"");return Object.defineProperty(a,"name",{configurable:!0,value:c?c+" "+b:b});};',
    );
  }
  if (helperKeys.has("run-initializers")) {
    lines.push(
      "_[3]=function(a,b,c){for(var d=arguments.length>2,e=0;e<b.length;e++)c=d?b[e].call(a,c):b[e].call(a);return d?c:void 0;};",
    );
  }
  if (helperKeys.has("es-decorate")) {
    lines.push(
      '_[4]=function(a,b,c,d,e,f){function g(h){if(h!==void 0&&typeof h!=="function")throw new TypeError("Function expected");return h;}var i=d.kind,j=i==="getter"?"get":i==="setter"?"set":"value";a=!b&&a?d["static"]?a:a.prototype:null;b=b||(a?Object.getOwnPropertyDescriptor(a,d.name):{});for(var k,l=!1,m=c.length-1;m>=0;m--){k={};for(var n in d)k[n]=n==="access"?{}:d[n];for(n in d.access)k.access[n]=d.access[n];k.addInitializer=function(h){if(l)throw new TypeError("Cannot add initializers after decoration has completed");f.push(g(h||null));};var o=(0,c[m])(i==="accessor"?{get:b.get,set:b.set}:b[j],k);if(i==="accessor"){if(o!==void 0){if(o===null||typeof o!=="object")throw new TypeError("Object expected");if(k=g(o.get))b.get=k;if(k=g(o.set))b.set=k;(k=g(o.init))&&e.unshift(k);}}else if(k=g(o))i==="field"?e.unshift(k):b[j]=k;}a&&Object.defineProperty(a,d.name,b);l=!0;};',
    );
  }
  return lines.join("");
}

async function runPreparedClosureJob({
  cacheDir,
  job,
}: {
  cacheDir: string | null;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
}) {
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        artifactFiles,
        cacheDir,
        compilerVersion,
        job,
      })
    : false;
  if (cached) {
    return 0;
  }

  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel as never,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn as never,
    languageOut: job.languageOut as never,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel as never,
  };
  if (job.chunk) {
    closureOptions.chunk = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions.chunkOutputPathPrefix = job.chunkOutputPathPrefix;
  }
  if (job.dependencyMode) {
    closureOptions.dependencyMode = job.dependencyMode as never;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions.entryPoint = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions.jsOutputFile = job.jsOutputFile;
  }
  if (job.propertyRenamingReportPath) {
    (
      closureOptions as ClosureCompilerOptions & {
        propertyRenamingReport?: string;
      }
    ).propertyRenamingReport = job.propertyRenamingReportPath;
  }
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }

  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job,
    });
  }

  return 0;
}

async function readPropertyRenamingReport(
  reportPath: string,
  cache: Map<string, Promise<string>>,
) {
  let pending = cache.get(reportPath);
  if (!pending) {
    pending = fs.readFile(reportPath, "utf-8");
    cache.set(reportPath, pending);
  }
  return pending;
}
