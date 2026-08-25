//! Oxc hoisted bundler-runtime emitter.

mod assembly;
mod emit;
mod helpers;
mod import_plan;
mod imports;
mod renames;

pub(crate) use emit::{emit_hoisted_module_text, HoistedModuleOptions};
