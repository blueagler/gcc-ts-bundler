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

/// Names the loader helpers are aliased to at the top of every chunk. Every
/// linked chunk input is a *script*, so under ES_MODULES output Closure sees
/// one shared global scope, assigns each surviving global to exactly one
/// output module, and turns the duplicate `var` in every other chunk into a
/// write to an imported binding — a hard `JSC_IMPORT_ASSIGN` error. Suffixing
/// the aliases per chunk keeps each declaration owned by its own chunk.
/// Script mode passes an empty suffix and is byte-identical to before.
pub(super) fn runtime_alias_suffix(
    chunk_index: usize,
    chunk_output_type: ChunkOutputType,
) -> String {
    if chunk_output_type.is_esm() {
        format!("_{chunk_index}")
    } else {
        String::new()
    }
}

/// The single alias line every hoisted chunk opens with. Hoisted module code
/// lives at top level, so the runtime helpers must be plain top-level vars
/// instead of wrapper-function parameters.
fn render_runtime_alias_line(suffix: &str) -> String {
    let runtime_global = runtime_global_ref("globalThis");
    format!("var __runtime{suffix}={runtime_global},__register{suffix}=__runtime{suffix}.r,__require{suffix}=__runtime{suffix}.q,__dynamicImport{suffix}=__runtime{suffix}.j,__preloadDynamicImport{suffix}=__runtime{suffix}.x;")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_bundler_runtime_base_chunk(
    chunk_id: usize,
    entry_points_json: &str,
    _loader: &str,
    manifest_json: &str,
    numeric_module_ids: bool,
    module_text: &str,
    include_custom_elements_es5_adapter: bool,
    debug_runtime: bool,
    chunk_output_type: ChunkOutputType,
    preamble_part: RuntimePreamblePart,
) -> std::result::Result<String, String> {
    let suffix = runtime_alias_suffix(chunk_id, chunk_output_type);
    let mut parts = vec![render_bundler_runtime_preamble_part(
        manifest_json,
        numeric_module_ids,
        debug_runtime,
        chunk_output_type,
        preamble_part,
    )?];
    if include_custom_elements_es5_adapter {
        parts.push(render_custom_elements_es5_adapter());
    }
    // Hoisted module code lives at top level, so the loader helpers are plain
    // top-level vars and the chunk marks itself loaded before running.
    parts.extend([
        render_runtime_alias_line(&suffix),
        format!("__runtime{suffix}.l({chunk_id:?});"),
        module_text.to_string(),
    ]);
    if entry_points_json != "[]" {
        parts.push(format!("__runtime{suffix}.n({entry_points_json});"));
    }
    parts.push(String::new());
    Ok(parts.join("\n"))
}

pub(super) fn render_bundler_runtime_lazy_chunk(
    chunk_id: usize,
    module_text: &str,
    chunk_output_type: ChunkOutputType,
    runtime_core: Option<&str>,
    assigner_names: &[String],
) -> String {
    let suffix = runtime_alias_suffix(chunk_id, chunk_output_type);
    // A vendor chunk runs before base, so it brings the runtime core with it;
    // every other non-base chunk finds the runtime already built.
    let core = runtime_core.unwrap_or_default();
    // Pinning the chunk's state-mutating functions to the loader object is the
    // half of the vendor fix that survives `CrossChunkCodeMotion`; the
    // `@noinline` half lives in `transpile::assigners`. It sits before the
    // `l()` call so it is part of the chunk's own execution, and it uses this
    // chunk's alias so it stays scoped like the alias line above it.
    let pin = crate::transpile::assigners::render_assigner_pin(
        &format!("__runtime{suffix}"),
        assigner_names,
    )
    .map(|pin| format!("{pin}\n"))
    .unwrap_or_default();
    // Hoisted chunks execute at top level on script load; the trailing `l()`
    // is what resolves the loader promise for this chunk.
    format!(
        "{core}{}\n{module_text}\n{pin}__runtime{suffix}.l({chunk_id:?});\n",
        render_runtime_alias_line(&suffix),
    )
}

/// Which half of the runtime preamble a chunk emits.
///
/// Normally one chunk emits both and the two are a single IIFE, byte-for-byte
/// what we have always shipped. A vendor chunk changes that: base's generated
/// `import "./<vendor>.js"` edge makes vendor execute *before* base, so the
/// runtime object base used to create would not exist yet when vendor's alias
/// line dereferences it (verified: `TypeError: Cannot read properties of
/// undefined`). The guarded core therefore moves to whichever chunk runs
/// first, and the manifest stays behind.
///
/// The split is along the app-independence line on purpose. The core is pure
/// loader code that changes only when this file does; `r.a(<manifest>)`
/// carries chunk URLs that change on every app edit. Keeping the manifest in
/// base is what lets the vendor chunk keep its filename across app edits,
/// which is the entire point of the vendor chunk.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RuntimePreamblePart {
    /// Core and manifest together, as one IIFE.
    All,
    /// The guarded, app-independent core only.
    Core,
    /// `r.a(<manifest>)` only, for a chunk whose core ran earlier.
    ManifestOnly,
}

