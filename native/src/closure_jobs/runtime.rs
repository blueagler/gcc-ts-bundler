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
    pub(super) deps: Vec<String>,
    pub(super) modules: Vec<String>,
    pub(super) url: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeInitManifest(
    pub(super) usize,
    pub(super) Vec<BundlerRuntimeInitChunk>,
    pub(super) BTreeMap<String, usize>,
    pub(super) String,
);

#[derive(Clone, Debug, Serialize)]
pub(super) struct BundlerRuntimeInitChunk(pub(super) Vec<usize>, pub(super) String);

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
    entry_points: &[String],
    loader: &str,
    manifest: &BundlerRuntimeInitManifest,
    module_text: &str,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    Ok([
        render_bundler_runtime_preamble(loader, manifest, debug_runtime)?,
        "var __register=globalThis.__g.r;".to_string(),
        module_text.to_string(),
        format!(
            "globalThis.{runtime_key}.l({chunk_id:?});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL
        ),
        format!(
            "globalThis.{runtime_key}.n({entry_points});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL,
            entry_points = serde_json::to_string(entry_points).map_err(|error| error.to_string())?,
        ),
        String::new(),
    ]
    .join("\n"))
}

pub(super) fn render_bundler_runtime_lazy_chunk(
    chunk_id: usize,
    module_text: &str,
    debug_runtime: bool,
) -> String {
    [
        "(function(g){".to_string(),
        if debug_runtime {
            "if(!g)throw Error(\"base chunk missing\");".to_string()
        } else {
            "if(!g)throw Error(\"b\");".to_string()
        },
        "var __register=g.r;".to_string(),
        module_text.to_string(),
        format!("g.l({chunk_id:?});"),
        format!(
            "}}).call(this,globalThis.{runtime_key});",
            runtime_key = BUNDLER_RUNTIME_GLOBAL
        ),
        String::new(),
    ]
    .join("\n")
}

pub(super) fn render_bundler_runtime_preamble(
    loader: &str,
    manifest: &BundlerRuntimeInitManifest,
    debug_runtime: bool,
) -> std::result::Result<String, String> {
    let manifest_json = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
    let loader_code = match loader {
        "script" => 1,
        "fetch" => 2,
        _ => 0,
    };
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
    let fetch_error = if debug_runtime {
        "\"fetch \"+a+\" failed (\"+c.status+\")\""
    } else {
        "\"f\"+a"
    };
    let fetch_eval = if debug_runtime {
        "(0,global.eval)(c+\"\\n//# sourceURL=\"+b);"
    } else {
        "(0,global.eval)(c);"
    };
    Ok([
        "(function(global){".to_string(),
        format!("var r=global.{BUNDLER_RUNTIME_GLOBAL}||(global.{BUNDLER_RUNTIME_GLOBAL}={{}});"),
        "if(!r.i){".to_string(),
        "r.f=Object.create(null);".to_string(),
        "r.c=Object.create(null);".to_string(),
        "r.s=Object.create(null);".to_string(),
        "r.d=Object.create(null);".to_string(),
        "r.b=\"\";".to_string(),
        "r.o=0;".to_string(),
        "r.k=null;".to_string(),
        "r.m=null;".to_string(),
        format!("function u(a){{var b=r.k&&r.k[a];if(!b)throw Error({missing_chunk_error});return new URL(b[1],r.b||(global.location&&global.location.href?global.location.href:\"./\")).toString();}}"),
        "function g(a){var b=r.d[a];if(b)return b;b={};b.p=new Promise(function(c,d){b.r=c;b.j=d});r.d[a]=b;return b;}".to_string(),
        "r.l=function(a){r.s[a]=1;var b=r.d[a];if(b){b.r();delete r.d[a];}};".to_string(),
        "function h(a,b){r.s[a]=2;var c=r.d[a];if(c){c.j(b);delete r.d[a];}}".to_string(),
        "r.r=function(a,b,c){r.f[a]=c;};".to_string(),
        format!("r.q=function(a){{if(Object.prototype.hasOwnProperty.call(r.c,a))return r.c[a];var b=r.f[a];if(!b)throw Error({missing_module_error});var c=[];r.c[a]=c;b(r.q,c,r.j,r.x);return c;}};"),
        format!("function p(a,b){{return new Promise(function(c,d){{var e=global.document.createElement(\"script\");e.async=true;e.src=b;e.onload=function(){{c();}};e.onerror=function(){{d(Error({script_error}));}};(global.document.head||global.document.documentElement).appendChild(e);}});}}"),
        format!("function w(a,b){{return Promise.resolve(global.fetch(b)).then(function(c){{if(!c.ok)throw Error({fetch_error});return c.text();}}).then(function(c){{{fetch_eval}}});}}"),
        "function t(){return r.o===1?1:r.o===2?2:global.document?1:2;}".to_string(),
        format!("function e(a){{var b=r.s[a];if(b===1)return Promise.resolve();if(b===0)return g(a).p;var c=r.k&&r.k[a];if(!c)throw Error({missing_chunk_error});r.s[a]=0;var d=g(a),f=t();return Promise.all((c[0]||[]).map(function(j){{return e(j);}})).then(function(){{var j=u(a);return f===2?w(a,j):p(a,j);}}).then(function(){{return d.p;}}).catch(function(j){{h(a,j);throw j;}});}}"),
        format!("r.j=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{return r.q(a);}});}};"),
        format!("r.x=function(a){{var b=r.m&&r.m[a];if(!b)throw Error({missing_module_error});return e(b).then(function(){{}});}};"),
        "r.n=function(a){for(var b=0;b<a.length;b+=1)r.q(a[b]);};".to_string(),
        "r.a=function(a,b){r.k=a[1];r.m=a[2];r.o=b;var c=global.document&&global.document.currentScript&&global.document.currentScript.src?global.document.currentScript.src:(global.location&&global.location.href?global.location.href:\"./\");r.b=new URL(a[3]||\"./\",c).toString();r.s[a[0]]=1;};".to_string(),
        "r.i=1;".to_string(),
        "}".to_string(),
        format!("r.a({manifest_json},{loader_code});"),
        "}).call(this,globalThis);".to_string(),
        String::new(),
    ]
    .join("\n"))
}
