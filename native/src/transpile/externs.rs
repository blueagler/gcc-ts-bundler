mod analysis;
mod render;

pub(crate) use self::analysis::{
    collect_extern_property_names_with_externs, is_valid_js_identifier, ExternPropertyAnalysis,
};
pub(crate) use self::render::render_generated_externs;
