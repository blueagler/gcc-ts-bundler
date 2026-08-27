import type { Metafile } from "esbuild";

import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import type {
  CanonicalizedLazyEntryOutputs,
  CollapsibleBundleEntryOutput,
} from "./entry-outputs";
import type { WrittenRegionBundleRequest } from "./regions";
import type { ParsedMaterializedModule } from "./shared";

export interface PrebundleContext {
  authoredFiles: Set<string>;
  invalidateParsed: (filePaths: Iterable<string>) => void;
  materialized: MaterializedGraph;
  moduleByFilePath: Map<string, CapturedRuntimeModule>;
  moduleBySourceId: Map<string, CapturedRuntimeModule>;
  parseModule: (filePath: string) => Promise<ParsedMaterializedModule>;
  runtimeSrcDir: string;
}

export interface DependencyBundleSet {
  canonicalizedEntryOutputs: CanonicalizedLazyEntryOutputs;
  collapsedEntryOutputByPath: Map<string, CollapsibleBundleEntryOutput>;
  metafile: Metafile;
  requestGroupKeyByTarget: Map<string, string>;
  writtenRequests: WrittenRegionBundleRequest[];
}
