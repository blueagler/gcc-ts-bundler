/** @externs */

/**
 * The CommonJS interop marker our own normalization writes and reads.
 *
 * Pinned deliberately. Its spelling is decided by the per-package
 * opaque/transparent export verdict (W2-X2), so all three emission sites must
 * agree on one literal: the export assignment, the namespace slot descriptor,
 * and the interop membership test. Rewriting only the membership test through
 * Closure's rename primitive desynchronises the other two — measured, the React
 * example then threw at module evaluation. Renaming this name requires
 * threading the verdict into the interop template, which is a scoped change to
 * the W2-X2 ABI machinery rather than a quoting tweak.
 *
 * @type {*}
 */
Object.prototype.__cjsExports;
