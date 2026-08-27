mod analysis;
mod render;

pub(crate) use self::analysis::{
    analyze_extern_file_program, is_valid_js_identifier, merge_extern_property_facts,
    ExternFileFacts, ExternPropertyAnalysis,
};
pub(crate) use self::render::render_generated_externs;
