use std::collections::HashSet;

use super::ClassMapCallInput;

pub(crate) fn collect_class_static_assignments(source_text: &str) -> Vec<(String, String)> {
    let Ok(class_binding_regex) = regex::Regex::new(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b|class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) else {
        return Vec::new();
    };
    let Ok(assignment_regex) =
        regex::Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
    else {
        return Vec::new();
    };
    let class_bindings = class_binding_regex
        .captures_iter(source_text)
        .filter_map(|captures| captures.get(1).or_else(|| captures.get(2)))
        .map(|capture| capture.as_str().to_string())
        .collect::<HashSet<_>>();
    assignment_regex
        .captures_iter(source_text)
        .filter_map(|captures| {
            let class_name = captures.get(1)?.as_str();
            class_bindings.contains(class_name).then(|| {
                (
                    class_name.to_string(),
                    captures.get(2).unwrap().as_str().to_string(),
                )
            })
        })
        .collect()
}

fn validate_optional_pattern(
    callee: &str,
    field: &str,
    pattern: Option<&str>,
) -> Result<(), String> {
    if let Some(pattern) = pattern {
        regex::Regex::new(pattern).map_err(|error| {
            format!(
                "Invalid compat.classMapCalls rule for callee {callee:?}: {field} uses unsupported regex syntax: {error}"
            )
        })?;
    }
    Ok(())
}

pub(crate) fn validate_class_map_calls(calls: &[ClassMapCallInput]) -> Result<(), String> {
    for call in calls {
        validate_optional_pattern(&call.callee, "keyPattern", call.keyPattern.as_deref())?;
        validate_optional_pattern(
            &call.callee,
            "keyExcludePattern",
            call.keyExcludePattern.as_deref(),
        )?;
        validate_optional_pattern(
            &call.callee,
            "calleeModulePattern",
            call.calleeModulePattern.as_deref(),
        )?;
        if !matches!(
            call.keySource.as_deref(),
            None | Some("objectLiteral") | Some("pairArray")
        ) {
            return Err(format!(
                "Invalid compat.classMapCalls rule for callee {:?}: keySource must be \"objectLiteral\" or \"pairArray\", got {:?}.",
                call.callee, call.keySource
            ));
        }
    }
    Ok(())
}
