use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use napi_derive::napi;
use swc_core::common::{sync::Lrc, BytePos, FileName, SourceMap, Span, Spanned};
use swc_core::ecma::ast::*;
use swc_core::ecma::parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax};

/// Result of converting a Closure `globalThis.GCC` export bag back into ESM.
///
/// `rewritten_export_count` is fail-closed telemetry: a caller that saw the
/// `globalThis.GCC` marker in the input and gets zero rewrites back is looking
/// at a rule that silently stopped matching, which is how the old post-Closure
/// layer shipped a no-op for an entire release.
#[napi(object)]
pub struct GccExportsRewrite {
    pub code: String,
    #[napi(js_name = "rewrittenExportCount")]
    pub rewritten_export_count: u32,
}

/// One contiguous replacement in the original source text.
#[derive(Debug)]
struct SourceEdit {
    start: usize,
    end: usize,
    text: String,
}

/// Converts Closure's `globalThis.GCC` export bag back into ESM exports.
///
/// The AST is used to *locate* the statements to change and nothing else. Every
/// byte outside an edited span is copied through verbatim, because reprinting
/// the module re-canonicalizes literals, spacing and line breaks across the
/// whole file: measured at +629 gzip on the React example and +127 on
/// vue-vapor for token-identical output. Closure already chose those bytes;
/// this pass has no business re-deciding them.
///
/// Fails closed. Overlapping or out-of-order spans abort with an error rather
/// than fall back to a whole-file reprint.
pub fn rewrite_gcc_exports(code: String) -> std::result::Result<GccExportsRewrite, String> {
    if !code.contains("globalThis.GCC") && !code.contains("globalThis[\"GCC\"]") {
        return Ok(GccExportsRewrite {
            code,
            rewritten_export_count: 0,
        });
    }

    let (module, source_start) = parse_module_with_offset(&code)?;
    let slice = |span: Span| -> std::result::Result<&str, String> {
        let (start, end) = span_range(span, source_start, code.len())?;
        Ok(&code[start..end])
    };

    let mut exports_map = BTreeMap::<String, ExportRewrite>::new();
    let mut processed_exports = HashSet::<String>::new();
    let mut existing_export_names = HashSet::<String>::new();
    let mut declared_names = HashSet::<String>::new();
    let mut has_default_export = false;
    let mut named_export_specifiers = Vec::<String>::new();

    for item in &module.body {
        collect_top_level_declared_names(item, &mut declared_names);
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                for specifier in &named.specifiers {
                    if let ExportSpecifier::Named(named_specifier) = specifier {
                        existing_export_names.insert(export_name_from_module_export_name(
                            named_specifier
                                .exported
                                .as_ref()
                                .unwrap_or(&named_specifier.orig),
                        ));
                    }
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
            | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                has_default_export = true;
            }
            _ => {}
        }
    }

    let mut edits = Vec::<SourceEdit>::new();
    for item in &module.body {
        let (start, end) = span_range(item.span(), source_start, code.len())?;
        let end = absorb_statement_terminator(&code, end);

        if is_gcc_bootstrap_statement(item) {
            edits.push(SourceEdit {
                start,
                end,
                text: String::new(),
            });
            continue;
        }

        let Some((export_name, right)) = get_gcc_export_assignment(item) else {
            continue;
        };
        if !processed_exports.insert(export_name.clone()) {
            // A later assignment to the same export name is dead; the first one
            // already owns the binding, exactly as before.
            edits.push(SourceEdit {
                start,
                end,
                text: String::new(),
            });
            continue;
        }

        // The right-hand side is spliced from the original text, never printed
        // back from the AST, so its literals and spacing survive untouched.
        let right_source = slice(right.span())?;
        let (rewrite, text) = if let Some(identifier) = bare_identifier_name(right) {
            (ExportRewrite::Direct(identifier), String::new())
        } else if export_name != "__DEFAULT_EXPORT__"
            && is_valid_identifier(&export_name)
            && !declared_names.contains(&export_name)
        {
            declared_names.insert(export_name.clone());
            (
                ExportRewrite::Direct(export_name.clone()),
                format!("const {export_name}={right_source};"),
            )
        } else {
            let local_name = if export_name == "__DEFAULT_EXPORT__" {
                "__gcc_default_export__".to_string()
            } else {
                format!("__gcc_export_{}", sanitize_identifier(&export_name))
            };
            let text = format!("const {local_name}={right_source};");
            (ExportRewrite::Temp(local_name), text)
        };
        edits.push(SourceEdit { start, end, text });
        exports_map.insert(export_name, rewrite);
    }

    let rewritten_export_count = exports_map.len();
    let mut appended = String::new();
    for (export_name, rewrite) in exports_map {
        if export_name == "__DEFAULT_EXPORT__" {
            if !has_default_export {
                appended.push_str(&format!("export default {};", rewrite.local_name()));
            }
        } else if !existing_export_names.contains(&export_name) {
            named_export_specifiers.push(format_named_export_specifier(
                rewrite.local_name(),
                &export_name,
            ));
        }
    }
    if !named_export_specifiers.is_empty() {
        appended.push_str(&format!("export{{{}}};", named_export_specifiers.join(",")));
    }

    Ok(GccExportsRewrite {
        code: apply_source_edits(&code, edits, &appended)?,
        rewritten_export_count: rewritten_export_count as u32,
    })
}

