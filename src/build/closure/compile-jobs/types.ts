import type { NativeClosureCompileJob } from "../../../native/abi";

export type PreparedCompileJob = NativeClosureCompileJob & {
  env?: string;
  /** Exact generated browser slice; only this capability permits a full-browser retry. */
  browserExternSlice?: string;
  propertyMapInputFile?: string;
  variableMapInputFile?: string;
  variableRenamingReportPath?: string;
  typeInference?: boolean;
};
