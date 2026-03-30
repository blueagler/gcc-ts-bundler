use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};

use crate::module_cache::parse_module;

pub fn rewrite_gcc_exports(code: String) -> std::result::Result<String, String> {
    if !code.contains("globalThis.GCC") && !code.contains("globalThis[\"GCC\"]") {
        return Ok(code);
    }

    if let Some(rewritten) = rewrite_gcc_exports_fast(&code) {
        return Ok(rewritten);
    }

    let mut module = parse_module(&PathBuf::from("bundle.js"), &code)?;
    let mut body = Vec::new();
    let mut exports_map = BTreeMap::<String, String>::new();
    let mut processed_exports = HashSet::<String>::new();
    let mut existing_export_names = HashSet::<String>::new();
    let mut has_default_export = false;

    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named)) => {
                for specifier in &named.specifiers {
                    if let ExportSpecifier::Named(named_specifier) = specifier {
                        existing_export_names.insert(export_name_from_module_export_name(
                            named_specifier.exported.as_ref().unwrap_or(&named_specifier.orig),
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

    for item in module.body.into_iter() {
        if let Some((export_name, right)) = get_gcc_export_assignment(&item) {
            if processed_exports.insert(export_name.clone()) {
                let local_name = if export_name == "__DEFAULT_EXPORT__" {
                    "__gcc_default_export__".to_string()
                } else {
                    format!("__gcc_export_{}", sanitize_identifier(&export_name))
                };
                exports_map.insert(export_name, local_name.clone());
                body.push(create_const_declaration(&local_name, right)?);
            }
        } else {
            body.push(item);
        }
    }

    for (export_name, local_name) in exports_map {
        if export_name == "__DEFAULT_EXPORT__" {
            if !has_default_export {
                body.push(parse_first_item(&format!("export default {};", local_name))?);
            }
        } else if !existing_export_names.contains(&export_name) {
            let exported_name = if is_valid_identifier(&export_name) {
                export_name
            } else {
                format!("{:?}", export_name)
            };
            body.push(parse_first_item(&format!(
                "export {{ {} as {} }};",
                local_name, exported_name
            ))?);
        }
    }

    module.body = body;
    print_module_minified(&module)
}

fn parse_first_item(code: &str) -> std::result::Result<ModuleItem, String> {
    let module = parse_module(&PathBuf::from("snippet.js"), code)?;
    module
        .body
        .into_iter()
        .next()
        .ok_or_else(|| format!("failed to parse module item from {}", code))
}

fn create_const_declaration(
    local_name: &str,
    right: Box<Expr>,
) -> std::result::Result<ModuleItem, String> {
    let item = parse_first_item(&format!("const {} = null;", local_name))?;
    match item {
        ModuleItem::Stmt(Stmt::Decl(Decl::Var(mut variable_decl))) => {
            if let Some(declarator) = variable_decl.decls.first_mut() {
                declarator.init = Some(right);
            }
            Ok(ModuleItem::Stmt(Stmt::Decl(Decl::Var(variable_decl))))
        }
        _ => Err("failed to create const declaration".to_string()),
    }
}

fn get_gcc_export_assignment(item: &ModuleItem) -> Option<(String, Box<Expr>)> {
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
    Some((export_name, assignment.right.clone()))
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

fn is_valid_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters.all(|character| {
        character.is_ascii_alphanumeric() || character == '_' || character == '$'
    })
}

fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default().with_minify(true),
            cm,
            comments: None,
            wr: writer,
        };
        emitter.emit_module(module).map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn rewrite_gcc_exports_fast(code: &str) -> Option<String> {
    let init_statements = [
        "globalThis.GCC=globalThis.GCC||{};",
        "globalThis[\"GCC\"]=globalThis[\"GCC\"]||{};",
    ];
    let (start_index, init_statement) = init_statements
        .iter()
        .filter_map(|candidate| code.rfind(candidate).map(|index| (index, *candidate)))
        .max_by_key(|(index, _)| *index)?;
    let tail = &code[start_index..];
    let statements = split_top_level_statements(tail)?;
    if statements.first().copied()? != init_statement {
        return None;
    }

    let mut rewritten = String::with_capacity(code.len() + 128);
    rewritten.push_str(&code[..start_index]);
    rewritten.push_str(init_statement);

    for statement in statements.iter().skip(1) {
        let (export_name, expression) = parse_gcc_assignment(statement)?;
        if export_name == "__DEFAULT_EXPORT__" {
            rewritten.push_str("const __gcc_default_export__=");
            rewritten.push_str(expression);
            rewritten.push_str(";export default __gcc_default_export__;");
            continue;
        }

        if !is_valid_identifier(export_name) {
            return None;
        }

        let local_name = format!("__gcc_export_{}", sanitize_identifier(export_name));
        rewritten.push_str("const ");
        rewritten.push_str(&local_name);
        rewritten.push('=');
        rewritten.push_str(expression);
        rewritten.push_str(";export{");
        rewritten.push_str(&local_name);
        rewritten.push_str(" as ");
        rewritten.push_str(export_name);
        rewritten.push_str("};");
    }

    Some(rewritten)
}

fn split_top_level_statements(input: &str) -> Option<Vec<&str>> {
    let mut statements = Vec::new();
    let mut start_index = 0usize;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;

    for (index, character) in input.char_indices() {
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
                continue;
            }

            if character == '\\' {
                escaped = true;
                continue;
            }

            if character == quote {
                in_string = None;
            }
            continue;
        }

        match character {
            '"' | '\'' => in_string = Some(character),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.checked_sub(1)?,
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.checked_sub(1)?,
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.checked_sub(1)?,
            ';' if brace_depth == 0 && bracket_depth == 0 && paren_depth == 0 => {
                let statement = input[start_index..=index].trim();
                if !statement.is_empty() {
                    statements.push(statement);
                }
                start_index = index + 1;
            }
            _ => {}
        }
    }

    if input[start_index..].trim().is_empty() {
        Some(statements)
    } else {
        None
    }
}

fn parse_gcc_assignment(statement: &str) -> Option<(&str, &str)> {
    const PREFIXES: [&str; 4] = [
        "globalThis.GCC.",
        "globalThis.GCC[\"",
        "globalThis[\"GCC\"].",
        "globalThis[\"GCC\"][\"",
    ];

    for prefix in PREFIXES {
        if let Some(rest) = statement.strip_prefix(prefix) {
            if prefix.ends_with('.') {
                let assignment_index = rest.find('=')?;
                let export_name = &rest[..assignment_index];
                let expression = rest[assignment_index + 1..].strip_suffix(';')?;
                return Some((export_name, expression));
            }

            let quote_end = rest.find("\"]=").or_else(|| rest.find("']="))?;
            let export_name = &rest[..quote_end];
            let expression = rest[quote_end + 3..].strip_suffix(';')?;
            return Some((export_name, expression));
        }
    }

    None
}
