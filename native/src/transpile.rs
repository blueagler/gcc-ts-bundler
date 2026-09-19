pub(crate) mod assigners;
mod cjs_opacity;
mod commonjs;
mod compat;
mod compat_properties;
mod context;
mod emit;
mod emit_goog;
pub(crate) mod emit_helpers;
mod emit_hoist;
mod emit_reflective;
mod emit_runtime;
mod externs;
mod fresh;
mod global_this;
mod hoist;
mod identity;
mod imports_exports;
mod js_compat;
mod lowering;
mod namespace;
mod napi;
mod nocollapse;
mod pure_calls;
mod quote_keys;
mod transform;
mod transpile_plan;
mod transpile_run;
mod transpile_write;

mod type_metadata;
mod type_metadata_oxc;

pub(crate) use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
pub(crate) use std::path::{Path, PathBuf};

#[cfg(test)]
pub(crate) use crate::closure_metadata::closure_metadata_key;
pub(crate) use crate::closure_metadata::{ClosureEnumDeclaration, ClosureFileMetadata};
pub(crate) use crate::pathing::{to_bundler_runtime_module_id, to_goog_module_id};

pub(crate) use self::cjs_opacity::*;
#[cfg(test)]
pub(crate) use self::compat::*;
pub(crate) use self::context::*;

pub(crate) use self::externs::*;
pub(crate) use self::hoist::*;
pub(crate) use self::imports_exports::*;
pub(crate) use self::js_compat::*;
#[cfg(test)]
pub(crate) use self::transpile_plan::parse_oxc_program;
pub(crate) use self::transpile_run::{resolve_relative_module, transpile_sources};
pub use napi::*;

pub fn emit_preserved_module(file_path: String, source: String) -> Result<String, String> {
    lowering::emit_preserved_module(Path::new(&file_path), &source)
}
