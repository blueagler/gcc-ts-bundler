use std::collections::HashSet;

use super::analysis::is_valid_js_identifier;

pub(crate) fn render_generated_externs(
    preserved_property_names: &HashSet<String>,
    static_property_names: &HashSet<String>,
    ambient_global_names: &HashSet<String>,
) -> String {
    let mut lines = vec!["/** @externs */".to_string()];
    // Ambient declarations describe the environment the bundle runs in, so
    // they are externs, not program code. Typed as `?`: the ambient's TS type
    // is the author's claim about a global we do not control, and asserting it
    // to Closure would be a guess.
    let mut ambient_names = ambient_global_names.iter().cloned().collect::<Vec<_>>();
    ambient_names.sort();
    for name in ambient_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("/** @type {{?}} */"));
            lines.push(format!("var {name};"));
        }
    }
    let mut preserved_names = preserved_property_names.iter().cloned().collect::<Vec<_>>();
    preserved_names.sort();
    for name in preserved_names {
        if is_valid_js_identifier(&name) {
            lines.push(format!("Object.prototype.{name};"));
        } else {
            lines.push(format!("Object.prototype[{name:?}];"));
        }
    }
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
