use napi_derive::napi;

/// A Rollup output chunk, serialized by the Vite plugin at `generateBundle`.
///
/// `fileName` is the identity: Rollup chunk `name`s are not unique, file names
/// are. Import edges therefore travel as file names too. `moduleFiles` are
/// materialized source files relative to the build source root, already joined
/// from Rollup module ids by the plugin; modules with no materialized file
/// (CSS, assets, anything Rollup dropped) are absent.
#[allow(non_snake_case)]
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RollupChunkInput {
    pub dynamicImportedChunkFileNames: Vec<String>,
    pub fileName: String,
    pub importedChunkFileNames: Vec<String>,
    pub isEntry: bool,
    pub moduleFiles: Vec<String>,
    pub name: String,
}
