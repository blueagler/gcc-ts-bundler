use std::collections::HashMap;

use crate::closure_metadata::{
    ClosureFileMetadata, ClosureTypeDeclaration, ClosureTypeReference, ClosureTypeSymbol,
    TypeMetadataCounts, TypeMetadataDiagnostic,
};

use super::RuntimeTypeName;

pub(in super::super) struct RenderedTemplate {
    pub(in super::super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(in super::super) text: String,
    pub(in super::super) unresolved_count: u32,
}

pub(in super::super) struct RenderedDeclaration {
    pub(in super::super) code: Option<String>,
    pub(in super::super) diagnostics: Vec<TypeMetadataDiagnostic>,
    pub(in super::super) rendered_counts: TypeMetadataCounts,
    pub(in super::super) symbol_id: String,
}

pub(in super::super) fn render_declarations(
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

pub(in super::super) fn render_template(
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
