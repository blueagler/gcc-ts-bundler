#![allow(non_snake_case)]

use std::fs;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rayon::prelude::*;
use swc_core::common::{sync::Lrc, Globals, Mark, SourceMap, GLOBALS};
use swc_core::ecma::ast::{Expr, ExprStmt, Id, MemberExpr, MemberProp, ModuleItem, Pass, Program, Stmt, VarDeclarator};
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use swc_ecma_transforms_base::resolver;
use swc_ecma_transforms_typescript::strip;

use crate::module_cache::{get_or_parse_cached_module, parse_module};

#[allow(non_snake_case)]
#[napi(object)]
pub struct TranspileOutput {
    pub emittedFiles: Vec<String>,
    pub externsPath: String,
}

pub fn transpile_sources(
    file_names: Vec<String>,
    out_dir: String,
    externs_path: String,
    workspace_dir: String,
) -> std::result::Result<TranspileOutput, String> {
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = PathBuf::from(&externs_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&externs_path, "").map_err(|error| error.to_string())?;

    let workspace_dir = PathBuf::from(workspace_dir);
    let out_dir = PathBuf::from(out_dir);
    let emitted_outputs = file_names
        .par_iter()
        .filter(|file_name| !file_name.ends_with(".d.ts"))
        .map(|file_name| {
            let file_path = PathBuf::from(file_name);
            let relative_path = file_path.strip_prefix(&workspace_dir).unwrap_or(&file_path);
            let output_path = out_dir.join(relative_path).with_extension("js");

            let code = GLOBALS.set(&Globals::new(), || transform_source_file(&file_path))?;

            Ok::<_, String>((output_path, code))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut emitted_files = Vec::with_capacity(emitted_outputs.len());
    for (output_path, code) in emitted_outputs {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&output_path, code).map_err(|error| error.to_string())?;
        emitted_files.push(output_path.to_string_lossy().to_string());
    }

    emitted_files.sort();
    Ok(TranspileOutput {
        emittedFiles: emitted_files,
        externsPath: externs_path,
    })
}

fn transform_source_file(file_path: &Path) -> std::result::Result<String, String> {
    if !should_run_resolver(file_path) {
        let source_text = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
        return Ok(apply_js_compat_text_fixes(source_text));
    }

    let module = get_or_parse_cached_module(&file_path.to_path_buf())?;
    let program = transform_program(module, file_path)?;
    print_program(&program).map(apply_js_compat_text_fixes)
}

fn apply_js_compat_text_fixes(source_text: String) -> String {
    let global_properties = collect_global_this_property_names(&source_text);
    let mut source_text = source_text;
    for property_name in global_properties {
        let pattern = format!(r"(?m)(?P<prefix>^|[^\w$.]){property_name}(?P<suffix>\.)");
        let replacement = format!("${{prefix}}globalThis.{property_name}${{suffix}}");
        source_text = regex::Regex::new(&pattern)
            .map(|regex| regex.replace_all(&source_text, replacement.as_str()).into_owned())
            .unwrap_or(source_text);
    }

    for property_name in collect_closure_protocol_properties(&source_text) {
        source_text = rewrite_protected_property_accesses(source_text, &property_name);
    }

    for (class_name, property_name, initializer) in collect_static_fallbacks(&source_text) {
        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(&source_text, format!("{class_name}[{property_name:?}]").as_str())
                .into_owned();
        }
        source_text.push('\n');
        source_text.push_str(&format!(
            "{class_name}[{:?}] = {class_name}[{:?}] ?? {};\n",
            property_name, property_name, initializer
        ));
    }

    for (class_name, property_name) in collect_class_static_assignments(&source_text) {
        let this_pattern = format!(r"\bthis\s*\.\s*{}\b", regex::escape(&property_name));
        if let Ok(regex) = regex::Regex::new(&this_pattern) {
            source_text = regex
                .replace_all(&source_text, format!("this[{property_name:?}]").as_str())
                .into_owned();
        }

        let constructor_pattern = format!(
            r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
            source_text = regex
                .replace_all(
                    &source_text,
                    format!("$1.constructor[{property_name:?}]").as_str(),
                )
                .into_owned();
        }

        let class_pattern = format!(
            r"\b{}\s*\.\s*{}\b",
            regex::escape(&class_name),
            regex::escape(&property_name)
        );
        if let Ok(regex) = regex::Regex::new(&class_pattern) {
            source_text = regex
                .replace_all(&source_text, format!("{class_name}[{property_name:?}]").as_str())
                .into_owned();
        }
    }

    source_text = rewrite_static_class_fields(source_text);

    source_text
}

