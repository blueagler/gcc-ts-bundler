//! Oxc binding and statement-delivery half of `type_metadata.rs`.

mod bind;
mod deliver;
mod prepare;

pub(crate) use bind::{declared_statement_ids, runtime_type_names_from_program, BoundTypeMetadata};
pub(crate) use prepare::PreparedTypeMetadata;
