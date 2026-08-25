import { isRuntimeExternPropertyName } from "../shared";

/**
 * Evidence classes for member renaming, not a flat "defined"/"accessed" split.
 *
 * A member only needs an extern when its definition and its reads *cannot
 * rename together* inside one Closure invocation. Dot-defined plus dot-accessed
 * renames consistently and needs nothing; the hazard is a mixed pair, where one
 * side is a string that Closure leaves alone while the other side gets renamed.
 *
 * Definitions stay restricted to recognisable runtime targets (`this`/`super`,
 * a known constructor or its prototype) because that is what makes them
 * attributable. Reads are deliberately *unrestricted*: the string-keyed
 * definition and the dot read usually live in different functions, and the read
 * side is normally a plain parameter (`effect.nodes`), so a target restriction
 * there would miss the hazard the rule exists to catch.
 */
export interface RuntimeRenameHazards {
  /**
   * Identifier-shaped heads of template literals that build property keys
   * (`` node[`$evt${type}`] ``, vue vapor's event delegation). The full key
   * is invisible statically, but a dot-defined member matching a collected
   * prefix is read through it at runtime. Restricted to `$`/`_`-leading
   * heads: framework-internal protocol names by convention, which keeps
   * message templates and URL builders out of the evidence.
   */
  constructedKeyPrefixes: Set<string>;
  /**
   * Literal fragments of property keys assembled with `+` *in element-access
   * position*: `deferred[tuple[0] + "With"]` contributes the suffix `With`.
   *
   * This is the other half of the constructed-key hazard and the one that
   * actually bites in the wild. jQuery defines its Deferred API entirely
   * through concatenated keys (`deferred[tuple[0] + "With"] = list.fireWith`,
   * jquery.js:3705) and reads it back with a plain dot
   * (`readyList.resolveWith(...)`, jquery.js:3844). The definition is invisible
   * to Closure, so the runtime property keeps its literal name, while the dot
   * read renames — `TypeError: Fb.ga is not a function` on first paint.
   *
   * Unlike `constructedKeyPrefixes`, position is *required*: only an
   * `obj[… + …]` argument counts. A bare `"a" + b` anywhere in a file is a
   * message, not a key, and treating it as evidence would pin most of the
   * program.
   */
  constructedKeyFragments: Set<string>;
  /**
   * Member names a stylesheet spells out as CSS custom properties.
   *
   * `@ant-design/cssinjs` enumerates a token object and transliterates every
   * key into a `--ant-…` custom-property name, so the renamed spelling is what
   * lands in the stylesheet — and `$` is not a legal CSS identifier, so the
   * declaration is dropped. Collected by a k-bounded backward taint from the
   * escape site; see `externs/css-variable-protocol.ts`.
   *
   * The flow crosses three packages, so this class is filled by a global pass
   * over the whole post-prebundle graph, not by the per-package hazard scan.
   */
  cssVariableKeyNames: Set<string>;
  /** `o.x` read anywhere. */
  dotAccessed: Set<string>;
  /** `this.x = v`, class members, object-literal keys. */
  dotDefined: Set<string>;
  /**
   * Member names enumerated by a *finite literal key list* that provably
   * reaches computed member-access position.
   *
   * ```js
   * lodash.bind = func.bind;                                   // lodash.js:101
   * arrayEach(['bind', 'bindKey', 'curry', 'curryRight',       // :427
   *            'partial', 'partialRight'], function (methodName) {
   *   lodash[methodName].placeholder = lodash;                 // :428
   * });
   * ```
   *
   * No other evidence class sees this. The definition is a plain dot, so
   * `stringDefined ∩ dotAccessed` misses it; the read goes through a loop
   * variable rather than a literal, so `dotDefined ∩ stringLiteralRead` misses
   * it; nothing is concatenated or templated, so the constructed-key classes
   * miss it; the names live in an array, not as a sibling value of the literal
   * they name, so `selfReferentialKeys` misses it. Closure renames
   * `lodash.bind` to `nZ.cY`, the array string stays `"bind"`, and
   * `lodash["bind"]` yields `undefined` — `TypeError: Cannot set properties of
   * undefined (setting 'placeholder')` at first evaluation of the module.
   *
   * The rule is a proof, not a guess: the list must be a literal
   * (`['a', 'b']` or `'a b'.split(' ')`, including a literal ternary between
   * two such lists), and the binding it feeds — a callback parameter of the
   * same call, or a `for…of` variable — must be used as a computed key inside
   * that callback or loop body. Concatenated uses (`o[k + 'Right']`) count,
   * because the fragment class pins the suffix but not the stem.
   *
   * Measured over 4,469 materialized dependency files of a TanStack Start +
   * AntD Pro app: 11 sites, 44 names.
   */
  enumeratedKeyNames: Set<string>;
  protocolMembers: Set<string>;
  /**
   * Keys of an object literal that a *sibling* property of the same literal
   * names with a string-literal value — a self-referential key.
   *
   * ```js
   * jQuery.easing = {                       // jquery.js:7135
   *   linear:   function (p) { … },
   *   swing:    function (p) { … },
   *   _default: "swing"                     // VALUE naming a sibling KEY
   * };
   * this.easing = easing || jQuery.easing._default;   // :7045
   * this.pos = jQuery.easing[this.easing](…);         // :7063
   * ```
   *
   * No other evidence class sees this. The key is dot-defined, so
   * `stringDefined ∩ dotAccessed` misses it; the read goes through a variable,
   * so `dotDefined ∩ stringLiteralRead` misses it; nothing is concatenated, so
   * the constructed-key classes miss it. Closure renames `swing`, the string
   * does not follow, and `jQuery.easing[…]` yields `undefined` — `.animate()`
   * silently produces no tween, inside a `requestAnimationFrame` tick where
   * nothing surfaces the error.
   *
   * The rule is deliberately narrow: the value must be a plain string literal,
   * the key it names must be a sibling *identifier* key of the **same** literal
   * (a quoted key never renames, so it needs no pin), and nesting does not
   * cross literal boundaries. Audited over all 12 `_default` sites in
   * `jquery.js`: fires exactly once.
   */
  selfReferentialKeys: Set<string>;
  /**
   * `__publicField(this, "x")`, `defineProperty`, `this["x"] =`, `"x" = v`.
   * Hyphenated keys also record their identifier aliases — camelCase and
   * underscored. A hyphen is not a legal identifier, so a hyphenated site can
   * only ever reach a member through one of those spellings: framework prop
   * systems bridge quoted kebab-case pass sites to camelCase declaration keys
   * via `camelize`, and locale tables bridge `"zh-CN"` to `zh_CN`.
   */
  stringDefined: Set<string>;
  /**
   * `o["x"]` read or `"x" in o`, with the key spelled either as a literal or
   * as a file-local `const` bound once to one (`const K = "x"; K in o`). See
   * `createKeyNameReader`.
   */
  stringLiteralRead: Set<string>;
}

