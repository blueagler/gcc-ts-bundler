use napi_derive::napi;

/// A Rollup output chunk, serialized by the Vite plugin at `generateBundle`.
///
/// `fileName` is the identity: Rollup chunk `name`s are not unique, file names
/// are. Import edges therefore travel as file names too. `moduleFiles` are
/// materialized source files relative to the build source root, already joined
/// from Rollup module ids by the plugin; modules with no materialized file
/// (CSS, assets, anything Rollup dropped) are absent.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RollupChunkInput {
    #[napi(js_name = "fileName")]
    pub file_name: String,
    #[napi(js_name = "importedChunkFileNames")]
    pub imported_chunk_file_names: Vec<String>,
    #[napi(js_name = "isEntry")]
    pub is_entry: bool,
    #[napi(js_name = "moduleFiles")]
    pub module_files: Vec<String>,
    pub name: String,
}
