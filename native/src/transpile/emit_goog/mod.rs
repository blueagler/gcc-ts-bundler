//! Oxc text-assembly core for `emit_goog.rs`.
//!
//! Type-metadata statement decoration remains owned by the later
//! `type_metadata` slice; this module ports the module/import/export assembly,
//! live-binding rewrite, and every direct statement/expression print to oxc.

mod external;
mod imports;
mod live_bindings;
mod print;

#[cfg(test)]
mod tests;

pub(crate) use self::external::{
    allocate_boundary_identity_tokens, boundary_identity, quote_external_boundary_accesses,
    ExternalBoundaryEvidence,
};
pub(crate) use self::live_bindings::live_export_bindings;
pub(crate) use self::print::emit_goog_module_program;

#[cfg(test)]
pub(crate) use self::print::emit_goog_module_text;
