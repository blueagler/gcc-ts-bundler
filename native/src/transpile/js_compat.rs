use super::*;

mod ast;
mod text;

#[cfg(test)]
pub(super) use self::ast::transform_js_pass_through_module;
pub(super) use self::ast::{
    apply_resolver_and_global_this_compat, normalize_commonjs_module, parse_module_items,
    should_normalize_commonjs, transform_js_pass_through_program,
};
pub(super) use self::text::{apply_js_compat_text_fixes, collect_global_property_names};
