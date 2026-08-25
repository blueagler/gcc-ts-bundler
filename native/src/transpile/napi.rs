use napi_derive::napi;

use crate::closure_metadata::EmittedTypeMetadata;

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub explicitExternPropertyCount: u32,
    pub externsPath: String,
    pub preservedImports: Vec<PreservedImportOutput>,
    pub supportFiles: Vec<String>,
    pub typeMetadata: Vec<EmittedTypeMetadata>,
    pub warnings: Vec<String>,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PackageAliasInput {
    pub packageName: String,
    pub subpath: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedModuleInput {
    pub exportNames: Vec<String>,
    pub filePath: String,
    pub hasDefaultExport: bool,
    pub moduleId: String,
    pub outputRelativePath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PreservedImportOutput {
    pub boundaryExports: Vec<String>,
    pub boundaryNames: Vec<String>,
    pub externalSpecifier: Option<String>,
    pub importClause: String,
    pub importerFilePath: String,
    pub targetModuleId: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ExternalBoundaryInput {
    pub importerFilePath: String,
    pub specifier: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ResolvedImportInput {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LazyImportInput {
    pub importerFilePath: String,
    pub moduleId: String,
    pub specifier: String,
    pub targetPath: String,
}

#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct TranspileChunkInput {
    /// Names of the chunks the loader guarantees have executed before this
    /// one. Read by `build_hoist_plan` to decide whether a cross-chunk direct
    /// binding is legal.
    pub dependencies: Vec<String>,
    pub files: Vec<String>,
    pub name: String,
}

/// A runtime call whose object-literal argument keys must survive property
/// renaming (framework class-map/vnode helpers). Supplied by framework
/// presets. When `keyPattern` is set, only matching keys are quoted.
#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClassMapCallInput {
    pub argIndex: u32,
    pub callee: String,
    /// Keys matching this regex are left alone even when `keyPattern`
    /// admits them.
    pub keyExcludePattern: Option<String>,
    pub keyPattern: Option<String>,
    /// When set, the rule applies only if the argument at this index is a
    /// string literal or an immutable value produced by another matching
    /// literal-gated call. This lets element transforms such as cloneElement
    /// inherit proven host-element provenance without freezing component props.
    pub stringLiteralArgIndex: Option<u32>,
    /// When set, the rule matches only when the callee binding was imported
    /// from a module whose specifier matches this regex. Callee spelling is
    /// local and meaningless for default imports and compiler-generated
    /// aliases, so import identity is what a rule can rely on.
    pub calleeModulePattern: Option<String>,
    /// Where the keys of the pinned map live in the matched argument:
    ///
    /// * `"objectLiteral"` (default) - keys of an object literal argument;
    /// * `"pairArray"` - first elements of the entries of an array-literal
    ///   argument, the `[["render", fn], ["__scopeId", id]]` shape helper
    ///   functions splat onto a target with `target[key] = value`.
    pub keySource: Option<String>,
}