/// Parses with a source map this function owns, so span positions can be turned
/// back into offsets into `code`.
fn parse_module_with_offset(code: &str) -> std::result::Result<(Module, BytePos), String> {
    let source_map: Lrc<SourceMap> = Default::default();
    let source_file = source_map.new_source_file(
        FileName::Real(PathBuf::from("bundle.js")).into(),
        code.to_string(),
    );
    let start_pos = source_file.start_pos;
    let lexer = Lexer::new(
        Syntax::Es(EsSyntax::default()),
        Default::default(),
        StringInput::from(&*source_file),
        None,
    );
    let module = Parser::new_from(lexer)
        .parse_module()
        .map_err(|error| format!("bundle.js: {}", error.kind().msg()))?;
    Ok((module, start_pos))
}

fn span_range(
    span: Span,
    source_start: BytePos,
    source_len: usize,
) -> std::result::Result<(usize, usize), String> {
    if span.lo < source_start || span.hi < span.lo {
        return Err("gcc-exports rewrite found a span outside the parsed source".to_string());
    }
    let start = (span.lo.0 - source_start.0) as usize;
    let end = (span.hi.0 - source_start.0) as usize;
    if end > source_len {
        return Err("gcc-exports rewrite found a span past the end of the source".to_string());
    }
    Ok((start, end))
}

/// Statement spans may stop before the terminating `;`. Removing a statement
/// has to take its terminator with it, or deletion leaves stray empty
/// statements behind.
fn absorb_statement_terminator(code: &str, end: usize) -> usize {
    let rest = &code[end..];
    let trimmed = rest.trim_start_matches([' ', '\t']);
    if trimmed.starts_with(';') {
        return end + (rest.len() - trimmed.len()) + 1;
    }
    end
}

/// Splices the edits into the original text. Bytes outside an edit are copied
/// through unchanged.
fn apply_source_edits(
    code: &str,
    mut edits: Vec<SourceEdit>,
    appended: &str,
) -> std::result::Result<String, String> {
    edits.sort_by_key(|edit| (edit.start, edit.end));
    let mut output = String::with_capacity(code.len() + appended.len() + 16);
    let mut cursor = 0usize;
    for edit in &edits {
        if edit.start < cursor {
            return Err(format!(
                "gcc-exports rewrite produced overlapping edits at byte {}",
                edit.start
            ));
        }
        if edit.end < edit.start || edit.end > code.len() {
            return Err("gcc-exports rewrite produced an invalid edit range".to_string());
        }
        if !code.is_char_boundary(edit.start) || !code.is_char_boundary(edit.end) {
            return Err("gcc-exports rewrite produced a non-UTF-8 edit boundary".to_string());
        }
        output.push_str(&code[cursor..edit.start]);
        output.push_str(&edit.text);
        cursor = edit.end;
    }
    output.push_str(&code[cursor..]);
    if !appended.is_empty() {
        // Closure terminates its statements, so the common case appends with no
        // separator at all. A tail that relies on ASI gets one newline so the
        // export list cannot glue onto the previous token.
        let needs_separator = !output.is_empty()
            && !output.ends_with(';')
            && !output.ends_with('}')
            && !output.ends_with('\n');
        if needs_separator {
            output.push('\n');
        }
        output.push_str(appended);
    }
    Ok(output)
}

