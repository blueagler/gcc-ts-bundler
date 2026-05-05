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
        match doc.kind.as_str() {
            "class" => {
                insert_before_text(&mut rewritten, &format!("class {}", doc.name), &doc.jsdoc)
            }
            "function" => insert_before_text(
                &mut rewritten,
                &format!("function {}", doc.name),
                &doc.jsdoc,
            ),
            "variable" => insert_before_variable(&mut rewritten, &doc.name, &doc.jsdoc),
            "field" => insert_class_field_type_declaration(&mut rewritten, doc),
            "constructor" | "getter" | "method" | "setter" => {
                insert_before_member(&mut rewritten, doc)
            }
            "objectGetter" | "objectMethod" | "objectProperty" | "objectSetter" => {
                insert_before_object_member(&mut rewritten, doc)
            }
            _ => false,
        };
    }
    rewritten
}

fn insert_before_text(source_text: &mut String, needle: &str, jsdoc: &str) -> bool {
    let Some(index) = source_text.find(needle) else {
        return false;
    };
    source_text.insert_str(index, jsdoc);
    true
}

fn insert_before_variable(source_text: &mut String, name: &str, jsdoc: &str) -> bool {
    let Ok(pattern) =
        regex::Regex::new(&format!(r"\b(?:const|let|var)\s+{}\b", regex::escape(name)))
    else {
        return false;
    };
    let Some(index) = pattern.find(source_text).map(|match_| match_.start()) else {
        return false;
    };
    source_text.insert_str(index, jsdoc);
    true
}

fn insert_before_member(source_text: &mut String, doc: &ClosureTopLevelDoc) -> bool {
    let Some(owner) = doc.owner.as_ref() else {
        return false;
    };
    let Some(class_index) = source_text.find(&format!("class {owner}")) else {
        return false;
    };
    let Some(class_body_start) = source_text[class_index..]
        .find('{')
        .map(|index| index + class_index)
    else {
        return false;
    };
    let Some(class_body_end) = find_matching_brace(source_text, class_body_start) else {
        return false;
    };
    let body_start = class_body_start + 1;
    let body = &source_text[body_start..class_body_end];
    let anchors = member_anchors(doc);
    let Some(member_index) = anchors
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source_text.insert_str(body_start + member_index, &doc.jsdoc);
    true
}

fn insert_class_field_type_declaration(source_text: &mut String, doc: &ClosureTopLevelDoc) -> bool {
    let Some(owner) = doc.owner.as_ref() else {
        return false;
    };
    let Some(class_index) = source_text.find(&format!("class {owner}")) else {
        return false;
    };
    let Some(class_body_start) = source_text[class_index..]
        .find('{')
        .map(|index| index + class_index)
    else {
        return false;
    };
    let Some(mut class_body_end) = find_matching_brace(source_text, class_body_start) else {
        return false;
    };
    if remove_type_only_class_field(source_text, class_body_start, class_body_end, doc) {
        let Some(updated_class_body_end) = find_matching_brace(source_text, class_body_start)
        else {
            return false;
        };
        class_body_end = updated_class_body_end;
    }
    let property_access = render_type_declaration_property_access(owner, doc);
    let declaration = format!("\nif (false) {{\n{}{property_access};\n}}\n", doc.jsdoc);
    source_text.insert_str(class_body_end + 1, &declaration);
    true
}

fn remove_type_only_class_field(
    source_text: &mut String,
    class_body_start: usize,
    class_body_end: usize,
    doc: &ClosureTopLevelDoc,
) -> bool {
    let body_start = class_body_start + 1;
    let body = &source_text[body_start..class_body_end];
    let quoted = regex::escape(&format!("{:?}", doc.name));
    let bare = regex::escape(&doc.name);
    let static_prefix = if doc.r#static { r"static\s+" } else { "" };
    let Ok(pattern) = regex::Regex::new(&format!(
        r#"(?m)^[ \t]*{}(?:{}|{})\s*;\s*(?:\r?\n)?"#,
        static_prefix, bare, quoted
    )) else {
        return false;
    };
    let Some(match_) = pattern.find(body) else {
        return false;
    };
    source_text.replace_range(body_start + match_.start()..body_start + match_.end(), "");
    true
}

