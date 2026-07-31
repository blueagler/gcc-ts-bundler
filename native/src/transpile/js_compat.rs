use std::collections::HashSet;
use std::path::Path;

use super::compat::collect_class_static_assignments;

mod text;

pub(super) use self::text::apply_js_compat_text_fixes;

pub(crate) fn should_normalize_commonjs(
    file_path: &Path,
    analysis: &crate::commonjs::CommonJsAnalysis,
) -> bool {
    analysis.has_commonjs
        && file_path.to_string_lossy().contains("/node_modules/")
        && !file_path.to_string_lossy().ends_with(".d.ts")
}

pub(crate) fn to_emitted_commonjs_specifier(specifier: &str) -> String {
    if specifier.starts_with('.') {
        specifier.replace(".cjs", ".js").replace(".cts", ".js")
    } else {
        specifier.to_string()
    }
}
