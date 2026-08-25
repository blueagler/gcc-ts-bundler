//! Oxc read-only wrapper-flow analysis for dynamic-import carriers.

pub(crate) use super::wrappers_collect::{
    collect_dynamic_import_object_carriers, collect_dynamic_import_promise_carriers,
    collect_dynamic_import_wrappers,
};
pub(crate) use super::wrappers_rewrite::resolve_dynamic_import_module_ids;
pub(crate) use super::wrappers_types::{DynamicImportObjectWrapper, DynamicImportWrappers};
