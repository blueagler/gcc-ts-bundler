import { rewriteBundlerRuntimeEs5Helpers } from "../../../native/load";

export function createEs5HelperRewriteContext({
  bundlerRuntimeBaseInputPath,
  chunkMode,
  languageOut,
}: {
  bundlerRuntimeBaseInputPath?: string;
  chunkMode: string;
  languageOut: string;
}) {
  const shouldRewriteHelpers =
    chunkMode === "bundler-runtime" &&
    /ECMASCRIPT(?:3|5)/.test(languageOut) &&
    !!bundlerRuntimeBaseInputPath;
  const helperKeys = new Set<string>();
  const rewrittenInputs = new Map<string, string>();

  return {
    requiresInputRead() {
      return shouldRewriteHelpers;
    },
    renderHelperBag(runtimeAlias?: string) {
      return helperKeys.size === 0
        ? ""
        : renderBundlerRuntimeEs5HelperBag(helperKeys, runtimeAlias);
    },
    rewrite(inputPath: string, contents: string) {
      if (!shouldRewriteHelpers || inputPath === bundlerRuntimeBaseInputPath) {
        return contents;
      }
      const cached = rewrittenInputs.get(inputPath);
      if (cached !== undefined) {
        return cached;
      }
      const rewritten = rewriteBundlerRuntimeEs5Helpers(contents);
      for (const helperKey of rewritten.helperKeys) {
        helperKeys.add(helperKey);
      }
      rewrittenInputs.set(inputPath, rewritten.code);
      return rewritten.code;
    },
  };
}

export function applyEs5HelperRewrite(
  inputPath: string,
  contents: string,
  rewriteContext: ReturnType<typeof createEs5HelperRewriteContext>,
) {
  return rewriteContext.rewrite(inputPath, contents);
}

function renderBundlerRuntimeEs5HelperBag(
  helperKeys: Set<string>,
  runtimeAlias?: string,
) {
  const lines = [
    runtimeAlias
      ? `var _=${runtimeAlias}._||(${runtimeAlias}._=[]);`
      : "var G=globalThis.__g,_=G._||(G._=[]);",
  ];
  if (helperKeys.has("class-private-field-set")) {
    lines.push(
      '_[0]=function(a,b,c,d,e){if(d==="m")throw new TypeError("Private method is not writable");if(d==="a"&&!e)throw new TypeError("Private accessor was defined without a setter");if(typeof b==="function"?a!==b||!e:!b.has(a))throw new TypeError("Cannot write private member to an object whose class did not declare it");return d==="a"?e.call(a,c):e?e.value=c:b.set(a,c),c;};',
    );
  }
  if (helperKeys.has("class-private-field-get")) {
    lines.push(
      '_[1]=function(a,b,c,d){if(c==="a"&&!d)throw new TypeError("Private accessor was defined without a getter");if(typeof b==="function"?a!==b||!d:!b.has(a))throw new TypeError("Cannot read private member from an object whose class did not declare it");return c==="m"?d:c==="a"?d.call(a):d?d.value:b.get(a);};',
    );
  }
  if (helperKeys.has("set-function-name")) {
    lines.push(
      '_[2]=function(a,b,c){typeof b==="symbol"&&(b=b.description?"["+b.description+"]":"");return Object.defineProperty(a,"name",{configurable:!0,value:c?c+" "+b:b});};',
    );
  }
  if (helperKeys.has("run-initializers")) {
    lines.push(
      "_[3]=function(a,b,c){for(var d=arguments.length>2,e=0;e<b.length;e++)c=d?b[e].call(a,c):b[e].call(a);return d?c:void 0;};",
    );
  }
  if (helperKeys.has("es-decorate")) {
    lines.push(
      '_[4]=function(a,b,c,d,e,f){function g(h){if(h!==void 0&&typeof h!=="function")throw new TypeError("Function expected");return h;}var i=d.kind,j=i==="getter"?"get":i==="setter"?"set":"value";a=!b&&a?d["static"]?a:a.prototype:null;b=b||(a?Object.getOwnPropertyDescriptor(a,d.name):{});for(var k,l=!1,m=c.length-1;m>=0;m--){k={};for(var n in d)k[n]=n==="access"?{}:d[n];for(n in d.access)k.access[n]=d.access[n];k.addInitializer=function(h){if(l)throw new TypeError("Cannot add initializers after decoration has completed");f.push(g(h||null));};var o=(0,c[m])(i==="accessor"?{get:b.get,set:b.set}:b[j],k);if(i==="accessor"){if(o!==void 0){if(o===null||typeof o!=="object")throw new TypeError("Object expected");if(k=g(o.get))b.get=k;if(k=g(o.set))b.set=k;(k=g(o.init))&&e.unshift(k);}}else if(k=g(o))i==="field"?e.unshift(k):b[j]=k;}a&&Object.defineProperty(a,d.name,b);l=!0;};',
    );
  }
  if (helperKeys.has("closure-template-object")) {
    lines.push(
      "_[5]=function(a){a.raw=a;Object.freeze&&Object.freeze(a);return a;};",
    );
  }
  if (helperKeys.has("closure-inherits")) {
    lines.push(
      '_[6]=function(a,b){a.prototype=Object.create(b.prototype);a.prototype.constructor=a;if(Object.setPrototypeOf)Object.setPrototypeOf(a,b);else for(var c in b)if(c!="prototype")if(Object.defineProperties){var d=Object.getOwnPropertyDescriptor(b,c);d&&Object.defineProperty(a,c,d);}else a[c]=b[c];a.lc=b.prototype;};',
    );
  }
  return lines.join("");
}