/**
 * A literal piece of a concatenated key, encoded as `prefix:<text>` or
 * `suffix:<text>`. Kept as a plain string so the hazard sets stay homogeneous
 * and `mergeRuntimeHazards` can loop over them generically.
 */
export const KEY_FRAGMENT_PREFIX = "prefix:";
export const KEY_FRAGMENT_SUFFIX = "suffix:";

export interface RuntimeProtocolHelpers {
  keyExclusionListCallees: string[];
  keyReadCallees: string[];
}

export function createEmptyRuntimeHazards(): RuntimeRenameHazards {
  return {
    constructedKeyFragments: new Set(),
    constructedKeyPrefixes: new Set(),
    cssVariableKeyNames: new Set(),
    dotAccessed: new Set(),
    dotDefined: new Set(),
    enumeratedKeyNames: new Set(),
    protocolMembers: new Set(),
    selfReferentialKeys: new Set(),
    stringDefined: new Set(),
    stringLiteralRead: new Set(),
  };
}

export function mergeRuntimeHazards(
  ...hazardsList: readonly RuntimeRenameHazards[]
): RuntimeRenameHazards {
  const merged = createEmptyRuntimeHazards();
  for (const hazards of hazardsList) {
    mergeHazardSet(
      merged.constructedKeyFragments,
      hazards.constructedKeyFragments,
    );
    mergeHazardSet(
      merged.constructedKeyPrefixes,
      hazards.constructedKeyPrefixes,
    );
    mergeHazardSet(merged.cssVariableKeyNames, hazards.cssVariableKeyNames);
    mergeHazardSet(merged.dotAccessed, hazards.dotAccessed);
    mergeHazardSet(merged.dotDefined, hazards.dotDefined);
    mergeHazardSet(merged.enumeratedKeyNames, hazards.enumeratedKeyNames);
    mergeHazardSet(merged.protocolMembers, hazards.protocolMembers);
    mergeHazardSet(merged.selfReferentialKeys, hazards.selfReferentialKeys);
    mergeHazardSet(merged.stringDefined, hazards.stringDefined);
    mergeHazardSet(merged.stringLiteralRead, hazards.stringLiteralRead);
  }
  return merged;
}

function mergeHazardSet(target: Set<string>, source: ReadonlySet<string>) {
  for (const member of source) target.add(member);
}

export function addMember(
  target: Set<string>,
  memberName: string | null | undefined,
) {
  if (memberName && isRuntimeExternPropertyName(memberName)) {
    target.add(memberName);
    // A hyphenated key is never the renamed form of an identifier member, so
    // its identifier spellings are what a hyphenated site actually reaches.
    // Prop systems bridge quoted kebab-case pass sites ("click-count") to
    // camelCase declaration keys via camelize; locale tables bridge dashed
    // keys ("zh-CN") to underscored ones. pro-components builds its intl map
    // with `Object.fromEntries(Object.keys(localeMessages).map(k =>
    // [k.replace("_", "-"), …]))` and then reads `intlMap["zh-CN"]`, so
    // renaming `zh_CN` leaves every lookup undefined.
    if (memberName.includes("-")) {
      const camelized = memberName.replace(/-(\w)/gu, (_, letter: string) =>
        letter.toUpperCase(),
      );
      if (isRuntimeExternPropertyName(camelized)) {
        target.add(camelized);
      }
      const underscored = memberName.replace(/-/gu, "_");
      if (isRuntimeExternPropertyName(underscored)) {
        target.add(underscored);
      }
    }
  }
}
