use super::*;

pub(crate) fn apply_js_compat_text_fixes(source_text: String) -> String {
    let global_properties = collect_global_this_property_names(&source_text);
    let mut source_text =
        rewrite_async_function_comment_placement(rewrite_typescript_helper_this_fallbacks(
            rewrite_process_env_node_env(rewrite_directory_module_specifiers(source_text)),
        ));
    for property_name in global_properties {
        let pattern = format!(r"(?m)(?P<prefix>^|[^\w$.]){property_name}(?P<suffix>\.)");
        let replacement = format!("${{prefix}}globalThis.{property_name}${{suffix}}");
        source_text = regex::Regex::new(&pattern)
            .map(|regex| {
                regex
                    .replace_all(&source_text, replacement.as_str())
                    .into_owned()
            })
            .unwrap_or(source_text);
    }
    source_text = annotate_nocollapse_static_members(source_text);

    for property_name in collect_closure_protocol_properties(&source_text) {
        source_text = rewrite_protected_property_accesses(source_text, &property_name);
    }

    for (class_name, property_name, initializer) in collect_static_fallbacks(&source_text) {
        if !is_hard_static_interop_name(&property_name) {
            continue;
        }
        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("{class_name}[{property_name:?}]").as_str(),
                )
                .into_owned();
        }
        source_text.push('\n');
        source_text.push_str(&format!(
            "{class_name}[{:?}] = {class_name}[{:?}] ?? {};\n",
            property_name, property_name, initializer
        ));
    }

    for (class_name, property_name) in collect_class_static_assignments(&source_text) {
        if !is_hard_static_interop_name(&property_name) {
            continue;
        }
        let this_pattern = format!(r"\bthis\s*\.\s*{}\b", regex::escape(&property_name));
        if let Ok(regex) = regex::Regex::new(&this_pattern) {
            source_text = regex
                .replace_all(&source_text, format!("this[{property_name:?}]").as_str())
                .into_owned();
        }

        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("{class_name}[{property_name:?}]").as_str(),
                )
                .into_owned();
        }
    }

    source_text
}

pub(super) fn rewrite_async_function_comment_placement(source_text: String) -> String {
    regex::Regex::new(r#"(?s)async\s*(/\*\*.*?\*/)\s*function"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\nasync function")
                .into_owned()
        })
        .unwrap_or(source_text)
}

pub(super) fn rewrite_typescript_helper_this_fallbacks(source_text: String) -> String {
    regex::Regex::new(
        r#"(?m)\b(var|let|const)\s+(__[A-Za-z0-9_$]+)\s*=\s*\(this\s*&&\s*this(?:\.__[A-Za-z0-9_$]+|\s*\[\s*"__[A-Za-z0-9_$]+"\s*\])\)\s*\|\|\s*function"#,
    )
    .map(|regex| regex.replace_all(&source_text, "$1 $2 = function").into_owned())
    .unwrap_or(source_text)
}

pub(super) fn rewrite_process_env_node_env(source_text: String) -> String {
    regex::Regex::new(r#"\bprocess\.env\.NODE_ENV\b"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "\"production\"")
                .into_owned()
        })
        .unwrap_or(source_text)
}

pub(super) fn annotate_nocollapse_static_members(mut source_text: String) -> String {
    for (class_name, property_name) in collect_class_static_assignments(&source_text) {
        for pattern in [
            format!(
                r"(?m)^(?P<indent>\s*)(?P<target>{}\s*\.\s*{}\s*=)",
                regex::escape(&class_name),
                regex::escape(&property_name),
            ),
            format!(
                r#"(?m)^(?P<indent>\s*)(?P<target>{}\s*\[\s*"{}"\s*\]\s*=)"#,
                regex::escape(&class_name),
                regex::escape(&property_name),
            ),
        ] {
            if let Ok(regex) = regex::Regex::new(&pattern) {
                source_text = regex
                    .replace_all(
                        &source_text,
                        "${indent}/** @nocollapse */\n${indent}${target}",
                    )
                    .into_owned();
            }
        }
    }

    if let Ok(regex) =
        regex::Regex::new(r"(?m)^(?P<indent>\s*)(?P<field>static\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=)")
    {
        source_text = regex
            .replace_all(
                &source_text,
                "${indent}/** @nocollapse */\n${indent}${field}",
            )
            .into_owned();
    }
    if let Ok(regex) = regex::Regex::new(
        r"(?m)^(?P<indent>\s*)(?P<field>static\s+(?:get\s+|set\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*\()",
    ) {
        source_text = regex
            .replace_all(
                &source_text,
                "${indent}/** @nocollapse */\n${indent}${field}",
            )
            .into_owned();
    }

    source_text
}