fn rewrite_static_class_fields(source_text: String) -> String {
    regex::Regex::new(r"(?m)(\bstatic)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
        .map(|regex| {
            regex
                .replace_all(&source_text, "$1 [\"$2\"] =")
                .into_owned()
        })
        .unwrap_or(source_text)
}

fn collect_global_this_property_names(source_text: &str) -> HashSet<String> {
    let mut global_aliases = HashSet::from(["globalThis".to_string()]);
    if let Ok(alias_regex) = regex::Regex::new(
        r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;",
    ) {
        let mut changed = true;
        while changed {
            changed = false;
            for captures in alias_regex.captures_iter(source_text) {
                let alias = captures.get(1).map(|capture| capture.as_str()).unwrap_or_default();
                let target = captures.get(2).map(|capture| capture.as_str()).unwrap_or_default();
                if global_aliases.contains(target) && global_aliases.insert(alias.to_string()) {
                    changed = true;
                }
            }
        }
    }

    let mut properties = HashSet::new();
    for alias in global_aliases {
        if let Ok(regex) =
            regex::Regex::new(&format!(r"{alias}\.([A-Za-z_$][A-Za-z0-9_$]*)"))
        {
            for captures in regex.captures_iter(source_text) {
                if let Some(capture) = captures.get(1) {
                    properties.insert(capture.as_str().to_string());
                }
            }
        }
    }

    properties
}

fn collect_static_fallbacks(source_text: &str) -> Vec<(String, String, String)> {
    let assignment_regex = match regex::Regex::new(
        r"(?s)([A-Z][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(\[[^;]*?\]);",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };

    let mut fallbacks = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures.get(1).map(|capture| capture.as_str()).unwrap_or_default();
        let property_name = captures.get(2).map(|capture| capture.as_str()).unwrap_or_default();
        let initializer = captures
            .get(3)
            .map(|capture| capture.as_str().to_string())
            .unwrap_or_default();

        if initializer.is_empty()
            || !source_text.contains(&format!("this.constructor.{property_name}"))
        {
            continue;
        }

        fallbacks.push((
            class_name.to_string(),
            property_name.to_string(),
            initializer,
        ));
    }

    fallbacks
}

