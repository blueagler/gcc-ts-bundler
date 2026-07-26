/** @externs */

/**
 * @param {string} query
 * @return {!MediaQueryList}
 */
function matchMedia(query) {}

/** @constructor */
function Navigation() {}

/** @type {?Object} */
Navigation.prototype.transition;

/** @type {!Navigation} */
var navigation;

/** @type {number} */
var innerWidth;

/** @type {number} */
var innerHeight;

// Closure declares the following on Window.prototype but not as bare
// globals, so unqualified references (common in library code) fail with
// JSC_UNDEFINED_VARIABLE under ADVANCED.

/** @type {number} */
var outerWidth;

/** @type {number} */
var outerHeight;

/** @type {number} */
var devicePixelRatio;

/** @type {number} */
var scrollX;

/** @type {number} */
var scrollY;

/** @type {!Storage} */
var sessionStorage;

/** @type {!Storage} */
var localStorage;

/**
 * @param {(number|!Object)=} xOrOptions
 * @param {number=} y
 * @return {undefined}
 */
function scroll(xOrOptions, y) {}

/**
 * @param {(number|!Object)=} xOrOptions
 * @param {number=} y
 * @return {undefined}
 */
function scrollTo(xOrOptions, y) {}

/**
 * @param {(number|!Object)=} xOrOptions
 * @param {number=} y
 * @return {undefined}
 */
function scrollBy(xOrOptions, y) {}

/**
 * @param {string} type
 * @param {(EventListener|function(!Event):*|null)} listener
 * @param {(boolean|!Object)=} options
 * @return {undefined}
 */
function addEventListener(type, listener, options) {}

/**
 * @param {string} type
 * @param {(EventListener|function(!Event):*|null)} listener
 * @param {(boolean|!Object)=} options
 * @return {undefined}
 */
function removeEventListener(type, listener, options) {}

/**
 * @param {!Event} event
 * @return {boolean}
 */
function dispatchEvent(event) {}

/**
 * @constructor
 * @param {(string|!Object)=} input
 * @param {(string|!Object)=} baseURL
 * @param {!Object=} options
 */
function URLPattern(input, baseURL, options) {}

/**
 * @param {(string|!Object)=} input
 * @param {string=} baseURL
 * @return {boolean}
 */
URLPattern.prototype.test = function(input, baseURL) {};

/**
 * @param {(string|!Object)=} input
 * @param {string=} baseURL
 * @return {?Object}
 */
URLPattern.prototype.exec = function(input, baseURL) {};
