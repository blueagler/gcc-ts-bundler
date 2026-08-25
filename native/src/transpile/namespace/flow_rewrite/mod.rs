//! Rewrite entry for bundler-runtime namespace usage.

mod members;
mod rewrite;
mod visitor;

pub(crate) use rewrite::rewrite_namespace_usage;
