//! Oxc namespace and dynamic-import analysis.

pub(super) mod flow;
mod flow_helpers;
mod flow_rewrite;
mod flow_visitors;
mod wrappers;
mod wrappers_collect;
mod wrappers_rewrite;
mod wrappers_types;