fn collect_closure_protocol_properties(source_text: &str) -> HashSet<String> {
    regex::Regex::new(r#"JSCompiler_renameProperty\(\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']"#)
        .ok()
        .map(|regex| {
            regex
                .captures_iter(source_text)
                .filter_map(|captures| captures.get(1).map(|capture| capture.as_str().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn rewrite_protected_property_accesses(mut source_text: String, property_name: &str) -> String {
    let constructor_pattern = format!(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*|this)\s*\.\s*constructor\s*\.\s*{}\b",
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&constructor_pattern) {
        source_text = regex
            .replace_all(
                &source_text,
                format!("$1.constructor[{property_name:?}]").as_str(),
            )
            .into_owned();
    }

    let this_pattern = format!(r"\bthis\s*\.\s*{}\b", regex::escape(property_name));
    if let Ok(regex) = regex::Regex::new(&this_pattern) {
        source_text = regex
            .replace_all(&source_text, format!("this[{property_name:?}]").as_str())
            .into_owned();
    }

    let identifier_pattern = format!(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*{}\b",
        regex::escape(property_name)
    );
    if let Ok(regex) = regex::Regex::new(&identifier_pattern) {
        source_text = regex
            .replace_all(&source_text, format!("$1[{property_name:?}]").as_str())
            .into_owned();
    }

    source_text
}

fn collect_class_static_assignments(source_text: &str) -> Vec<(String, String)> {
    let class_binding_regex = match regex::Regex::new(
        r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b|class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };
    let assignment_regex = match regex::Regex::new(
        r"([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=",
    ) {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };

    let mut class_bindings = HashSet::new();
    for captures in class_binding_regex.captures_iter(source_text) {
        if let Some(capture) = captures.get(1).or_else(|| captures.get(2)) {
            class_bindings.insert(capture.as_str().to_string());
        }
    }

    let mut assignments = Vec::new();
    for captures in assignment_regex.captures_iter(source_text) {
        let class_name = captures.get(1).map(|capture| capture.as_str()).unwrap_or_default();
        let property_name = captures.get(2).map(|capture| capture.as_str()).unwrap_or_default();
        if class_bindings.contains(class_name) {
            assignments.push((class_name.to_string(), property_name.to_string()));
        }
    }

    assignments
}

fn transform_program(
    module: swc_core::ecma::ast::Module,
    _file_path: &Path,
) -> std::result::Result<Program, String> {
    let mut program = Program::Module(module);
    let resolver_marks = if should_run_resolver(_file_path) {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        resolver(unresolved_mark, top_level_mark, true).process(&mut program);
        Some((unresolved_mark, top_level_mark))
    } else {
        None
    };
    let unresolved_ctxt = resolver_marks
        .map(|(unresolved_mark, _)| swc_core::common::SyntaxContext::empty().apply_mark(unresolved_mark))
        .unwrap_or_else(swc_core::common::SyntaxContext::empty);
    let compat_property_names = collect_global_this_compat_property_names(&program, unresolved_ctxt);
    if !compat_property_names.is_empty() {
        program.visit_mut_with(&mut GlobalThisCompatVisitor::new(
            compat_property_names,
            unresolved_ctxt,
        )?);
    }
    if let Some((unresolved_mark, top_level_mark)) = resolver_marks {
        strip(unresolved_mark, top_level_mark).process(&mut program);
    }
    Ok(program)
}

fn print_program(program: &Program) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut output = Vec::new();
    {
        let writer = JsWriter::new(cm.clone(), "\n", &mut output, None);
        let mut emitter = Emitter {
            cfg: CodegenConfig::default(),
            cm,
            comments: None,
            wr: writer,
        };
        emitter.emit_program(program).map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn collect_global_this_compat_property_names(
    program: &Program,
    unresolved_ctxt: swc_core::common::SyntaxContext,
) -> HashSet<String> {
    let mut collector = GlobalThisCompatCollector::new(unresolved_ctxt);
    program.visit_with(&mut collector);
    collector.properties
}

struct GlobalThisCompatCollector {
    aliases: HashSet<Id>,
    properties: HashSet<String>,
    unresolved_ctxt: swc_core::common::SyntaxContext,
}

impl GlobalThisCompatCollector {
    fn new(unresolved_ctxt: swc_core::common::SyntaxContext) -> Self {
        Self {
            aliases: HashSet::new(),
            properties: HashSet::new(),
            unresolved_ctxt,
        }
    }

    fn is_global_this_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if ident.sym == *"globalThis" && ident.ctxt == self.unresolved_ctxt)
    }

    fn is_global_this_alias_expr(&self, expr: &Expr) -> bool {
        matches!(expr, Expr::Ident(ident) if self.aliases.contains(&ident.to_id()))
    }

    fn is_global_object_expr(&self, expr: &Expr) -> bool {
        self.is_global_this_expr(expr) || self.is_global_this_alias_expr(expr)
    }
}

impl Visit for GlobalThisCompatCollector {
    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if let swc_core::ecma::ast::Pat::Ident(binding) = &declarator.name {
            if let Some(init) = &declarator.init {
                if self.is_global_object_expr(init) {
                    self.aliases.insert(binding.id.to_id());
                }
            }
        }

        declarator.visit_children_with(self);
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        if let Expr::Ident(object_ident) = &*member_expr.obj {
            if self.is_global_object_expr(&Expr::Ident(object_ident.clone())) {
                if let Some(property_name) = member_prop_name(&member_expr.prop) {
                    self.properties.insert(property_name);
                }
            }
        }

        member_expr.visit_children_with(self);
    }
}

struct GlobalThisCompatVisitor {
    replacements: HashMap<String, Box<Expr>>,
    unresolved_ctxt: swc_core::common::SyntaxContext,
}

impl GlobalThisCompatVisitor {
    fn new(
        property_names: HashSet<String>,
        unresolved_ctxt: swc_core::common::SyntaxContext,
    ) -> std::result::Result<Self, String> {
        let mut replacements = HashMap::new();
        for property_name in property_names {
            replacements.insert(
                property_name.clone(),
                parse_global_this_property_expr(&property_name)?,
            );
        }

        Ok(Self {
            replacements,
            unresolved_ctxt,
        })
    }
}

impl VisitMut for GlobalThisCompatVisitor {
    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        expr.visit_mut_children_with(self);

        if let Expr::Ident(ident) = expr {
            if ident.ctxt == self.unresolved_ctxt {
                if let Some(replacement) = self.replacements.get(ident.sym.as_ref()) {
                    *expr = *replacement.clone();
                }
            }
        }
    }
}

fn parse_global_this_property_expr(property_name: &str) -> std::result::Result<Box<Expr>, String> {
    let expression = if is_valid_identifier(property_name) {
        format!("globalThis.{property_name};")
    } else {
        format!("globalThis[{:?}];", property_name)
    };
    let module = parse_module(&PathBuf::from("compat-snippet.js"), &expression)?;
    let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = module
        .body
        .into_iter()
        .next()
        .ok_or_else(|| "missing compat snippet expression".to_string())?
    else {
        return Err("invalid compat snippet expression".to_string());
    };
    let Expr::Member(MemberExpr { .. }) = &*expr else {
        return Err("invalid compat snippet member expression".to_string());
    };
    Ok(expr)
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) => {
                Some(value.value.to_string_lossy().to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

fn is_valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    match characters.next() {
        Some(character)
            if character.is_ascii_alphabetic() || character == '_' || character == '$' => {}
        _ => return false,
    }

    characters.all(|character| {
        character.is_ascii_alphanumeric() || character == '_' || character == '$'
    })
}

fn is_typescript_source_file(file_path: &Path) -> bool {
    matches!(
        file_path.extension().and_then(|value| value.to_str()),
        Some("ts") | Some("tsx") | Some("mts")
    ) && !file_path.to_string_lossy().ends_with(".d.ts")
}

fn should_run_resolver(file_path: &Path) -> bool {
    is_typescript_source_file(file_path)
}

#[cfg(test)]
mod tests {
    use super::{apply_js_compat_text_fixes, print_program, rewrite_static_class_fields, transform_program, transform_source_file};
    use crate::module_cache::parse_module;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use swc_core::common::{Globals, GLOBALS};

    #[test]
    fn rewrites_global_property_accesses_to_global_this() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
        let module = parse_module(
            &file_path,
            "const value = globalThis.sharedRegistry ?? new WeakMap(); const item = sharedRegistry.get(meta);",
        )
        .unwrap();

        let program = GLOBALS
            .set(&Globals::new(), || transform_program(module, &file_path))
            .unwrap();
        let output = print_program(&program).unwrap();

        assert!(output.contains("globalThis.sharedRegistry.get(meta)"));
    }

    #[test]
    fn leaves_unrelated_identifiers_alone() {
        let file_path = PathBuf::from("/tmp/node_modules/demo-pkg/index.js");
        let module = parse_module(&file_path, "const value = registry.get(meta);").unwrap();

        let program = GLOBALS
            .set(&Globals::new(), || transform_program(module, &file_path))
            .unwrap();
        let output = print_program(&program).unwrap();

        assert!(output.contains("registry.get(meta)"));
        assert!(!output.contains("globalThis.registry.get(meta)"));
    }

    #[test]
    fn preserves_js_source_verbatim() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-compat-{unique}.js"));
        let source_text = "/** @nocollapse */\nconst JSCompiler_renameProperty=(prop,_obj)=>prop;\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || transform_source_file(&file_path))
            .unwrap();

        assert_eq!(output, source_text);
    }

    #[test]
    fn adds_generic_static_property_fallbacks() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-{unique}.js"));
        let source_text = "class Demo {}\nDemo.enabledWarnings = [\"x\"];\nfunction run(){ return this.constructor.enabledWarnings.includes(\"x\"); }\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || transform_source_file(&file_path))
            .unwrap();

        assert!(output.contains("Demo[\"enabledWarnings\"] = Demo[\"enabledWarnings\"] ?? [\"x\"];"));
    }

    #[test]
    fn rewrites_global_alias_property_accesses_in_js_pass_through() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-alias-{unique}.js"));
        let source_text = "const global = globalThis;\nglobal.sharedRegistry ??= new WeakMap();\nconst item = sharedRegistry.get(meta);\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || transform_source_file(&file_path))
            .unwrap();

        assert!(
            output.contains("globalThis.sharedRegistry.get(meta)"),
            "{output}"
        );
    }

    #[test]
    fn preserves_class_static_property_names_via_bracket_access() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("gcc-ts-bundler-js-static-quote-{unique}.js"));
        let source_text = "let Demo = class Demo {};\nDemo.styles = theme;\n";
        fs::write(&file_path, source_text).unwrap();

        let output = GLOBALS
            .set(&Globals::new(), || transform_source_file(&file_path))
            .unwrap();

        assert!(output.contains("Demo[\"styles\"] = theme;"), "{output}");
    }

    #[test]
    fn rewrites_static_class_field_declarations_to_quoted_fields() {
        let transformed = rewrite_static_class_fields(
            "class Demo {\n  static styles = theme;\n  static shadowRootOptions = {};\n}\n".to_string(),
        );

        assert!(transformed.contains("static [\"styles\"] = theme;"));
        assert!(transformed.contains("static [\"shadowRootOptions\"] = {};"));
    }

    #[test]
    fn rewrites_jscompiler_rename_property_protocol_accesses() {
        let transformed = apply_js_compat_text_fixes(
            "const JSCompiler_renameProperty=(prop,_obj)=>prop;\nclass Demo {\n  static check(ctor) { return ctor.elementProperties.size + this.finalized; }\n}\nconst superCtor = Demo;\nDemo[JSCompiler_renameProperty('elementProperties', Demo)] = new Map();\nDemo[JSCompiler_renameProperty('finalized', Demo)] = true;\nsuperCtor.elementProperties;\n".to_string(),
        );

        assert!(transformed.contains("ctor[\"elementProperties\"].size"), "{transformed}");
        assert!(transformed.contains("this[\"finalized\"]"), "{transformed}");
        assert!(transformed.contains("superCtor[\"elementProperties\"]"), "{transformed}");
    }
}
