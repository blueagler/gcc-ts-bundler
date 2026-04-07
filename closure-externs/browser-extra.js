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
