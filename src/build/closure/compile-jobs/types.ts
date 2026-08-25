import type { NativeClosureCompileJob } from "../../../native/abi";

export type PreparedCompileJob = NativeClosureCompileJob & {
  env?: string;
  propertyMapInputFile?: string;
  variableMapInputFile?: string;
  variableRenamingReportPath?: string;
  typeInference?: boolean;
};
