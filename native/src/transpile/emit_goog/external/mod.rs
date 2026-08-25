//! External-boundary identity tokens and member-access quoting.

mod identity;
mod quote;
mod visit;

pub(crate) use identity::{
    allocate_boundary_identity_tokens, allocate_boundary_identity_tokens_with, boundary_identity,
    ExternalBoundaryEvidence,
};
pub(crate) use quote::quote_external_boundary_accesses;
