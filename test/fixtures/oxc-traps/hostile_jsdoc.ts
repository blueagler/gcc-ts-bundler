/**
 * @license HOSTILE_LICENSE-1.0
 * @preserve
 */

/** @const HOSTILE_CONST */
export let mutable = 1;

/** @nocollapse @suppress {checkTypes} HOSTILE_CAST */
export const cast = /** @type {string} */ (String(2));

// HOSTILE_LINE trailing prose
export function bump(): number {
  mutable = mutable + 1; // HOSTILE_LINE inside a body
  return mutable;
}

/** @enum HOSTILE_ENUM */
export enum Kind {
  A = 1,
  B = 2,
}

/** A pure factory. */
export const pure = /*#__PURE__*/ makeToken();
function makeToken(): string {
  return "TOKEN";
}
