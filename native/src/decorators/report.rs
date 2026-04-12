use std::collections::HashMap;

pub(super) fn parse_property_renaming_report(report: &str) -> HashMap<String, String> {
    let mut renames = HashMap::new();
    for line in report.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((original, renamed)) = trimmed.split_once(':') else {
            continue;
        };
        if !original.is_empty() && !renamed.is_empty() {
            renames.insert(original.to_string(), renamed.to_string());
        }
    }
    renames
}
