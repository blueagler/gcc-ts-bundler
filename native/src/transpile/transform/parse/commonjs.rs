use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, Statement};
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::SourceType;

use super::helpers::{
    fresh_name, module_export_name, ComponentParamEditCollector, ThrowEditCollector,
};
use super::source::SourceEdit;
use crate::transpile::fresh::collect_lexical_binding_names;
use crate::transpile::{ChunkMode, TranspileContext};

pub(crate) fn rewrite_commonjs_import_source(
    allocator: &Allocator,
    source: &str,
    source_type: SourceType,
    context: &TranspileContext,
) -> (String, HashSet<String>, Vec<SourceEdit>) {
    let parsed = Parser::new(allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return (source.to_string(), HashSet::new(), Vec::new());
    }
    let mut used = collect_lexical_binding_names(&parsed.program);
    let mut component_edits = ComponentParamEditCollector {
        edits: Vec::new(),
        source,
        used: &mut used,
    };
    component_edits.visit_program(&parsed.program);
    let mut throw_edits = ThrowEditCollector {
        edits: Vec::new(),
        source,
    };
    if context.chunk_mode == ChunkMode::Off {
        throw_edits.visit_program(&parsed.program);
    }
    let mut import_counter = 0usize;
    let mut edits = Vec::new();
    edits.extend(component_edits.edits);
    edits.extend(throw_edits.edits);
    let mut opaque_bindings = HashSet::new();
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.as_str();
        if !context.commonjs_specifiers.contains(specifier) {
            continue;
        }
        let quoted = context.opaque_commonjs.specifier_is_opaque(specifier);
        let mut default_local = None;
        let mut namespace_local = None;
        let mut named = Vec::new();
        for import_specifier in import.specifiers.iter().flatten() {
            match import_specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    default_local = Some(default.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    namespace_local = Some(namespace.local.name.to_string());
                }
                ImportDeclarationSpecifier::ImportSpecifier(named_specifier) => {
                    named.push((
                        module_export_name(&named_specifier.imported),
                        named_specifier.local.name.to_string(),
                    ));
                }
            }
        }
        if namespace_local.is_none() && named.is_empty() {
            if quoted {
                opaque_bindings.extend(default_local);
            }
            continue;
        }
        let helper = default_local.unwrap_or_else(|| {
            let preferred = format!("__cjs_import_{import_counter}");
            import_counter += 1;
            fresh_name(&mut used, &preferred)
        });
        let mut replacement = vec![format!("import {helper} from {specifier:?};")];
        if quoted {
            opaque_bindings.insert(helper.clone());
        }
        if let Some(namespace) = namespace_local {
            if namespace != helper {
                replacement.push(format!("const {namespace} = {helper};"));
            }
            if quoted {
                opaque_bindings.insert(namespace);
            }
        }
        for (imported, local) in named {
            let access = if quoted {
                format!("{helper}[{imported:?}]")
            } else {
                format!("{helper}.{imported}")
            };
            replacement.push(format!("const {local} = {access};"));
        }
        edits.push((
            import.span.start as usize,
            import.span.end as usize,
            replacement.join("\n"),
        ));
    }
    let mut output = source.to_string();
    edits.sort_by_key(|(start, _, _)| *start);
    let source_edits = edits
        .iter()
        .map(|(start, end, replacement)| SourceEdit {
            end: *end,
            replacement_len: replacement.len(),
            start: *start,
        })
        .collect::<Vec<_>>();
    for (start, end, replacement) in edits.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    (output, opaque_bindings, source_edits)
}
