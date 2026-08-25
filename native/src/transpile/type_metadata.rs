//! Shared text rendering for symbol-aware Closure type metadata.

mod edits;
mod render;

pub(super) use edits::{
    apply_source_edits, insert_before_class_member, insert_before_object_member,
};
pub(super) use render::{
    render_declarations, render_template, RenderedDeclaration, RenderedTemplate,
};

use crate::closure_metadata::{
    ClosureAnnotationTarget, ClosureFileMetadata, TypeMetadataCounts, TypeMetadataDiagnostic,
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

pub(super) fn empty_metadata() -> ClosureFileMetadata {
    ClosureFileMetadata {
        ambient_globals: Vec::new(),
        annotations: Vec::new(),
        declarations: Vec::new(),
        decorated_output_text: None,
        diagnostics: Vec::new(),
        enums: Vec::new(),
        external_global_member_accesses: Vec::new(),
        external_owned_member_accesses: Vec::new(),
        file_path: String::new(),
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
    let trimmed = code.trim_start();
    trimmed.starts_with("class ")
        || trimmed.contains("= class ")
        || trimmed.contains("=class ")
        || trimmed.contains("= class{")
        || trimmed.contains("=class{")
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::closure_metadata::{ClosureTypeReference, ClosureTypeSymbol};

    #[test]
    fn unresolved_reference_degrades_only_its_token() {
        let metadata = empty_metadata();
        let symbols = HashMap::from([(
            "missing".to_string(),
            ClosureTypeSymbol {
                builtin_name: None,
                declaration_file_path: None,
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
