//! Shared assigner annotations and runtime pin rendering.

/// The Closure annotation that keeps a function out of its call sites.
pub(crate) const NOINLINE_TAG: &str = "@noinline";

pub(crate) use super::assigners_oxc::collect_annotated_assigner_names;

/// The statement appended to a vendor chunk that makes its mutating functions
/// immovable.
pub(crate) fn render_assigner_pin(runtime_alias: &str, names: &[String]) -> Option<String> {
    (!names.is_empty()).then(|| format!("{runtime_alias}.v=[{}];", names.join(",")))
}
