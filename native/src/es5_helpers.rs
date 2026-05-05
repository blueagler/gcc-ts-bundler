mod kinds;
mod rewrite;
mod utils;

use std::path::PathBuf;

use napi_derive::napi;
use swc_core::ecma::visit::VisitMutWith;

use crate::module_cache::parse_module;

use self::rewrite::Es5HelperChunkRewriter;
use self::utils::print_module_minified;

#[napi(object)]
pub struct Es5HelperRewriteOutput {
    pub code: String,
    #[napi(js_name = "helperKeys")]
    pub helper_keys: Vec<String>,
}

pub fn rewrite_bundler_runtime_es5_helpers(
    code: String,
) -> std::result::Result<Es5HelperRewriteOutput, String> {
    let mut module = parse_module(&PathBuf::from("bundler-runtime-es5.js"), &code)?;
    let mut rewriter = Es5HelperChunkRewriter::new();
    module.visit_mut_with(&mut rewriter);
    let rewritten_code = if rewriter.changed {
        print_module_minified(&module)?
    } else {
        code
    };
    Ok(Es5HelperRewriteOutput {
        code: rewritten_code,
        helper_keys: rewriter
            .helper_kinds
            .into_iter()
            .map(|kind| kind.key().to_string())
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::rewrite_bundler_runtime_es5_helpers;

    #[test]
    fn rewrites_shared_es5_helper_families() {
        let code = r#"
          (function(global){global.__g=global.__g||{};}).call(this, globalThis);
          M("m0", function(a){
            function e(u,w,C,z,g){if(z==="m")throw new TypeError("Private method is not writable");if(z==="a"&&!g)throw new TypeError("Private accessor was defined without a setter");if(typeof w==="function"?u!==w||!g:!w.has(u))throw new TypeError("Cannot write private member to an object whose class did not declare it");return z==="a"?g.call(u,C):g?g.value=C:w.set(u,C),C;}
            function l(u,w,C,z){if(C==="a"&&!z)throw new TypeError("Private accessor was defined without a getter");if(typeof w==="function"?u!==w||!z:!w.has(u))throw new TypeError("Cannot read private member from an object whose class did not declare it");return C==="m"?z:C==="a"?z.call(u):z?z.value:w.get(u);}
            function n(u,w,C){typeof w==="symbol"&&(w=w.description?"[".concat(w.description,"]"):"");return Object.defineProperty(u,"name",{configurable:!0,value:C?"".concat(C," ",w):w});}
            function r(u,w,C){for(var z=arguments.length>2,g=0;g<w.length;g++)C=z?w[g].call(u,C):w[g].call(u);return z?C:void 0;}
            function q(u,w,C,z,g,c){function k(Q){if(Q!==void 0&&typeof Q!=="function")throw new TypeError("Function expected");return Q;}var p=z.kind,t=p==="getter"?"get":p==="setter"?"set":"value";u=!w&&u?z["static"]?u:u.prototype:null;w=w||(u?Object.getOwnPropertyDescriptor(u,z.name):{});for(var m,A=!1,G=C.length-1;G>=0;G--){m={};for(var E in z)m[E]=E==="access"?{}:z[E];for(E in z.access)m.access[E]=z.access[E];m.addInitializer=function(Q){if(A)throw new TypeError("Cannot add initializers after decoration has completed");c.push(k(Q||null));};var K=(0,C[G])(p==="accessor"?{get:w.get,set:w.set}:w[t],m);if(p==="accessor"){if(K!==void 0){if(K===null||typeof K!=="object")throw new TypeError("Object expected");if(m=k(K.get))w.get=m;if(m=k(K.set))w.set=m;(m=k(K.init))&&g.unshift(m);}}else if(m=k(K))p==="field"?g.unshift(m):w[t]=m;}u&&Object.defineProperty(u,z.name,w);A=!0;}
            var P = new WeakMap;
            n(foo, "Foo");
            q(foo, null, [], {kind:"method", name:"bar", access:{}}, [], []);
            r(foo, []);
            e(foo, P, 1, "f");
            l(foo, P, "f");
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten.helper_keys.contains(&"es-decorate".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"run-initializers".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"set-function-name".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"class-private-field-get".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"class-private-field-set".to_string()));
        assert!(!rewritten
            .code
            .contains("Cannot add initializers after decoration has completed"));
    }

    #[test]
    fn rewrites_shared_closure_support_references() {
        let code = r#"
          M("m0", function(a){
            var tpl = ta(["x"]);
            function Child() { return Parent.apply(this, arguments) || this; }
            qa(Child, Parent);
            ha.Object.defineProperties(Child.prototype, {});
            return tpl;
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten
            .helper_keys
            .contains(&"closure-template-object".to_string()));
        assert!(rewritten
            .helper_keys
            .contains(&"closure-inherits".to_string()));
        assert!(!rewritten.code.contains("ta(["));
        assert!(!rewritten.code.contains("qa(Child,Parent)"));
        assert!(rewritten
            .code
            .contains("globalThis.Object.defineProperties"));
    }

    #[test]
    fn leaves_shadowed_short_local_names_alone() {
        let code = r#"
          M("m0", function(a){
            function render(){
              var tpl = 0, ta = 1, qa = 2, ha = {};
              x(ta, qa, ha);
            }
            render();
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(!rewritten.code.contains("var G=globalThis.__g,_=G._;"));
        assert!(rewritten.code.contains("x(ta, qa, ha)"));
        assert!(!rewritten.code.contains("_[5]"));
        assert!(!rewritten.code.contains("_[6]"));
    }

    #[test]
    fn rewrites_top_level_closure_global_without_helper_slot() {
        let code = r#"
          M("m0", function(a){
            function Child() {}
            ha.Object.defineProperties(Child.prototype, {});
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(!rewritten
            .helper_keys
            .contains(&"closure-global".to_string()));
        assert!(rewritten
            .code
            .contains("globalThis.Object.defineProperties"));
        assert!(!rewritten.code.contains("ha.Object.defineProperties"));
    }

    #[test]
    fn leaves_shadowed_nested_function_params_alone() {
        let code = r#"
          M("m0", function(a){
            p(0, {
              children: function(ha){
                var ia = q();
                k(ha, ia);
              }
            });
          });
        "#;
        let rewritten = rewrite_bundler_runtime_es5_helpers(code.to_string()).unwrap();
        assert!(rewritten.code.contains("k(ha, ia)"));
    }
}