pub(super) fn render_bundler_runtime_preamble_part(
    manifest_json: &str,
    numeric_module_ids: bool,
    debug_runtime: bool,
    chunk_output_type: ChunkOutputType,
    part: RuntimePreamblePart,
) -> std::result::Result<String, String> {
    if part == RuntimePreamblePart::ManifestOnly {
        // `r.i` is set by the core, so this can only run after it. Reading the
        // global rather than creating it keeps a missing core loud instead of
        // silently half-initialising the runtime.
        return Ok([
            "(function(global){".to_string(),
            format!("var r={};", runtime_global_ref("global")),
            render_manifest_apply(manifest_json),
            "}).call(this,globalThis);".to_string(),
            String::new(),
        ]
        .join("\n"));
    }
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
        [
            "r.f=[];",
            "r.c=[];",
            "r.s=[];",
            "r.d=[];",
            "r.k=null;",
            "r.m=[];",
        ]
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
    let manifest_init = render_manifest_init(chunk_output_type);
    let env_setup = render_loader_env_setup();
    let loader_specific = if chunk_output_type.is_esm() {
        render_esm_loader_runtime(missing_chunk_error, style_error, numeric_module_ids)
    } else {
        render_script_loader_runtime(
            missing_chunk_error,
            script_error,
            style_error,
            numeric_module_ids,
        )
    };
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
        "r.g=function(a,b,c){if(typeof c===\"function\"){Object.defineProperty(a,b,{configurable:!0,enumerable:!0,get:c});return;}for(var d=0;d<c.length;d+=2)!function(e,f){Object.defineProperty(a,e,{configurable:!0,enumerable:!0,get:function(){return b[f];}})}(c[d],c[d+1]);};".to_string(),
        format!("r.q=function(a){{if(Object.prototype.hasOwnProperty.call(r.c,a))return r.c[a];var b=r.f[a];if(b===void 0)throw Error({missing_module_error});var c=[];r.c[a]=c;b(r.q,c,r.j,r.x,r.g);return c;}};"),
        loader_specific,
        module_lookup,
        module_preload,
        "r.n=function(a){for(var b=0;b<a.length;b+=1)r.q(a[b]);};".to_string(),
        manifest_init,
        "r.i=1;".to_string(),
        "}".to_string(),
    ]
    .into_iter()
    .chain((part == RuntimePreamblePart::All).then_some(manifest_apply))
    .chain(["}).call(this,globalThis);".to_string(), String::new()])
    .collect::<Vec<_>>()
    .join("\n"))
}

fn render_manifest_apply(manifest_json: &str) -> String {
    format!("r.a({manifest_json});")
}

fn render_loader_env_setup() -> String {
    "var d=global.document,l=global.location;".to_string()
}