enum ExportRewrite {
    Direct(String),
    Temp(String),
}

impl ExportRewrite {
    fn local_name(&self) -> &str {
        match self {
            Self::Direct(name) | Self::Temp(name) => name,
        }
    }
}

fn get_gcc_export_assignment(item: &ModuleItem) -> Option<(String, &Expr)> {
    let statement = match item {
        ModuleItem::Stmt(Stmt::Expr(statement)) => statement,
        _ => return None,
    };

    let assignment = match &*statement.expr {
        Expr::Assign(assignment) => assignment,
        _ => return None,
    };

    let left = match &assignment.left {
        AssignTarget::Simple(SimpleAssignTarget::Member(member)) => member,
        _ => return None,
    };

    let object = match &*left.obj {
        Expr::Member(member) => member,
        _ => return None,
    };

    let object_name = member_prop_name(&object.prop)?;
    let global_name = match &*object.obj {
        Expr::Ident(ident) => ident.sym.to_string(),
        _ => return None,
    };

    if global_name != "globalThis" || object_name != "GCC" {
        return None;
    }

    let export_name = member_prop_name(&left.prop)?;
    Some((export_name, &assignment.right))
}

fn is_gcc_bootstrap_statement(item: &ModuleItem) -> bool {
    let statement = match item {
        ModuleItem::Stmt(Stmt::Expr(statement)) => statement,
        _ => return false,
    };

    let assignment = match &*statement.expr {
        Expr::Assign(assignment) => assignment,
        _ => return false,
    };

    let left = match &assignment.left {
        AssignTarget::Simple(SimpleAssignTarget::Member(member)) => member,
        _ => return false,
    };

    let right = match &*assignment.right {
        Expr::Bin(binary) if binary.op == BinaryOp::LogicalOr => binary,
        _ => return false,
    };

    is_global_gcc_member(&left.obj, &left.prop)
        && matches!(&*right.left, Expr::Member(member) if is_global_gcc_member(&member.obj, &member.prop))
        && matches!(&*right.right, Expr::Object(object) if object.props.is_empty())
}

fn is_global_gcc_member(object: &Expr, prop: &MemberProp) -> bool {
    matches!(object, Expr::Ident(ident) if ident.sym == "globalThis")
        && member_prop_name(prop).as_deref() == Some("GCC")
}

fn bare_identifier_name(expression: &Expr) -> Option<String> {
    match expression {
        Expr::Ident(ident) => Some(ident.sym.to_string()),
        _ => None,
    }
}

fn collect_top_level_declared_names(item: &ModuleItem, names: &mut HashSet<String>) {
    match item {
        ModuleItem::Stmt(Stmt::Decl(Decl::Var(variable))) => {
            for declarator in &variable.decls {
                collect_pattern_names(&declarator.name, names);
            }
        }
        ModuleItem::Stmt(Stmt::Decl(Decl::Fn(function))) => {
            names.insert(function.ident.sym.to_string());
        }
        ModuleItem::Stmt(Stmt::Decl(Decl::Class(class))) => {
            names.insert(class.ident.sym.to_string());
        }
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => match &export_decl.decl {
            Decl::Var(variable) => {
                for declarator in &variable.decls {
                    collect_pattern_names(&declarator.name, names);
                }
            }
            Decl::Fn(function) => {
                names.insert(function.ident.sym.to_string());
            }
            Decl::Class(class) => {
                names.insert(class.ident.sym.to_string());
            }
            _ => {}
        },
        _ => {}
    }
}

