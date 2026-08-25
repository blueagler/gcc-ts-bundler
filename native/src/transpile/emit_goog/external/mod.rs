//! External-boundary identity tokens and member-access quoting.

mod identity;
mod quote;
mod visit;

#[cfg(test)]
pub(crate) use identity::allocate_boundary_identity_tokens_with;
pub(crate) use identity::{
    allocate_boundary_identity_tokens, boundary_identity, ExternalBoundaryEvidence,
};
pub(crate) use quote::quote_external_boundary_accesses;