pub(super) fn rewrite_directory_module_specifiers(source_text: String) -> String {
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)'\.'"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1'./index.js'")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)"\.""#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\"./index.js\"")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)'\.\.'"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1'../index.js'")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"(?m)(\bfrom\s+)"\.\.""#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1\"../index.js\"")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*'\.'\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('./index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*"\."\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('./index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    let source_text = regex::Regex::new(r#"import\(\s*'\.\.'\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('../index.js')")
                .into_owned()
        })
        .unwrap_or(source_text);
    regex::Regex::new(r#"import\(\s*"\.\."\s*\)"#)
        .map(|regex| {
            regex
                .replace_all(&source_text, "import('../index.js')")
                .into_owned()
        })
        .unwrap_or(source_text)
}

pub(super) fn collect_global_this_property_names(source_text: &str) -> HashSet<String> {
    let mut global_aliases = HashSet::from(["globalThis".to_string()]);
    if let Ok(alias_regex) = regex::Regex::new(
        r"(?m)(?:^|[;,]\s*|\b(?:const|let|var)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        let mut changed = true;
        while changed {
            changed = false;
            for captures in alias_regex.captures_iter(source_text) {
                let alias = captures
                    .get(1)
                    .map(|capture| capture.as_str())
                    .unwrap_or_default();
                let target = captures
                    .get(2)
                    .map(|capture| capture.as_str())
                    .unwrap_or_default();
                if global_aliases.contains(target) && global_aliases.insert(alias.to_string()) {
                    changed = true;
                }
            }
        }
    }

    let mut properties = HashSet::new();
    for alias in global_aliases {
        if let Ok(regex) = regex::Regex::new(&format!(r"{alias}\.([A-Za-z_$][A-Za-z0-9_$]*)")) {
            for captures in regex.captures_iter(source_text) {
                if let Some(capture) = captures.get(1) {
                    let property_name = capture.as_str();
                    if is_global_protocol_name(property_name) {
                        properties.insert(property_name.to_string());
                    }
                }
            }
        }
    }

    properties
}

pub(super) fn is_global_protocol_name(name: &str) -> bool {
    matches!(
        name,
        "litElementHydrateSupport"
            | "litElementPolyfillSupport"
            | "litElementVersions"
            | "litHtmlPolyfillSupport"
            | "litHtmlVersions"
            | "litPropertyMetadata"
            | "reactiveElementPolyfillSupport"
            | "reactiveElementVersions"
    )
}

pub(crate) fn collect_global_property_names(
    file_names: &[String],
) -> std::result::Result<HashSet<String>, String> {
    collect_names_from_files(file_names, collect_global_this_property_names)
}

fn is_hard_static_interop_name(name: &str) -> bool {
    matches!(name, "formAssociated" | "observedAttributes")
}

pub(super) fn collect_static_fallbacks(source_text: &str) -> Vec<(String, String, String)> {
    let assignment_regex = match regex::Regex::new(
        r#"(?s)([A-Z][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\["([A-Za-z_$][A-Za-z0-9_$]*)"\])\s*=\s*(\[[^;]*?\]);"#,
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };

    let mut fallbacks = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let property_name = captures
            .get(2)
            .or_else(|| captures.get(3))
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let initializer = captures
            .get(4)
            .map(|capture| capture.as_str().to_string())
            .unwrap_or_default();

        if initializer.is_empty()
            || !source_text.contains(&format!("this.constructor.{property_name}"))
        {
            continue;
        }

        fallbacks.push((
            class_name.to_string(),
            property_name.to_string(),
            initializer,
        ));
    }

    fallbacks
}

pub(super) fn collect_closure_protocol_properties(source_text: &str) -> HashSet<String> {
    regex::Regex::new(r#"JSCompiler_renameProperty\(\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']"#)
        .ok()
        .map(|regex| {
            regex
                .captures_iter(source_text)
                .filter_map(|captures| captures.get(1).map(|capture| capture.as_str().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn rewrite_protected_property_accesses(
    mut source_text: String,
    property_name: &str,
) -> String {
    let constructor_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])(?P<object>([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor)\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}${{object}}[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    let this_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])this\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&this_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}this[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    let identifier_pattern = format!(
        r#"(?m)(?P<prefix>^|[^\w$."'`])(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*{}\b"#,
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&identifier_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("${{prefix}}${{object}}[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    source_text
}
