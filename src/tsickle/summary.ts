/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/** The Type of an import, as used in JsTrimmer. */
export enum Type {
  UNKNOWN = 0,
  /** The symbol type for Closure namespace. */
  CLOSURE,
  /** The symbol type for a GSS namespace. */
  GSS,
  /** The symbol type for a Soy namespace. */
  SOY,
  /** The symbol type for an extensionless google3-relative CSS/GSS path. */
  CSSPATH,
  /** The symbol type for a google3-relative ES module path. */
  ESPATH,
}

/** The module system used by a file. */
export enum ModuleType {
  UNKNOWN = 0,
  GOOG_PROVIDE,
  GOOG_MODULE,
  ES_MODULE,
}

/** A single imported symbol. */
export interface Symbol {
  name: string;
  type: Type;
}

/**
 * The JsTrimmer file summary for a single file.  Contains imported and
 * exported symbols, as well as some other information required for sorting and
 * pruning files.
 */
export class FileSummary {
  private readonly dynamicRequireSet = new Map<string, Symbol>();
  private readonly enhancedSet = new Map<string, Symbol>();
  private readonly modSet = new Map<string, Symbol>();
  // These sets are implemented as Maps of jsonified Symbol to Symbol because
  // JavaScript Sets use object address, not object contents.  Similarly, we use
  // getters and setters for these to hide this implementation detail.
  private readonly provideSet = new Map<string, Symbol>();
  private readonly strongRequireSet = new Map<string, Symbol>();
  private readonly weakRequireSet = new Map<string, Symbol>();
  autochunk = false;
  enhanceable = false;
  modName: string | undefined;
  moduleType = ModuleType.UNKNOWN;
  toggles: string[] = [];

  private stringify(symbol: Symbol): string {
    return JSON.stringify(symbol);
  }

  addDynamicRequire(dynamicRequire: Symbol) {
    this.dynamicRequireSet.set(this.stringify(dynamicRequire), dynamicRequire);
  }

  addEnhanced(enhanced: Symbol) {
    this.enhancedSet.set(this.stringify(enhanced), enhanced);
  }

  addMods(mods: Symbol) {
    this.modSet.set(this.stringify(mods), mods);
  }

  addProvide(provide: Symbol) {
    this.provideSet.set(this.stringify(provide), provide);
  }

  addStrongRequire(strongRequire: Symbol) {
    this.strongRequireSet.set(this.stringify(strongRequire), strongRequire);
  }

  addWeakRequire(weakRequire: Symbol) {
    this.weakRequireSet.set(this.stringify(weakRequire), weakRequire);
  }

  get dynamicRequires(): Symbol[] {
    return [...this.dynamicRequireSet.values()];
  }

  get enhanced(): Symbol[] {
    return [...this.enhancedSet.values()];
  }

  get mods(): Symbol[] {
    return [...this.modSet.values()];
  }

  get provides(): Symbol[] {
    return [...this.provideSet.values()];
  }

  get strongRequires(): Symbol[] {
    return [...this.strongRequireSet.values()];
  }

  get weakRequires(): Symbol[] {
    const weakRequires = [];
    for (const [k, v] of this.weakRequireSet.entries()) {
      if (this.strongRequireSet.has(k)) continue;
      weakRequires.push(v);
    }
    return weakRequires;
  }
}

/** Provides dependencies for file generation. */
export interface SummaryGenerationProcessorHost {
  /**
   * Whether to convert CommonJS require() imports to goog.module() and
   * goog.require() calls.
   */
  googmodule: boolean;
  /** See compiler_host.ts */
  rootDirsRelative(fileName: string): string;
  /** @deprecated use unknownTypesPaths instead */
  typeBlackListPaths?: Set<string>;
  /** If provided, a set of paths whose types should always generate as {?}. */
  unknownTypesPaths?: Set<string>;
}
