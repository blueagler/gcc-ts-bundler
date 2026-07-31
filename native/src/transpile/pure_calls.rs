use std::collections::HashSet;

/// Collects top-level bindings whose initializer carries a `/*#__PURE__*/` or
/// `/*@__PURE__*/` annotation.
pub(crate) fn collect_pure_annotated_binding_names(source: &str) -> HashSet<String> {
    source
        .match_indices("__PURE__")
        .filter_map(|(index, _)| pure_annotated_binding_before(source, index))
        .collect()
}

fn pure_annotated_binding_before(source: &str, pure_index: usize) -> Option<String> {
    let prefix = &source[..pure_index];
    let comment_start = prefix.rfind("/*")?;
    if !matches!(prefix[comment_start + 2..].trim(), "#" | "@") {
        return None;
    }
    let before_comment = prefix[..comment_start].trim_end();
    let equals_index = before_comment.strip_suffix('=')?.trim_end().len();
    let before_equals = &before_comment[..equals_index];
    let name_start = before_equals
        .rfind(|character: char| !is_identifier_char(character))
        .map(|index| index + 1)
        .unwrap_or(0);
    let name = &before_equals[name_start..];
    if name.is_empty() || name.starts_with(|character: char| character.is_ascii_digit()) {
        return None;
    }
    let keyword = before_equals[..name_start].trim_end();
    matches!(
        keyword.rsplit(char::is_whitespace).next(),
        Some("var") | Some("let") | Some("const")
    )
    .then(|| name.to_string())
}

fn is_identifier_char(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_initializer_comments_map_back_to_the_declared_binding() {
        assert_eq!(
            collect_pure_annotated_binding_names(
                "const first = /*#__PURE__*/ make();\nlet second = /*@__PURE__*/ new Set();"
            ),
            HashSet::from(["first".to_string(), "second".to_string()])
        );
        assert!(collect_pure_annotated_binding_names("call(/*#__PURE__*/ value)").is_empty());
    }
}
