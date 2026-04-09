use std::path::Path;

pub(super) fn property_renaming_report_path(
    raw_dir: &Path,
    compilation_level: &str,
) -> Option<String> {
    (compilation_level == "ADVANCED").then(|| {
        raw_dir
            .join("property-renaming-report.txt")
            .to_string_lossy()
            .to_string()
    })
}
