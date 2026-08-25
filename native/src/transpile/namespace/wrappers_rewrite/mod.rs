//! Resolve and extract helpers for dynamic-import wrapper-flow analysis.

mod extract;
mod ids;
mod members;
mod object;

pub(crate) use extract::{
    dynamic_import_module_ids_from_call, extract_dynamic_import_module_ids_from_expr,
    extract_dynamic_import_module_ids_from_function,
    extract_dynamic_import_object_wrapper_from_callable_expr,
    extract_dynamic_import_object_wrapper_from_function, extract_dynamic_import_object_wrappers,
    literal_property_name,
};
pub(crate) use ids::{resolve_dynamic_import_module_ids, resolve_dynamic_import_module_ids_strict};
pub(crate) use object::resolve_dynamic_import_object_wrapper;
