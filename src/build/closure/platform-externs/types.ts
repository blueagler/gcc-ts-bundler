export interface PlatformExternArchive {
  /**
   * Lazy on purpose: the jar only has to be read when something downstream
   * actually needs the extern sources, which a warm unit cache or slice cache
   * makes unnecessary. See `loadPlatformExternArchive`.
   */
  entries: () => Promise<readonly PlatformExternSource[]>;
  jarHash: string;
}

export interface PlatformExternSource {
  name: string;
  source: string;
}

export interface PlatformDeclarationUnit {
  id: string;
  fileName: string;
  fileOrder: number;
  statementOrder: number;
  text: string;
  names: readonly string[];
  owner?: string;
  property?: string;
  dependencies: readonly string[];
  heritage: readonly string[];
  override: boolean;
}

export interface PlatformExternIndex {
  jarHash: string;
  languageSources: readonly PlatformExternSource[];
  browserUnits: readonly PlatformDeclarationUnit[];
  unitsByName: ReadonlyMap<string, readonly PlatformDeclarationUnit[]>;
  unitsByProperty: ReadonlyMap<string, readonly PlatformDeclarationUnit[]>;
  globalNames: ReadonlySet<string>;
  propertyNames: ReadonlySet<string>;
  languageNames: ReadonlySet<string>;
}

export interface PlatformExternSeeds {
  globals: ReadonlySet<string>;
  properties: ReadonlySet<string>;
  typeNames: ReadonlySet<string>;
}

/**
 * The cacheable half of the index: the result of TypeScript-parsing the
 * archive, before the (cheap) grouping step. Plain JSON — no Maps or Sets — so
 * it can round-trip through the on-disk unit cache.
 */
export interface ParsedPlatformExternUnits {
  allUnits: readonly PlatformDeclarationUnit[];
  jarHash: string;
  languageSources: readonly PlatformExternSource[];
}
