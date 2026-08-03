//! Shared text rendering for symbol-aware Closure type metadata.

use std::collections::HashMap;

use crate::closure_metadata::{
    ClosureAnnotationTarget, ClosureFileMetadata, ClosureTypeDeclaration, ClosureTypeReference,
    ClosureTypeSymbol, TypeMetadataCounts, TypeMetadataDiagnostic,
};

use super::is_valid_js_identifier;

pub(crate) const PURE_TAG: &str = "@pureOrBreakMyCode";

#[derive(Clone, Debug)]
pub(crate) enum RuntimeTypeName {
    Name(String),
    Unresolved(&'static str),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TypeMetadataDelivery {
    pub(crate) counts: TypeMetadataCounts,
    pub(crate) diagnostics: Vec<TypeMetadataDiagnostic>,
}

pub(super) struct RenderedTemplate {
    pub(super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(super) text: String,
    pub(super) unresolved_count: u32,
}

pub(super) struct RenderedDeclaration {
    pub(super) code: Option<String>,
    pub(super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(super) rendered_counts: TypeMetadataCounts,
    pub(super) symbol_id: String,
}

pub(super) fn render_declarations(
    metadata: &ClosureFileMetadata,
    declarations: &[ClosureTypeDeclaration],
    symbols_by_id: &HashMap<String, ClosureTypeSymbol>,
    declaration_names: &HashMap<String, String>,
    symbol_resolutions: &HashMap<String, RuntimeTypeName>,
    rename_declaration: impl Fn(&str, &str, &str) -> std::result::Result<String, String>,
) -> Vec<RenderedDeclaration> {
    declarations
        .iter()
        .map(|declaration| {
            let target = format!("type declaration {}", declaration.id);
            let rendered = render_template(
                metadata,
                &declaration.template,
                &declaration.references,
                symbols_by_id,
                symbol_resolutions,
                Some(target.clone()),
            );
            let authored_name = symbols_by_id
                .get(&declaration.declared_symbol_id)
                .map(|symbol| symbol.diagnostic_name.as_str())
                .unwrap_or("ClosureType");
            let emitted_name = declaration_names
                .get(&declaration.declared_symbol_id)
                .map(String::as_str)
                .unwrap_or(authored_name);
            let mut diagnostics = rendered.diagnostics;
            let code = rename_declaration(&rendered.text, authored_name, emitted_name).ok();
            if code.is_none() {
                diagnostics.push(TypeMetadataDiagnostic::delivery(
                    metadata,
                    "declaration-parse-failed",
                    symbols_by_id.get(&declaration.declared_symbol_id),
                    Some(target),
                ));
            }
            RenderedDeclaration {
                rendered_counts: TypeMetadataCounts {
                    typeDeclarationCount: u32::from(code.is_some()),
                    unresolvedTypeReferenceCount: rendered.unresolved_count,
                    ..Default::default()
                },
                code,
                diagnostics,
                symbol_id: declaration.declared_symbol_id.clone(),
            }
        })
        .collect()
}

pub(super) fn render_template(
    metadata: &ClosureFileMetadata,
    template: &str,
    references: &[ClosureTypeReference],
    symbols_by_id: &HashMap<String, ClosureTypeSymbol>,
    symbol_resolutions: &HashMap<String, RuntimeTypeName>,
    target: Option<String>,
) -> RenderedTemplate {
    let mut text = template.to_string();
    let mut diagnostics = Vec::new();
    let mut unresolved_count = 0u32;
    for reference in references {
        let (replacement, reason) = match symbol_resolutions.get(&reference.symbol_id) {
            Some(RuntimeTypeName::Name(name)) => (name.as_str(), None),
            Some(RuntimeTypeName::Unresolved(reason)) => ("?", Some(*reason)),
            None => ("?", Some("runtime-binding-not-found")),
        };
        if reason.is_some() {
            text = replace_unresolved_reference(&text, &reference.token);
        } else {
            text = text.replace(&reference.token, replacement);
        }
        if let Some(reason) = reason {
            unresolved_count += 1;
            diagnostics.push(TypeMetadataDiagnostic::delivery(
                metadata,
                reason,
                symbols_by_id.get(&reference.symbol_id),
                target.clone(),
            ));
        }
    }
    RenderedTemplate {
        diagnostics,
        text,
        unresolved_count,
    }
}

fn replace_unresolved_reference(template: &str, token: &str) -> String {
    let mut output = template.to_string();
    while let Some(token_start) = output.find(token) {
        let mut start = token_start;
        if start > 0 && matches!(output.as_bytes()[start - 1], b'!' | b'?') {
            start -= 1;
        }
        let mut end = token_start + token.len();
        if output.as_bytes().get(end) == Some(&b'<') {
            let mut depth = 0usize;
            for (offset, byte) in output.as_bytes()[end..].iter().copied().enumerate() {
                if byte == b'<' {
                    depth += 1;
                } else if byte == b'>' {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end += offset + 1;
                        break;
                    }
                }
            }
        }
        output.replace_range(start..end, "?");
    }
    output
}

pub(super) fn apply_source_edits(
    source: &str,
    mut edits: Vec<(usize, usize, String)>,
) -> std::result::Result<String, String> {
    edits.sort_by_key(|(start, _, _)| *start);
    let mut output = source.to_string();
    for (start, end, replacement) in edits.into_iter().rev() {
        if start > end
            || end > output.len()
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            return Err("Invalid type declaration source edit span".to_string());
        }
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

pub(super) fn empty_metadata() -> ClosureFileMetadata {
    ClosureFileMetadata {
        ambient_globals: Vec::new(),
        erased_const_enums: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        external_owned_member_accesses: Vec::new(),
        file_path: String::new(),
        runtime_module_id: None,
        source_file_path: String::new(),
        symbols: Vec::new(),
    }
}

pub(super) fn annotation_target_label(target: &ClosureAnnotationTarget) -> String {
    match target {
        ClosureAnnotationTarget::Binding { binding_name } => format!("binding {binding_name}"),
        ClosureAnnotationTarget::Member {
            member_kind,
            member_name,
            owner_binding_name,
            is_static,
        } => format!(
            "{} {}.{}{}",
            member_kind,
            owner_binding_name,
            member_name,
            if *is_static { " static" } else { "" }
        ),
    }
}

pub(super) fn merge_jsdoc_blocks(blocks: &[String]) -> Option<String> {
    let mut tags = Vec::new();
    for block in blocks {
        let Some(body) = block
            .trim()
            .strip_prefix("/**")
            .and_then(|value| value.strip_suffix("*/"))
        else {
            continue;
        };
        tags.extend(
            body.lines()
                .map(|line| line.trim().trim_start_matches('*').trim())
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
    }
    if tags.is_empty() {
        None
    } else {
        Some(format!(
            "/**\n{}\n */\n",
            tags.into_iter()
                .map(|line| format!(" * {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

pub(crate) fn compose_annotations(tags: &[&str], typed: Option<&str>) -> String {
    match (tags.is_empty(), typed.filter(|block| !block.is_empty())) {
        (true, None) => String::new(),
        (true, Some(typed)) => typed.to_string(),
        (false, None) => format!("/** {} */\n", tags.join(" ")),
        (false, Some(typed)) => {
            let Some(rest) = typed.strip_prefix("/**") else {
                return typed.to_string();
            };
            format!("/** {}{rest}", tags.join(" "))
        }
    }
}

pub(super) fn is_class_declaration_text(code: &str) -> bool {
    code.trim_start().starts_with("class ")
}

pub(super) fn render_class_field_declaration(
    owner: &str,
    member: &str,
    is_static: bool,
    jsdoc: &str,
) -> String {
    let base = if is_static {
        owner.to_string()
    } else {
        format!("{owner}.prototype")
    };
    let access = if is_valid_js_identifier(member) {
        format!("{base}.{member}")
    } else {
        format!("{base}[{member:?}]")
    };
    format!("if (false) {{\n{}{access};\n}}", indent_jsdoc(jsdoc, "  "))
}

fn indent_jsdoc(jsdoc: &str, indent: &str) -> String {
    jsdoc
        .trim_end()
        .lines()
        .map(|line| format!("{indent}{line}\n"))
        .collect()
}

pub(super) fn insert_before_class_member(
    source: &mut String,
    member_kind: &str,
    member_name: &str,
    is_static: bool,
    jsdoc: &str,
) -> bool {
    let Some(class_body_start) = source.find('{') else {
        return false;
    };
    let Some(class_body_end) = find_matching_brace(source, class_body_start) else {
        return false;
    };
    let body_start = class_body_start + 1;
    let body = &source[body_start..class_body_end];
    let Some(member_index) = member_anchors(member_kind, member_name, is_static)
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source.insert_str(body_start + member_index, jsdoc);
    true
}

pub(super) fn insert_before_object_member(
    source: &mut String,
    member_kind: &str,
    member_name: &str,
    jsdoc: &str,
) -> bool {
    let Some(equals) = source.find('=') else {
        return false;
    };
    let Some(object_body_start) = source[equals + 1..]
        .find('{')
        .map(|index| equals + 1 + index)
    else {
        return false;
    };
    let Some(object_body_end) = find_matching_brace(source, object_body_start) else {
        return false;
    };
    let body_start = object_body_start + 1;
    let body = &source[body_start..object_body_end];
    let Some(member_index) = member_anchors(member_kind, member_name, false)
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source.insert_str(body_start + member_index, jsdoc);
    true
}

fn find_member_anchor(body: &str, anchor: &str) -> Option<usize> {
    let pattern =
        regex::Regex::new(&format!(r"(?m)(^|[\n\r;{{}}])\s*{}", regex::escape(anchor))).ok()?;
    let match_ = pattern.find(body)?;
    let offset = match_.as_str().find(anchor)?;
    Some(match_.start() + offset)
}

fn member_anchors(member_kind: &str, name: &str, is_static: bool) -> Vec<String> {
    let bare = name.to_string();
    let quoted = format!("[{name:?}]");
    let prefixes = if is_static { vec!["static "] } else { vec![""] };
    prefixes
        .into_iter()
        .flat_map(|prefix| match member_kind {
            "constructor" => vec!["constructor(".to_string(), "constructor (".to_string()],
            "getter" => vec![
                format!("{prefix}get {bare}("),
                format!("{prefix}get {bare} ("),
                format!("{prefix}get {quoted}("),
                format!("{prefix}get {quoted} ("),
            ],
            "setter" => vec![
                format!("{prefix}set {bare}("),
                format!("{prefix}set {bare} ("),
                format!("{prefix}set {quoted}("),
                format!("{prefix}set {quoted} ("),
            ],
            "method" => vec![
                format!("{prefix}{bare}("),
                format!("{prefix}{bare} ("),
                format!("{prefix}{quoted}("),
                format!("{prefix}{quoted} ("),
            ],
            _ => vec![
                format!("{prefix}{bare}:"),
                format!("{prefix}{bare} :"),
                format!("{prefix}{quoted}:"),
                format!("{prefix}{quoted} :"),
                format!("{prefix}{bare}="),
                format!("{prefix}{bare} ="),
                format!("{prefix}{quoted}="),
                format!("{prefix}{quoted} ="),
            ],
        })
        .collect()
}

fn find_matching_brace(source_text: &str, open_index: usize) -> Option<usize> {
    let bytes = source_text.as_bytes();
    if bytes.get(open_index).copied()? != b'{' {
        return None;
    }
    let mut index = open_index;
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    while index < bytes.len() {
        let current = bytes[index];
        let next = bytes.get(index + 1).copied();
        if in_line_comment {
            if current == b'\n' {
                in_line_comment = false;
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if current == b'*' && next == Some(b'/') {
                in_block_comment = false;
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if current == b'\\' {
                escaped = true;
            } else if current == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if current == b'/' && next == Some(b'/') {
            in_line_comment = true;
            index += 2;
            continue;
        }
        if current == b'/' && next == Some(b'*') {
            in_block_comment = true;
            index += 2;
            continue;
        }
        if matches!(current, b'\'' | b'"' | b'`') {
            quote = Some(current);
            index += 1;
            continue;
        }
        if current == b'{' {
            depth += 1;
        } else if current == b'}' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unresolved_reference_degrades_only_its_token() {
        let metadata = empty_metadata();
        let symbols = HashMap::from([(
            "missing".to_string(),
            ClosureTypeSymbol {
                builtin_name: None,
                declaration_file_path: None,
                declaration_id: None,
                declaration_start: None,
                diagnostic_name: "Missing".to_string(),
                id: "missing".to_string(),
                kind: "runtime".to_string(),
                local_name: Some("Missing".to_string()),
            },
        )]);
        let rendered = render_template(
            &metadata,
            "/** @param {!__GCC_TYPE_0__<string>} value @return {number} */\n",
            &[ClosureTypeReference {
                symbol_id: "missing".to_string(),
                token: "__GCC_TYPE_0__".to_string(),
            }],
            &symbols,
            &HashMap::from([(
                "missing".to_string(),
                RuntimeTypeName::Unresolved("registry-slot-is-not-a-type-name"),
            )]),
            Some("binding use".to_string()),
        );
        assert_eq!(rendered.text, "/** @param {?} value @return {number} */\n");
        assert_eq!(rendered.unresolved_count, 1);
    }

    #[test]
    fn annotation_composition_keeps_one_nearest_block() {
        assert_eq!(
            compose_annotations(
                &[PURE_TAG, "@noinline"],
                Some("/**\n * @return {number}\n */\n")
            ),
            "/** @pureOrBreakMyCode @noinline\n * @return {number}\n */\n"
        );
    }
}
