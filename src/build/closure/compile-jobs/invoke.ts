import {
  applyTypeInferenceOptions,
  configureClosureCompilerOptions,
  hasStrictCheckTypes,
  omitEmptyHideWarningsFor,
  runClosureCompiler,
  type ClosureCompilerEnvironment,
  type ClosureCompilerOptions,
} from "../compiler";
import type { PreparedCompileJob } from "./types";

export async function invokePreparedClosureJob(
  job: PreparedCompileJob,
  compilerEnvironment: ClosureCompilerEnvironment,
): Promise<{ exitCode: number; capturedStdErr: string }> {
  const strictCheckTypes = hasStrictCheckTypes(compilerEnvironment.options);
  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: strictCheckTypes ? "DEFAULT" : job.warningLevel,
  };
  if (job.chunk) {
    closureOptions["chunk"] = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions["chunkOutputPathPrefix"] = job.chunkOutputPathPrefix;
  }
  if (job.chunkOutputType) {
    closureOptions["chunkOutputType"] = job.chunkOutputType;
  }
  if (job.dependencyMode) {
    closureOptions["dependencyMode"] = job.dependencyMode;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions["entryPoint"] = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions["jsOutputFile"] = job.jsOutputFile;
  }
  if (job.propertyRenamingReportPath) {
    closureOptions["propertyRenamingReport"] = job.propertyRenamingReportPath;
  }
  if (job.variableRenamingReportPath) {
    closureOptions["variableRenamingReport"] = job.variableRenamingReportPath;
  }
  if (job.propertyMapInputFile) {
    closureOptions["propertyMapInputFile"] = job.propertyMapInputFile;
  }
  if (job.variableMapInputFile) {
    closureOptions["variableMapInputFile"] = job.variableMapInputFile;
  }
  if (job.renamePrefixNamespace) {
    closureOptions["renamePrefixNamespace"] = job.renamePrefixNamespace;
  }
  if (job.env) {
    closureOptions["env"] = job.env;
  }
  if (job.typeInference && !strictCheckTypes) {
    applyTypeInferenceOptions(closureOptions, compilerEnvironment.options);
  }
  configureClosureCompilerOptions(closureOptions, compilerEnvironment.options);
  omitEmptyHideWarningsFor(closureOptions);
  let capturedStdErr = "";
  const exitCode = await runClosureCompiler(closureOptions, (stdErr) => {
    capturedStdErr += stdErr;
  });
  return { exitCode, capturedStdErr };
}
