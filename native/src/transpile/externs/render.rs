use std::collections::HashSet;

use super::analysis::is_valid_js_identifier;

#[cfg(test)]
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
pub(crate) fn render_externs(
    export_names: &BTreeSet<String>,
    enum_externs: &BTreeMap<String, BTreeSet<String>>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut all_names = export_names.clone();
    for member_names in enum_externs.values() {
        all_names.extend(member_names.iter().cloned());
    }
    if all_names.is_empty() {
        lines.push(String::new());
        return lines.join("\n");
    }

    for name in all_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Object.prototype.{name};"));
        } else {
            lines.push(format!("Object.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

pub(crate) fn render_generated_externs(
    static_property_names: &HashSet<String>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    let mut static_names = static_property_names.iter().cloned().collect::<Vec<_>>();
    static_names.sort();
    for name in static_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Function.prototype.{name};"));
        } else {
            lines.push(format!("Function.prototype[{name:?}];"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}
