pub(in super::super) fn apply_source_edits(
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

pub(in super::super) fn insert_before_class_member(
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

pub(in super::super) fn insert_before_object_member(
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