fn render_manifest_init(chunk_output_type: ChunkOutputType) -> String {
    if chunk_output_type.is_esm() {
        // Module scripts always have `document.currentScript === null`, so the
        // script-mode derivation is dead code here. JS needs no base at all:
        // chunk specifiers are relative and `import()` resolves them against
        // the importing module's own URL. `r.b` survives only as the base for
        // CSS hrefs, which is why the document URL is still read.
        return "r.a=function(a){r.k=a[1];r.m=a[2];r.b=new URL(a[3]||\"./\",l&&l.href||\"./\").toString();r.s[a[0]]=1;};".to_string();
    }
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
        // async=false keeps dynamically inserted scripts executing in
        // insertion order, so hoisted dependency chunks run before dependents.
        format!("function p(a){{return new Promise(function(c,e){{var f=d.createElement(\"script\");f.async=false;f.src=a;f.onload=function(){{c();}};f.onerror=function(){{e(Error({script_error}));}};(d.head||d.documentElement).appendChild(f);}});}}"),
        render_css_loader_runtime(style_error),
        // Dependency scripts are inserted synchronously before this chunk's own
        // script, so ordered (async=false) execution matches dependency order
        // while all requests still fetch in parallel.
        format!("function e(a){{var b=r.s[a];if(b===1)return Promise.resolve();if(b===0)return g(a).p;{chunk_lookup}if(!b)throw Error({missing_chunk_error});r.s[a]=0;var c=g(a),w=(b[0]||[]).map(e);w.push(Promise.all([z(a),p(u(a))]));return Promise.all(w).then(function(){{return c.p;}}).catch(function(d){{h(a,d);throw d;}});}}"),
    ]
    .join("\n")
}