fn collect_pattern_names(pattern: &Pat, names: &mut HashSet<String>) {
    match pattern {
        Pat::Ident(binding) => {
            names.insert(binding.id.sym.to_string());
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_pattern_names(element, names);
            }
        }
        Pat::Object(object) => {
            for prop in &object.props {
                match prop {
                    ObjectPatProp::Assign(assign) => {
                        names.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_pattern_names(&key_value.value, names);
                    }
                    ObjectPatProp::Rest(rest) => {
                        collect_pattern_names(&rest.arg, names);
                    }
                }
            }
        }
        Pat::Assign(assign) => collect_pattern_names(&assign.left, names),
        Pat::Rest(rest) => collect_pattern_names(&rest.arg, names),
        _ => {}
    }
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn export_name_from_module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().to_string(),
    }
}

fn sanitize_identifier(name: &str) -> String {
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '$' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn format_named_export_specifier(local_name: &str, export_name: &str) -> String {
    if local_name == export_name && is_valid_identifier(export_name) {
        local_name.to_string()
    } else {
        let exported_name = if is_valid_identifier(export_name) {
            export_name.to_string()
        } else {
            format!("{:?}", export_name)
        };
        format!("{local_name} as {exported_name}")
    }
}

fn is_valid_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

#[cfg(test)]
mod tests {
    use super::{apply_source_edits, rewrite_gcc_exports, SourceEdit};

    #[test]
    fn rewrites_named_identifier_exports_without_gcc_wrapper() {
        let output = rewrite_gcc_exports(
            "const Mc=1;globalThis.GCC=globalThis.GCC||{};globalThis.GCC.MotionHero=Mc;"
                .to_string(),
        )
        .unwrap()
        .code;

        assert!(output.contains("export{Mc as MotionHero};"), "{output}");
        assert!(!output.contains("globalThis.GCC"), "{output}");
        assert!(!output.contains("__gcc_export_"), "{output}");
    }

    #[test]
    fn rewrites_default_identifier_exports_without_gcc_wrapper() {
        let output = rewrite_gcc_exports(
            "const Mc=1;globalThis.GCC=globalThis.GCC||{};globalThis.GCC.__DEFAULT_EXPORT__=Mc;"
                .to_string(),
        )
        .unwrap()
        .code;

        assert!(output.contains("export default Mc;"), "{output}");
        assert!(!output.contains("globalThis.GCC"), "{output}");
        assert!(!output.contains("__gcc_default_export__"), "{output}");
    }

    #[test]
    fn keeps_temp_fallback_for_non_identifier_exports() {
        let output = rewrite_gcc_exports(
            "globalThis.GCC=globalThis.GCC||{};globalThis.GCC.MotionHero=foo();".to_string(),
        )
        .unwrap()
        .code;

        assert!(
            output.contains("const MotionHero=foo();export{MotionHero};"),
            "{output}"
        );
        assert!(!output.contains("globalThis.GCC"), "{output}");
        assert!(!output.contains("__gcc_export_MotionHero"), "{output}");
    }

    #[test]
    fn skips_duplicate_exports_already_present() {
        let output = rewrite_gcc_exports(
            "const Mc=1;export{Mc as MotionHero};globalThis.GCC=globalThis.GCC||{};globalThis.GCC.MotionHero=Mc;"
                .to_string(),
        )
        .unwrap()
        .code;

        assert_eq!(output.matches("MotionHero").count(), 1, "{output}");
        assert!(!output.contains("globalThis.GCC"), "{output}");
    }

    #[test]
    fn preserves_every_byte_outside_the_rewritten_spans() {
        // Closure picked these bytes: the octal-ish numeric literal, the single
        // quotes, the deliberate line break and the trailing spacing. Reprinting
        // the module re-canonicalizes all of them, which is what cost +629 gzip
        // on the React example for token-identical output.
        let untouched = concat!(
            "var a=0xFF,b='it\\'s',c=1e3,d=`t${a}`;\n",
            "function f(){return{ 'x-y':1,\"z\":2}}\n",
            "var re=/a[\"{;]/g;\n"
        );
        let input = format!("{untouched}globalThis.GCC=globalThis.GCC||{{}};globalThis.GCC.f=f;");
        let output = rewrite_gcc_exports(input).unwrap();

        assert_eq!(output.rewritten_export_count, 1, "{}", output.code);
        assert_eq!(
            output.code,
            format!("{untouched}export{{f}};"),
            "bytes outside the edited spans must survive verbatim"
        );
    }

    #[test]
    fn splices_the_right_hand_side_from_the_original_text() {
        let output = rewrite_gcc_exports(
            "globalThis.GCC=globalThis.GCC||{};globalThis.GCC.v={ 'a-b':0x10, c:'d' };".to_string(),
        )
        .unwrap()
        .code;

        // The object literal keeps its authored quoting, hex literal and spacing.
        assert!(
            output.contains("const v={ 'a-b':0x10, c:'d' };"),
            "{output}"
        );
        assert!(output.contains("export{v};"), "{output}");
    }

    #[test]
    fn leaves_a_marker_string_with_no_export_statements_untouched() {
        // The marker appears only inside a literal, so there is nothing to
        // rewrite and the file must come back byte-identical.
        let input = "var help=\"set globalThis.GCC to debug\";console.log(help);".to_string();
        let output = rewrite_gcc_exports(input.clone()).unwrap();

        assert_eq!(output.code, input);
        assert_eq!(output.rewritten_export_count, 0);
    }

    #[test]
    fn rejects_overlapping_edits_instead_of_reprinting() {
        let error = apply_source_edits(
            "abcdef",
            vec![
                SourceEdit {
                    start: 0,
                    end: 4,
                    text: "X".to_string(),
                },
                SourceEdit {
                    start: 2,
                    end: 6,
                    text: "Y".to_string(),
                },
            ],
            "",
        )
        .expect_err("overlapping edits must fail closed");
        assert!(error.contains("overlapping"), "{error}");
    }

    #[test]
    fn reports_how_many_export_slots_were_rewritten() {
        let output = rewrite_gcc_exports(
            "const a=1,b=2;globalThis.GCC=globalThis.GCC||{};globalThis.GCC.one=a;globalThis.GCC.two=b;"
                .to_string(),
        )
        .unwrap();

        assert_eq!(output.rewritten_export_count, 2, "{}", output.code);
    }

    #[test]
    fn leaves_non_gcc_modules_unchanged() {
        let input = "export const value = 1;".to_string();
        let output = rewrite_gcc_exports(input.clone()).unwrap();

        assert_eq!(output.code, input);
        assert_eq!(output.rewritten_export_count, 0);
    }

    #[test]
    fn rewrites_member_expression_exports_to_named_binding_without_gcc_temp() {
        let output = rewrite_gcc_exports(
            "const Y={tb:1};globalThis.GCC=globalThis.GCC||{};globalThis.GCC.MotionHero=Y.tb;"
                .to_string(),
        )
        .unwrap()
        .code;

        assert!(
            output.contains("const MotionHero=Y.tb;export{MotionHero};"),
            "{output}"
        );
        assert!(!output.contains("__gcc_export_"), "{output}");
        assert!(!output.contains("globalThis.GCC"), "{output}");
    }

    #[test]
    fn merges_named_exports_into_one_statement() {
        let output = rewrite_gcc_exports(
            "const A=1;const B=2;globalThis.GCC=globalThis.GCC||{};globalThis.GCC.First=A;globalThis.GCC.Second=B;"
                .to_string(),
        )
        .unwrap()
        .code;

        assert!(
            output.contains("export{A as First,B as Second};"),
            "{output}"
        );
        assert_eq!(output.matches("export{").count(), 1, "{output}");
    }
}