fn render_type_declaration_property_access(owner: &str, doc: &ClosureTopLevelDoc) -> String {
    let base = if doc.r#static {
        owner.to_string()
    } else {
        format!("{owner}.prototype")
    };
    if is_valid_js_identifier(&doc.name) {
        format!("{base}.{}", doc.name)
    } else {
        format!("{base}[{:?}]", doc.name)
    }
}

fn insert_before_object_member(source_text: &mut String, doc: &ClosureTopLevelDoc) -> bool {
    let Some(owner) = doc.owner.as_ref() else {
        return false;
    };
    let Ok(variable_pattern) = regex::Regex::new(&format!(
        r"\b(?:const|let|var)\s+{}\b",
        regex::escape(owner)
    )) else {
        return false;
    };
    let Some(variable_match) = variable_pattern.find(source_text) else {
        return false;
    };
    let after_variable = &source_text[variable_match.end()..];
    let Some(equals_offset) = after_variable.find('=') else {
        return false;
    };
    let object_search_start = variable_match.end() + equals_offset + 1;
    let Some(object_body_start) = source_text[object_search_start..]
        .find('{')
        .map(|index| object_search_start + index)
    else {
        return false;
    };
    let Some(object_body_end) = find_matching_brace(source_text, object_body_start) else {
        return false;
    };
    let body_start = object_body_start + 1;
    let body = &source_text[body_start..object_body_end];
    let anchors = object_member_anchors(doc);
    let Some(member_index) = anchors
        .iter()
        .filter_map(|anchor| find_member_anchor(body, anchor))
        .min()
    else {
        return false;
    };
    source_text.insert_str(body_start + member_index, &doc.jsdoc);
    true
}

fn find_member_anchor(body: &str, anchor: &str) -> Option<usize> {
    let pattern =
        regex::Regex::new(&format!(r"(?m)(^|[\n\r;{{}}])\s*{}", regex::escape(anchor))).ok()?;
    let match_ = pattern.find(body)?;
    let offset = match_.as_str().find(anchor)?;
    Some(match_.start() + offset)
}

fn member_anchors(doc: &ClosureTopLevelDoc) -> Vec<String> {
    match doc.kind.as_str() {
        "constructor" => vec!["constructor(".to_string()],
        "field" if doc.r#static => vec![
            format!("static {:?}=", doc.name),
            format!("static {:?};", doc.name),
            format!("static {:?} =", doc.name),
            format!("static {}=", doc.name),
            format!("static {};", doc.name),
            format!("static {} =", doc.name),
        ],
        "field" => vec![
            format!("{:?}=", doc.name),
            format!("{:?};", doc.name),
            format!("{:?} =", doc.name),
            format!("{}=", doc.name),
            format!("{};", doc.name),
            format!("{} =", doc.name),
        ],
        "getter" if doc.r#static => vec![format!("static get {}(", doc.name)],
        "getter" => vec![format!("get {}(", doc.name)],
        "setter" if doc.r#static => vec![format!("static set {}(", doc.name)],
        "setter" => vec![format!("set {}(", doc.name)],
        _ if doc.r#static => vec![format!("static {}(", doc.name)],
        _ => vec![format!("{}(", doc.name)],
    }
}

fn object_member_anchors(doc: &ClosureTopLevelDoc) -> Vec<String> {
    match doc.kind.as_str() {
        "objectGetter" => vec![format!("get {}(", doc.name), format!("get {} (", doc.name)],
        "objectSetter" => vec![format!("set {}(", doc.name), format!("set {} (", doc.name)],
        "objectMethod" => vec![format!("{}(", doc.name), format!("{} (", doc.name)],
        _ => vec![
            format!("{}:", doc.name),
            format!("{} :", doc.name),
            format!("{:?}:", doc.name),
            format!("{:?} :", doc.name),
            format!("{}: ", doc.name),
        ],
    }
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
