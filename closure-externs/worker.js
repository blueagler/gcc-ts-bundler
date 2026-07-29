/** @externs */

/**
 * Common worker/service-worker globals that Closure exposes only on
 * WorkerGlobalScope/ServiceWorkerGlobalScope prototypes.
 *
 * These match standard web-worker globals from TypeScript's
 * `lib.webworker.d.ts` and fill gaps in Closure's shipped browser externs.
 *
 * A gap-filling extern must declare only names the platform externs do NOT
 * already own. `self` and `navigator` used to be declared here as well, and
 * Closure's own `externs.zip//window.js` declares both: any job compiled
 * against the default browser environment (rather than `--env CUSTOM` with a
 * typed slice) failed outright with JSC_VAR_MULTIPLY_DECLARED_ERROR. They are
 * not listed here any more because the platform already declares them, and
 * `test/platform-externs.test.mjs` now proves no bundled extern re-declares a
 * platform global, so the rule cannot silently regress.
 */

/** @type {!WorkerLocation|!Location} */
var location;

/** @type {string} */
var origin;

/** @type {!Performance} */
var performance;

/** @type {!Scheduler} */
var scheduler;

/** @type {?function(!MessageEvent)} */
var onmessage;

/** @type {?function(!MessageEvent)} */
var onmessageerror;

/** @type {!ServiceWorkerClients} */
var clients;

/** @type {!CacheStorage} */
var caches;

/** @type {!ServiceWorkerRegistration} */
var registration;

/** @type {!ServiceWorker} */
var serviceWorker;

/** @type {?function(!ExtendableEvent)} */
var onactivate;

/** @type {?function(!ExtendableCookieChangeEvent)} */
var oncookiechange;

/** @type {?function(!FetchEvent)} */
var onfetch;

/** @type {?function(!InstallEvent)} */
var oninstall;

/** @type {?function(!NotificationEvent)} */
var onnotificationclick;

/** @type {?function(!NotificationEvent)} */
var onnotificationclose;

/** @type {?function(!PushEvent)} */
var onpush;

/** @type {?function(!PushSubscriptionChangeEvent)} */
var onpushsubscriptionchange;

/** @return {!Promise<void>} */
function skipWaiting() {}

/** @record */
function CookieListItem() {}

/** @type {string|undefined} */
CookieListItem.prototype.name;

/** @type {string|undefined} */
CookieListItem.prototype.value;

/**
 * @typedef {{
 *   domain: (string|null|undefined),
 *   name: string,
 *   partitioned: (boolean|undefined),
 *   path: (string|undefined)
 * }}
 */
var CookieStoreDeleteOptions;

/**
 * @typedef {{
 *   name: (string|undefined),
 *   url: (string|undefined)
 * }}
 */
var CookieStoreGetOptions;

/** @constructor @implements {EventTarget} */
function CookieStore() {}

/** @return {!Promise<void>} */
CookieStore.prototype.delete = function(nameOrOptions) {};

/** @return {!Promise<?CookieListItem>} */
CookieStore.prototype.get = function(nameOrOptions) {};

/** @return {!Promise<!Array<!CookieListItem>>} */
CookieStore.prototype.getAll = function(options) {};

/** @return {!Promise<void>} */
CookieStore.prototype.set = function(nameOrOptions, value) {};

/** @type {?function(!Event)} */
CookieStore.prototype.onchange;

/** @type {!CookieStore} */
var cookieStore;

/**
 * @typedef {{
 *   changed: (!Array<!CookieListItem>|undefined),
 *   deleted: (!Array<!CookieListItem>|undefined)
 * }}
 */
var ExtendableCookieChangeEventInit;

/** @constructor @extends {ExtendableEvent} */
function ExtendableCookieChangeEvent(type, eventInitDict) {}

/** @type {!Array<!CookieListItem>} */
ExtendableCookieChangeEvent.prototype.changed;

/** @type {!Array<!CookieListItem>} */
ExtendableCookieChangeEvent.prototype.deleted;

/**
 * @typedef {{
 *   newSubscription: (!PushSubscription|null|undefined),
 *   oldSubscription: (!PushSubscription|null|undefined)
 * }}
 */
var PushSubscriptionChangeEventInit;

/** @constructor @extends {ExtendableEvent} */
function PushSubscriptionChangeEvent(type, eventInitDict) {}

/** @type {?PushSubscription} */
PushSubscriptionChangeEvent.prototype.newSubscription;

/** @type {?PushSubscription} */
PushSubscriptionChangeEvent.prototype.oldSubscription;