/// ES_MODULES loader. Everything the script loader does survives — the chunk
/// state table, the dependency-parallel fetch that keeps the waterfall one
/// round trip deep, CSS loading in parallel with the chunk, the module
/// registry and error propagation. Only the two script-specific helpers go
/// away: `u(a)` (URL resolution against `r.b`) and `p(a)` (`<script>` element
/// injection) collapse into a single `import(specifier)`, because a relative
/// specifier resolves against the importing chunk's own URL.
fn render_esm_loader_runtime(
    missing_chunk_error: &str,
    style_error: &str,
    numeric_module_ids: bool,
) -> String {
    let chunk_lookup = if numeric_module_ids {
        "var b=r.k[a];"
    } else {
        "var b=r.k&&r.k[a];"
    };
    [
        render_css_loader_runtime(style_error),
        format!("function e(a){{var b=r.s[a];if(b===1)return Promise.resolve();if(b===0)return g(a).p;{chunk_lookup}if(!b)throw Error({missing_chunk_error});r.s[a]=0;var c=g(a),w=(b[0]||[]).map(e);w.push(Promise.all([z(a),import(b[1])]));return Promise.all(w).then(function(){{return c.p;}}).catch(function(d){{h(a,d);throw d;}});}}"),
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

    const HOISTED_ALIAS_LINE: &str = "var __runtime=globalThis[\"__g\"],__register=__runtime.r,__require=__runtime.q,__dynamicImport=__runtime.j,__preloadDynamicImport=__runtime.x;";

    #[test]
    fn hoisted_base_chunk_puts_module_code_at_top_level() {
        let rendered = render_bundler_runtime_base_chunk(
            0,
            "[0]",
            "script",
            "[0,[],[],\"./\"]",
            true,
            "__register(0,function(){});",
            false,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render base chunk");

        assert!(rendered.contains(HOISTED_ALIAS_LINE), "{rendered}");
        assert!(rendered.contains("__runtime.l(0);"));
        assert!(
            !rendered.contains("(function(__require,__dynamicImport,__preloadDynamicImport){"),
            "{rendered}"
        );
        assert!(!rendered.contains("})(__runtime.q,__runtime.j,__runtime.x);"));
        assert!(rendered.contains("__runtime.n([0]);"));
        // The prelude marker postprocess keys the ES5 helper bag off must survive.
        assert!(rendered.contains(").call(this,globalThis);"));
        let alias_at = rendered.find(HOISTED_ALIAS_LINE).unwrap();
        assert!(alias_at < rendered.find("__runtime.l(0);").unwrap());
        assert!(
            rendered.find("__runtime.l(0);").unwrap() < rendered.find("__register(0,").unwrap()
        );
    }

    #[test]
    fn base_chunk_skips_entry_execution_when_no_registry_entries_remain() {
        let rendered = render_bundler_runtime_base_chunk(
            0,
            "[]",
            "script",
            "[0,[],[],\"./\"]",
            true,
            "var hoisted$$0 = 1;",
            false,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render base chunk");

        assert!(!rendered.contains("__runtime.n("));
    }

    #[test]
    fn hoisted_lazy_chunk_executes_at_top_level_and_signals_completion() {
        let rendered = render_bundler_runtime_lazy_chunk(
            3,
            "__register(1,function(){});",
            ChunkOutputType::Script,
            None,
            &[],
        );
        assert_eq!(
            rendered,
            format!("{HOISTED_ALIAS_LINE}\n__register(1,function(){{}});\n__runtime.l(3);\n")
        );
        assert!(!rendered.contains("__runtime.h("));
    }

    #[test]
    fn specialized_script_preamble_hoists_environment_access() {
        let rendered = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render preamble");
        assert!(rendered.contains("var d=global.document,l=global.location;"));
        // Ordered execution for hoisted chunks.
        assert!(rendered.contains("f.async=false;"));
        // `r.h` was the deferral entry point of the deleted registry chunk
        // format; every chunk now executes at top level and calls `r.l`.
        assert!(!rendered.contains("r.h="), "{rendered}");
        assert!(rendered.contains("r.l=function(a){"), "{rendered}");
        // Dependency scripts are inserted before the target chunk's script.
        assert!(
            rendered
                .contains("var c=g(a),w=(b[0]||[]).map(e);w.push(Promise.all([z(a),p(u(a))]));"),
            "{rendered}"
        );
        assert!(rendered.contains("return new URL(b[1],r.b).toString();"));
        assert!(rendered.contains("createElement(\"link\")"));
        assert!(rendered.contains("b&&b[2]||[]"));
        assert!(!rendered.contains("r.b||(global.location"));
        assert!(!rendered.contains("global.fetch("));
    }

    #[test]
    fn esm_chunks_get_per_chunk_unique_runtime_aliases() {
        // Every linked input is a script sharing one global scope, so an
        // unsuffixed duplicate `var __register` in a non-base chunk becomes a
        // write to an imported binding: JSC_IMPORT_ASSIGN, a hard error.
        let base = render_bundler_runtime_base_chunk(
            0,
            "[]",
            "script",
            "[0,[],[],\"./\"]",
            true,
            "__register(0,function(){});",
            false,
            false,
            ChunkOutputType::Esm,
            RuntimePreamblePart::All,
        )
        .expect("render base chunk");
        assert!(base.contains("var __runtime_0=globalThis[\"__g\"],__register_0=__runtime_0.r,__require_0=__runtime_0.q,__dynamicImport_0=__runtime_0.j,__preloadDynamicImport_0=__runtime_0.x;"), "{base}");
        assert!(base.contains("__runtime_0.l(0);"), "{base}");

        let lazy = render_bundler_runtime_lazy_chunk(
            3,
            "__register_3(1,function(){});",
            ChunkOutputType::Esm,
            None,
            &[],
        );
        assert_eq!(
            lazy,
            "var __runtime_3=globalThis[\"__g\"],__register_3=__runtime_3.r,__require_3=__runtime_3.q,__dynamicImport_3=__runtime_3.j,__preloadDynamicImport_3=__runtime_3.x;\n__register_3(1,function(){});\n__runtime_3.l(3);\n"
        );
    }

    #[test]
    fn runtime_core_is_idempotent_and_the_manifest_half_stands_alone() {
        // The core moves to whichever chunk runs first, so two chunks could
        // end up carrying it after a future plan change. The `if(!r.i)` guard
        // is what makes that a no-op instead of a reset that would clobber
        // the chunk-state table an earlier `l()` already wrote.
        let core = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Esm,
            RuntimePreamblePart::Core,
        )
        .expect("render core");
        assert!(core.contains("if(!r.i){"), "{core}");
        assert!(core.contains("r.i=1;"), "{core}");
        // The core is app-independent: no manifest, so a vendor chunk keeps
        // its bytes across app edits, which is the point of the split.
        assert!(!core.contains("r.a("), "{core}");
        assert!(
            core.contains("var r=global[\"__g\"]||(global[\"__g\"]={});"),
            "{core}"
        );

        let manifest_only = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Esm,
            RuntimePreamblePart::ManifestOnly,
        )
        .expect("render manifest half");
        assert!(
            manifest_only.contains("r.a([0,[],[],\"./\"]);"),
            "{manifest_only}"
        );
        assert!(!manifest_only.contains("if(!r.i){"), "{manifest_only}");
        // Reads the global rather than creating it: a missing core must fail
        // loudly instead of half-initialising the runtime.
        assert!(
            manifest_only.contains("var r=global[\"__g\"];"),
            "{manifest_only}"
        );

        // Split in half, joined back: same content as the combined form, so
        // the two halves cannot drift from the single-preamble path.
        let all = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Esm,
            RuntimePreamblePart::All,
        )
        .expect("render preamble");
        assert!(all.contains("if(!r.i){"), "{all}");
        assert!(all.contains("r.a([0,[],[],\"./\"]);"), "{all}");
        assert_eq!(all.matches(").call(this,globalThis);").count(), 1, "{all}");
    }

    #[test]
    fn esm_preamble_loads_chunks_with_dynamic_import() {
        let rendered = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Esm,
            RuntimePreamblePart::All,
        )
        .expect("render preamble");

        // The script-injection half is gone: no element creation, no URL
        // resolution against r.b for JS.
        assert!(
            !rendered.contains("createElement(\"script\")"),
            "{rendered}"
        );
        assert!(!rendered.contains("f.async=false;"), "{rendered}");
        assert!(
            !rendered.contains("return new URL(b[1],r.b).toString();"),
            "{rendered}"
        );
        assert!(!rendered.contains("currentScript"), "{rendered}");

        // Everything that preserves the one-round-trip waterfall stays:
        // dependency-parallel fetch, CSS in parallel with the chunk.
        assert!(
            rendered.contains(
                "var c=g(a),w=(b[0]||[]).map(e);w.push(Promise.all([z(a),import(b[1])]));"
            ),
            "{rendered}"
        );
        assert!(rendered.contains("createElement(\"link\")"), "{rendered}");
        assert!(rendered.contains("b&&b[2]||[]"), "{rendered}");
        // Registry, chunk state table and error propagation are untouched.
        // `r.h` is gone with the registry chunk format; `h` (lower case) is a
        // different, still-live helper that fails a chunk's load promise.
        assert!(!rendered.contains("r.h="), "{rendered}");
        assert!(rendered.contains("r.q=function(a){"), "{rendered}");
        assert!(rendered.contains("function h(a,b){r.s[a]=2;"), "{rendered}");
        // CSS still needs a base URL; the document URL replaces currentScript.
        assert!(
            rendered.contains("r.b=new URL(a[3]||\"./\",l&&l.href||\"./\").toString();"),
            "{rendered}"
        );
        // The marker postprocess keys the ES5 helper bag off must survive.
        assert!(rendered.contains(").call(this,globalThis);"), "{rendered}");
    }

    #[test]
    fn script_mode_output_is_unchanged_by_the_esm_variant() {
        // Regression guard: script mode must stay byte-identical, since it is
        // the escape hatch for ES5 targets, workers and split mode.
        let base = render_bundler_runtime_base_chunk(
            0,
            "[0]",
            "script",
            "[0,[],[],\"./\"]",
            true,
            "__register(0,function(){});",
            false,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render base chunk");
        assert!(base.contains(HOISTED_ALIAS_LINE), "{base}");
        assert!(!base.contains("__runtime_0"), "{base}");

        let preamble = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render preamble");
        assert!(preamble.contains("createElement(\"script\")"), "{preamble}");
        assert!(
            preamble.contains("d&&d.currentScript&&d.currentScript.src"),
            "{preamble}"
        );
        assert!(
            preamble.contains("w.push(Promise.all([z(a),p(u(a))]));"),
            "{preamble}"
        );
        assert!(!preamble.contains("import("), "{preamble}");
    }

    #[test]
    fn live_export_helper_supports_packed_alias_mode() {
        let rendered = render_bundler_runtime_preamble_part(
            "[0,[],[],\"./\"]",
            true,
            false,
            ChunkOutputType::Script,
            RuntimePreamblePart::All,
        )
        .expect("render preamble");
        assert!(rendered.contains("typeof c===\"function\""), "{rendered}");
        assert!(
            rendered.contains("for(var d=0;d<c.length;d+=2)"),
            "{rendered}"
        );
        assert!(rendered.contains("return b[f];"), "{rendered}");
    }
}
