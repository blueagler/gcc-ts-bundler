use super::*;

pub(super) fn emit_module_program(
    file_path: &Path,
    program: Program,
    context: &TranspileContext,
    file_metadata: Option<&ClosureFileMetadata>,
    commonjs_export_name: Option<&str>,
) -> std::result::Result<String, String> {
    match context.chunk_mode {
        ChunkMode::BundlerRuntime => emit_bundler_runtime_module_program(
            file_path,
            program,
            context,
            file_metadata,
            commonjs_export_name,
        ),
        ChunkMode::Off => emit_goog_module_program(
            file_path,
            program,
            context,
            file_metadata,
            commonjs_export_name,
        ),
    }
}

pub(super) fn render_closure_enum(enum_decl: &ClosureEnumDeclaration) -> String {
    let member_lines = enum_decl
        .members
        .iter()
        .map(|member| {
            let value = match &member.value {
                serde_json::Value::Bool(value) => value.to_string(),
                serde_json::Value::Number(value) => value.to_string(),
                serde_json::Value::String(value) => format!("{value:?}"),
                _ => "undefined".to_string(),
            };
            if is_valid_js_identifier(&member.name) {
                format!("  {}: {},", member.name, value)
            } else {
                format!("  {:?}: {},", member.name, value)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "/** @enum {{{}}} */\nconst {} = {{\n{}\n}};",
        enum_decl.value_type, enum_decl.name, member_lines
    )
}

pub(super) fn attach_top_level_docs(source_text: String, docs: &[ClosureTopLevelDoc]) -> String {
    let mut rewritten = source_text;
    for doc in docs {
        let needle = match doc.kind.as_str() {
            "class" => format!("class {}", doc.name),
            _ => format!("function {}", doc.name),
        };
        if let Some(index) = rewritten.find(&needle) {
            rewritten.insert_str(index, &doc.jsdoc);
        }
    }
    rewritten
}
