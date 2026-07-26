/** @externs */

/**
 * Registers a lazy module namespace under its stable module key.
 * Implemented by the split-chunk runtime prelude.
 * @param {string} key
 * @param {?} moduleNamespace
 * @return {void}
 */
function gccRegisterLazy(key, moduleNamespace) {}

/**
 * Loads the chunks for a lazy module and resolves its namespace.
 * Implemented by the split-chunk runtime prelude.
 * @param {string} key
 * @return {!Promise<?>}
 */
function gccImportLazy(key) {}
