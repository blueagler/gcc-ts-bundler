//! Collectors for dynamic-import wrapper and carrier analysis.

mod carriers;
mod helpers;
mod wrappers;

pub(crate) use carriers::{
    collect_dynamic_import_object_carriers, collect_dynamic_import_promise_carriers,
};
pub(crate) use wrappers::collect_dynamic_import_wrappers;
