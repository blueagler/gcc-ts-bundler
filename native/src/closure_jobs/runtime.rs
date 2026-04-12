use super::*;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeManifest {
    pub(super) baseChunk: String,
    pub(super) chunks: BTreeMap<String, BundlerRuntimeManifestChunk>,
    pub(super) loader: String,
    pub(super) modules: BTreeMap<String, String>,
    pub(super) publicPath: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeManifestChunk {
    pub(super) css: Vec<String>,
    pub(super) deps: Vec<String>,
    pub(super) modules: Vec<String>,
    pub(super) url: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeInitManifest(
    pub(super) usize,
    pub(super) Vec<BundlerRuntimeInitChunk>,
    pub(super) Vec<usize>,
    pub(super) String,
);

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeInitChunk(
    pub(super) Vec<usize>,
    pub(super) String,
    pub(super) Vec<String>,
);

pub(super) fn bundler_runtime_output_file_name(
    chunk_name: &str,
    runtime_chunk_id: &str,
    base_chunk_name: &str,
) -> String {
    if chunk_name == base_chunk_name {
        format!("{chunk_name}.js")
    } else {
        format!("{runtime_chunk_id}.js")
    }
}

pub(super) fn render_bundler_runtime_base_chunk(
    chunk_id: usize,
    entry_points_json: &str,
    _loader: &str,
    manifest_json: &str,
    numeric_module_ids: bool,
    module_text: &str,
    include_custom_elements_es5_adapter: bool,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    let runtime_global = runtime_global_ref("globalThis");
    let mut parts = vec![render_bundler_runtime_preamble(
        manifest_json,
        numeric_module_ids,
        debug_runtime,
    )?];
    if include_custom_elements_es5_adapter {
        parts.push(render_custom_elements_es5_adapter());
    }
    parts.extend([
        format!("var __runtime={runtime_global},__register=__runtime.r;"),
        module_text.to_string(),
        format!("__runtime.l({chunk_id:?});"),
        format!("__runtime.n({entry_points_json});"),
        String::new(),
    ]);
    Ok(parts.join("\n"))
}

pub(super) fn render_bundler_runtime_lazy_chunk(
    chunk_id: usize,
    module_text: &str,
    debug_runtime: bool,
) -> String {
    let runtime_global = runtime_global_ref("globalThis");
    if debug_runtime {
        let fallback_error = "\"base chunk missing\"";
        format!(
            "var __runtime={runtime_global};(__runtime||{{h:function(){{throw Error({fallback_error});}}}}).h(function(__register){{\n{}\n}},{chunk_id:?});\n",
            indent_block(module_text),
            fallback_error = fallback_error,
        )
    } else {
        format!(
            "var __runtime={runtime_global};__runtime.h(function(__register){{\n{}\n}},{chunk_id:?});\n",
            indent_block(module_text),
        )
    }
}

pub(super) fn render_bundler_runtime_preamble(
    manifest_json: &str,
    numeric_module_ids: bool,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    let missing_chunk_error = if debug_runtime {
        "\"unknown chunk \"+a"
    } else {
        "\"c\"+a"
    };
    let missing_module_error = if debug_runtime {
        "\"unknown module \"+a"
    } else {
        "\"m\"+a"
    };
    let script_error = if debug_runtime {
        "\"load \"+a+\" failed\""
    } else {
        "\"l\"+a"
    };
    let style_error = if debug_runtime {
        "\"style \"+a+\" failed\""
    } else {
        "\"s\"+a"
    };
    let storage_init = if numeric_module_ids {
        ["r.f=[];", "r.c=[];", "r.s=[];", "r.d=[];", "r.k=null;", "r.m=[];"]
    } else {
        [
            "r.f=Object.create(null);",
            "r.c=Object.create(null);",
            "r.s=Object.create(null);",
            "r.d=Object.create(null);",
            "r.k=null;",
            "r.m=Object.create(null);",
        ]
    };
    let module_lookup = if numeric_module_ids {
        format!("r.j=function(a){{var b=r.m[a];if(b===void 0)throw Error({missing_module_error});return e(b).then(function(){{return r.q(a);}});}};")
    } else {
        format!("r.j=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{return r.q(a);}});}};")
    };
    let module_preload = if numeric_module_ids {
        format!("r.x=function(a){{var b=r.m[a];if(b===void 0)throw Error({missing_module_error});return e(b).then(function(){{}});}};")
    } else {
        format!("r.x=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{}});}};")
    };
    let manifest_apply = render_manifest_apply(manifest_json);
    let manifest_init = render_manifest_init();
    let env_setup = render_loader_env_setup();
    let loader_specific = render_script_loader_runtime(
        missing_chunk_error,
        script_error,
        style_error,
        numeric_module_ids,
    );
    Ok([
        "(function(global){".to_string(),
        format!(
            "var r={runtime_global}||({runtime_global}={{}});",
            runtime_global = runtime_global_ref("global"),
        ),
        "if(!r.i){".to_string(),
        storage_init.join("\n"),
        "r.b=\"\";".to_string(),
        env_setup,
        "function g(a){var b=r.d[a];if(b)return b;b={};b.p=new Promise(function(c,d){b.r=c;b.j=d});r.d[a]=b;return b;}".to_string(),
        "r.l=function(a){r.s[a]=1;var b=r.d[a];if(b){b.r();delete r.d[a];}};".to_string(),
        "function h(a,b){r.s[a]=2;var c=r.d[a];if(c){c.j(b);delete r.d[a];}}".to_string(),
        "r.r=function(a,b){r.f[a]=b;};".to_string(),
        "r.g=function(a,b,c){Object.defineProperty(a,b,{configurable:!0,enumerable:!0,get:c});};".to_string(),
        "r.h=function(a,b){a(r.r);r.l(b);};".to_string(),
        format!("r.q=function(a){{if(Object.prototype.hasOwnProperty.call(r.c,a))return r.c[a];var b=r.f[a];if(b===void 0)throw Error({missing_module_error});var c=[];r.c[a]=c;b(r.q,c,r.j,r.x,r.g);return c;}};"),
        loader_specific,
        module_lookup,
        module_preload,
        "r.n=function(a){for(var b=0;b<a.length;b+=1)r.q(a[b]);};".to_string(),
        manifest_init,
        "r.i=1;".to_string(),
        "}".to_string(),
        manifest_apply,
        "}).call(this,globalThis);".to_string(),
        String::new(),
    ]
    .join("\n"))
}

fn render_manifest_apply(manifest_json: &str) -> String {
    format!("r.a({manifest_json});")
}

fn render_loader_env_setup() -> String {
    "var d=global.document,l=global.location;".to_string()
}

fn render_manifest_init() -> String {
    "r.a=function(a){r.k=a[1];r.m=a[2];var c=d&&d.currentScript&&d.currentScript.src||l&&l.href||\"./\";r.b=new URL(a[3]||\"./\",c).toString();r.s[a[0]]=1;};".to_string()
}

fn runtime_global_ref(global_name: &str) -> String {
    format!("{global_name}[{BUNDLER_RUNTIME_GLOBAL:?}]")
}

pub(super) fn language_out_requires_es5_adapter(language_out: &str) -> bool {
    matches!(language_out, "ECMASCRIPT3" | "ECMASCRIPT5")
}

pub(super) fn needs_custom_elements_es5_adapter(
    language_out: &str,
    candidate_contents: &str,
) -> bool {
    language_out_requires_es5_adapter(language_out)
        && regex::Regex::new(
            r"\bextends\s+(HTMLElement|Event|CustomEvent|MouseEvent|KeyboardEvent|FocusEvent|UIEvent)\b",
        )
        .map(|regex| regex.is_match(candidate_contents))
        .unwrap_or(true)
}

pub(super) fn render_custom_elements_es5_adapter() -> String {
    [
        "var __gccNativeClassGlobal=globalThis;".to_string(),
        "if(__gccNativeClassGlobal.customElements&&__gccNativeClassGlobal.Reflect&&__gccNativeClassGlobal.Reflect.construct){".to_string(),
        "var __gccPatchNativeClass=function(NativeCtor){".to_string(),
        "if(typeof NativeCtor!=='function')return null;".to_string(),
        "function PatchedCtor(){return __gccNativeClassGlobal.Reflect.construct(NativeCtor,Array.prototype.slice.call(arguments),this.constructor);}".to_string(),
        "PatchedCtor.prototype=NativeCtor.prototype;".to_string(),
        "PatchedCtor.prototype.constructor=PatchedCtor;".to_string(),
        "if(Object.setPrototypeOf){Object.setPrototypeOf(PatchedCtor,NativeCtor);}else{PatchedCtor.__proto__=NativeCtor;}".to_string(),
        "return PatchedCtor;".to_string(),
        "};".to_string(),
        "var __gccPatchedHTMLElement=__gccPatchNativeClass(__gccNativeClassGlobal.HTMLElement);".to_string(),
        "if(__gccPatchedHTMLElement){HTMLElement=__gccNativeClassGlobal.HTMLElement=__gccPatchedHTMLElement;}".to_string(),
        "var __gccPatchedEvent=__gccPatchNativeClass(__gccNativeClassGlobal.Event);".to_string(),
        "if(__gccPatchedEvent){Event=__gccNativeClassGlobal.Event=__gccPatchedEvent;}".to_string(),
        "var __gccPatchedCustomEvent=__gccPatchNativeClass(__gccNativeClassGlobal.CustomEvent);".to_string(),
        "if(__gccPatchedCustomEvent){CustomEvent=__gccNativeClassGlobal.CustomEvent=__gccPatchedCustomEvent;}".to_string(),
        "var __gccPatchedMouseEvent=__gccPatchNativeClass(__gccNativeClassGlobal.MouseEvent);".to_string(),
        "if(__gccPatchedMouseEvent){MouseEvent=__gccNativeClassGlobal.MouseEvent=__gccPatchedMouseEvent;}".to_string(),
        "var __gccPatchedKeyboardEvent=__gccPatchNativeClass(__gccNativeClassGlobal.KeyboardEvent);".to_string(),
        "if(__gccPatchedKeyboardEvent){KeyboardEvent=__gccNativeClassGlobal.KeyboardEvent=__gccPatchedKeyboardEvent;}".to_string(),
        "var __gccPatchedFocusEvent=__gccPatchNativeClass(__gccNativeClassGlobal.FocusEvent);".to_string(),
        "if(__gccPatchedFocusEvent){FocusEvent=__gccNativeClassGlobal.FocusEvent=__gccPatchedFocusEvent;}".to_string(),
        "var __gccPatchedUIEvent=__gccPatchNativeClass(__gccNativeClassGlobal.UIEvent);".to_string(),
        "if(__gccPatchedUIEvent){UIEvent=__gccNativeClassGlobal.UIEvent=__gccPatchedUIEvent;}".to_string(),
        "}".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn indent_block(source: &str) -> String {
    if source.is_empty() {
        return String::new();
    }
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_script_loader_runtime(
    missing_chunk_error: &str,
    script_error: &str,
    style_error: &str,
    numeric_module_ids: bool,
) -> String {
    let chunk_lookup = if numeric_module_ids {
        "var b=r.k[a];"
    } else {
        "var b=r.k&&r.k[a];"
    };
    [
        format!(
            "function u(a){{{chunk_lookup}if(!b)throw Error({missing_chunk_error});return new URL(b[1],r.b).toString();}}"
        ),
        format!("function p(a){{return new Promise(function(c,e){{var f=d.createElement(\"script\");f.async=true;f.src=a;f.onload=function(){{c();}};f.onerror=function(){{e(Error({script_error}));}};(d.head||d.documentElement).appendChild(f);}});}}"),
        render_css_loader_runtime(style_error),
        format!("function e(a){{var b=r.s[a];if(b===1)return Promise.resolve();if(b===0)return g(a).p;{chunk_lookup}if(!b)throw Error({missing_chunk_error});r.s[a]=0;var c=g(a);return Promise.all((b[0]||[]).map(e)).then(function(){{return Promise.all([z(a),p(u(a))]);}}).then(function(){{return c.p;}}).catch(function(d){{h(a,d);throw d;}});}}"),
    ]
    .join("\n")
}

fn render_css_loader_runtime(style_error: &str) -> String {
    [
        "var m=null,n=Object.create(null);".to_string(),
        "function v(){if(m)return m;m=Object.create(null);if(d)for(var a=d.querySelectorAll(\"link[rel=\\\"stylesheet\\\"]\"),b=0;b<a.length;b+=1){var c=a[b].href;c&&(m[c]=1);}return m;}".to_string(),
        format!("function y(a){{var b=v();if(b[a])return Promise.resolve();var c=n[a];if(c)return c;c=new Promise(function(e,f){{var k=d.createElement(\"link\");k.rel=\"stylesheet\";k.href=a;k.onload=function(){{b[a]=1;delete n[a];e();}};k.onerror=function(){{delete n[a];f(Error({style_error}));}};(d.head||d.documentElement).appendChild(k);}});n[a]=c;return c;}}"),
        "function z(a){for(var b=r.k[a],c=b&&b[2]||[],e=[],f=0;f<c.length;f+=1)e.push(y((new URL(c[f],r.b)).toString()));return Promise.all(e);}".to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_chunk_uses_local_runtime_alias_before_closure() {
        let rendered = render_bundler_runtime_base_chunk(
            0,
            "[0]",
            "script",
            "[0,[],[],\"./\"]",
            true,
            "__register(0,function(){});",
            false,
            false,
        )
        .expect("render base chunk");

        assert!(rendered.contains("var __runtime=globalThis[\"__g\"],__register=__runtime.r;"));
        assert!(rendered.contains("__runtime.l(0);"));
        assert!(rendered.contains("__runtime.n([0]);"));
    }

    #[test]
    fn lazy_chunk_uses_local_runtime_alias_before_closure() {
        let rendered = render_bundler_runtime_lazy_chunk(3, "__register(1,function(){});", false);
        assert_eq!(
            rendered,
            "var __runtime=globalThis[\"__g\"];\
__runtime.h(function(__register){\n  __register(1,function(){});\n},3);\n"
        );
    }

    #[test]
    fn specialized_script_preamble_hoists_environment_access() {
        let rendered = render_bundler_runtime_preamble("[0,[],[],\"./\"]", true, false)
            .expect("render preamble");
        assert!(rendered.contains("var d=global.document,l=global.location;"));
        assert!(rendered.contains("return new URL(b[1],r.b).toString();"));
        assert!(rendered.contains("createElement(\"link\")"));
        assert!(rendered.contains("b&&b[2]||[]"));
        assert!(!rendered.contains("r.b||(global.location"));
        assert!(!rendered.contains("global.fetch("));
    }
}
