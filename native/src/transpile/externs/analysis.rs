use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use swc_core::ecma::ast::{
    BinExpr, CallExpr, Callee, ClassMember, Expr, ExprOrSpread, MemberExpr, MemberProp, Pat,
    PropName, SuperProp, SuperPropExpr, VarDeclarator,
};
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::module_cache::get_or_parse_cached_module;

const HARD_PLATFORM_CALLBACK_PROPERTY_NAMES: &[&str] = &[
    "adoptedCallback",
    "attributeChangedCallback",
    "connectedCallback",
    "disconnectedCallback",
    "formAssociatedCallback",
    "formDisabledCallback",
    "formResetCallback",
    "formStateRestoreCallback",
];
const HARD_STATIC_INTEROP_PROPERTY_NAMES: &[&str] = &["formAssociated", "observedAttributes"];

fn is_hard_platform_callback_name(name: &str) -> bool {
    HARD_PLATFORM_CALLBACK_PROPERTY_NAMES.contains(&name)
}

fn is_hard_static_interop_name(name: &str) -> bool {
    HARD_STATIC_INTEROP_PROPERTY_NAMES.contains(&name)
}

#[derive(Default)]
pub(crate) struct ExternPropertyAnalysis {
    pub(crate) preserved_property_names: HashSet<String>,
    pub(crate) static_property_names: HashSet<String>,
}

#[derive(Default)]
struct ParsedExternFileAnalysis {
    accessed_hazard_names: HashSet<String>,
    defined_hazard_names: HashSet<String>,
    platform_callback_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_property_names: HashSet<String>,
}

pub(crate) fn collect_extern_property_names(
    file_names: &[String],
    global_property_names: &HashSet<String>,
) -> std::result::Result<ExternPropertyAnalysis, String> {
    let mut preserved_property_names = global_property_names.clone();
    let mut static_property_names = HashSet::new();

    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let file_path = PathBuf::from(file_name);
        match get_or_parse_cached_module(&file_path) {
            Ok(module) => {
                let mut collector = ExternPropertyCollector::default();
                module.visit_with(&mut collector);
                let analysis = collector.finish();
                static_property_names.extend(analysis.static_property_names.iter().cloned());
                preserved_property_names.extend(analysis.platform_callback_names);
                preserved_property_names.extend(analysis.reflective_property_names);
                preserved_property_names.extend(
                    analysis
                        .defined_hazard_names
                        .intersection(&analysis.accessed_hazard_names)
                        .cloned(),
                );
            }
            Err(_) => {
                let source_text =
                    fs::read_to_string(file_name).map_err(|error| error.to_string())?;
                static_property_names.extend(collect_static_property_names_from_text(&source_text));
            }
        }
    }

    preserved_property_names.extend(static_property_names.iter().cloned());
    Ok(ExternPropertyAnalysis {
        preserved_property_names,
        static_property_names,
    })
}

#[cfg(test)]
pub(crate) fn collect_preserved_property_names(
    file_names: &[String],
    global_property_names: &HashSet<String>,
    _static_property_names: &HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    Ok(collect_extern_property_names(file_names, global_property_names)?.preserved_property_names)
}

pub(crate) fn collect_static_property_names_from_text(source_text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, property_name) in super::super::collect_class_static_assignments(source_text) {
        if is_hard_static_interop_name(&property_name) {
            names.insert(property_name);
        }
    }
    if let Ok(regex) =
        regex::Regex::new(r"\bstatic\s+(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|\()")
    {
        for captures in regex.captures_iter(source_text) {
            if let Some(capture) = captures.get(1) {
                let property_name = capture.as_str();
                if is_hard_static_interop_name(property_name) {
                    names.insert(property_name.to_string());
                }
            }
        }
    }
    names
}

pub(crate) fn collect_names_from_files(
    file_names: &[String],
    collect_names: fn(&str) -> HashSet<String>,
) -> std::result::Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for file_name in file_names {
        if file_name.ends_with(".d.ts") {
            continue;
        }
        let source_text = fs::read_to_string(file_name).map_err(|error| error.to_string())?;
        names.extend(collect_names(&source_text));
    }
    Ok(names)
}

pub(crate) fn is_valid_js_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

pub(crate) fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

#[derive(Default)]
struct ExternPropertyCollector {
    accessed_hazard_names: HashSet<String>,
    class_name_stack: Vec<Option<String>>,
    defined_hazard_names: HashSet<String>,
    platform_callback_names: HashSet<String>,
    reflective_property_names: HashSet<String>,
    static_context_depth: usize,
    static_property_names: HashSet<String>,
}

impl ExternPropertyCollector {
    fn finish(self) -> ParsedExternFileAnalysis {
        ParsedExternFileAnalysis {
            accessed_hazard_names: self.accessed_hazard_names,
            defined_hazard_names: self.defined_hazard_names,
            platform_callback_names: self.platform_callback_names,
            reflective_property_names: self.reflective_property_names,
            static_property_names: self.static_property_names,
        }
    }

    fn current_class_name(&self) -> Option<&str> {
        self.class_name_stack
            .last()
            .and_then(|name| name.as_deref())
    }

    fn insert_accessed_hazard_name(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.accessed_hazard_names.insert(property_name.to_string());
        }
    }

    fn insert_defined_hazard_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_valid_js_identifier(&property_name) {
                self.defined_hazard_names.insert(property_name);
            }
        }
    }

    fn insert_platform_callback_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_hard_platform_callback_name(&property_name) {
                self.platform_callback_names.insert(property_name);
            }
        }
    }

    fn insert_reflective_name(&mut self, property_name: &str) {
        if is_valid_js_identifier(property_name) {
            self.reflective_property_names
                .insert(property_name.to_string());
        }
    }

    fn insert_static_name(&mut self, property_name: Option<String>) {
        if let Some(property_name) = property_name {
            if is_hard_static_interop_name(&property_name) {
                self.static_property_names.insert(property_name);
            }
        }
    }

    fn with_static_context<F>(&mut self, callback: F)
    where
        F: FnOnce(&mut Self),
    {
        self.static_context_depth += 1;
        callback(self);
        self.static_context_depth -= 1;
    }
}

impl Visit for ExternPropertyCollector {
    fn visit_class_decl(&mut self, class_decl: &swc_core::ecma::ast::ClassDecl) {
        self.class_name_stack
            .push(Some(class_decl.ident.sym.to_string()));
        class_decl.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_class_expr(&mut self, class_expr: &swc_core::ecma::ast::ClassExpr) {
        self.class_name_stack
            .push(class_expr.ident.as_ref().map(|ident| ident.sym.to_string()));
        class_expr.class.visit_with(self);
        self.class_name_stack.pop();
    }

    fn visit_class_member(&mut self, member: &ClassMember) {
        match member {
            ClassMember::ClassProp(prop) => {
                let prop_name = prop_name_to_string(&prop.key);
                self.insert_platform_callback_name(prop_name.clone());
                if prop.is_static {
                    self.insert_static_name(prop_name);
                }
                prop.visit_children_with(self);
            }
            ClassMember::Method(method) => {
                let prop_name = prop_name_to_string(&method.key);
                self.insert_platform_callback_name(prop_name.clone());
                if method.is_static {
                    self.insert_static_name(prop_name);
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            ClassMember::PrivateMethod(method) => {
                if method.is_static {
                    self.with_static_context(|collector| method.function.visit_with(collector));
                } else {
                    method.visit_children_with(self);
                }
            }
            _ => member.visit_children_with(self),
        }
    }

    fn visit_member_expr(&mut self, member_expr: &MemberExpr) {
        match &member_expr.prop {
            MemberProp::Ident(prop_ident) => {
                let property_name = prop_ident.sym.as_ref();
                self.insert_platform_callback_name(Some(property_name.to_string()));
                self.insert_accessed_hazard_name(property_name);
            }
            MemberProp::Computed(computed) => {
                if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*computed.expr {
                    self.insert_reflective_name(&value.value.to_string_lossy());
                }
            }
            MemberProp::PrivateName(_) => {}
        }

        if self.static_context_depth > 0 {
            let is_static_target = match &*member_expr.obj {
                Expr::This(_) => true,
                Expr::Ident(ident) => self
                    .current_class_name()
                    .map(|class_name| ident.sym.as_ref() == class_name)
                    .unwrap_or(false),
                _ => false,
            };
            if is_static_target {
                self.insert_static_name(member_prop_name(&member_expr.prop));
            }
        }
        member_expr.visit_children_with(self);
    }

    fn visit_super_prop_expr(&mut self, super_prop: &SuperPropExpr) {
        match &super_prop.prop {
            SuperProp::Ident(ident) => {
                let property_name = ident.sym.as_ref();
                self.insert_platform_callback_name(Some(property_name.to_string()));
                self.insert_accessed_hazard_name(property_name);
            }
            SuperProp::Computed(computed) => {
                if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*computed.expr {
                    self.insert_platform_callback_name(Some(
                        value.value.to_string_lossy().to_string(),
                    ));
                }
            }
        }
        super_prop.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, declarator: &VarDeclarator) {
        if declarator.init.is_some() {
            collect_pattern_property_reads(&declarator.name, &mut self.accessed_hazard_names);
        }
        declarator.visit_children_with(self);
    }

    fn visit_object_lit(&mut self, object_lit: &swc_core::ecma::ast::ObjectLit) {
        for prop in &object_lit.props {
            let swc_core::ecma::ast::PropOrSpread::Prop(prop) = prop else {
                continue;
            };
            match prop.as_ref() {
                swc_core::ecma::ast::Prop::KeyValue(key_value) => {
                    let property_name = string_defined_prop_name(&key_value.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Getter(getter) => {
                    let property_name = string_defined_prop_name(&getter.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Setter(setter) => {
                    let property_name = string_defined_prop_name(&setter.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                swc_core::ecma::ast::Prop::Method(method) => {
                    let property_name = string_defined_prop_name(&method.key);
                    self.insert_defined_hazard_name(property_name.clone());
                    if let Some(property_name) = property_name {
                        self.insert_reflective_name(&property_name);
                    }
                }
                _ => {}
            }
        }
        object_lit.visit_children_with(self);
    }

    fn visit_prop_name(&mut self, prop_name: &PropName) {
        if let PropName::Str(value) = prop_name {
            self.insert_reflective_name(&value.value.to_string_lossy());
        }
        prop_name.visit_children_with(self);
    }

    fn visit_bin_expr(&mut self, bin_expr: &BinExpr) {
        if bin_expr.op == swc_core::ecma::ast::BinaryOp::In {
            if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &*bin_expr.left {
                self.insert_reflective_name(&value.value.to_string_lossy());
            }
        }
        bin_expr.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        match &call_expr.callee {
            Callee::Expr(callee_expr) => match &**callee_expr {
                Expr::Ident(ident) if ident.sym == *"JSCompiler_renameProperty" => {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.first() {
                        if let Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) = &**expr {
                            self.insert_reflective_name(&value.value.to_string_lossy());
                        }
                    }
                }
                Expr::Ident(ident)
                    if ident.sym == *"__publicField" && call_expr.args.len() >= 2 =>
                {
                    if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(1) {
                        self.insert_defined_hazard_name(string_literal_expr_name(expr));
                    }
                }
                Expr::Member(member) => {
                    let method_name = member_prop_name(&member.prop);
                    let object_name = match &*member.obj {
                        Expr::Ident(ident) => Some(ident.sym.as_ref()),
                        _ => None,
                    };
                    let string_arg_index = match (object_name, method_name.as_deref()) {
                        (Some("Object"), Some("defineProperty")) => Some(1usize),
                        (Some("Object"), Some("hasOwn")) => Some(1usize),
                        (Some("Reflect"), Some("defineProperty")) => Some(1usize),
                        (Some("Reflect"), Some("deleteProperty")) => Some(1usize),
                        (Some("Reflect"), Some("get")) => Some(1usize),
                        (Some("Reflect"), Some("has")) => Some(1usize),
                        (Some("Reflect"), Some("set")) => Some(1usize),
                        _ => None,
                    };
                    if let Some(index) = string_arg_index {
                        if let Some(ExprOrSpread { expr, .. }) = call_expr.args.get(index) {
                            let string_name = string_literal_expr_name(expr);
                            if let Some(property_name) = string_name.clone() {
                                self.insert_reflective_name(&property_name);
                            }
                            if matches!(
                                (object_name, method_name.as_deref()),
                                (Some("Object"), Some("defineProperty"))
                                    | (Some("Reflect"), Some("defineProperty"))
                            ) {
                                self.insert_defined_hazard_name(string_name);
                            }
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
        call_expr.visit_children_with(self);
    }
}

fn string_defined_prop_name(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Computed(computed) => string_literal_expr_name(&computed.expr),
        _ => None,
    }
}

fn string_literal_expr_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Lit(swc_core::ecma::ast::Lit::Str(value)) => {
            Some(value.value.to_string_lossy().to_string())
        }
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            template.quasis.first().map(|quasi| quasi.raw.to_string())
        }
        _ => None,
    }
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
        MemberProp::PrivateName(_) => None,
    }
}

fn collect_pattern_property_reads(pattern: &Pat, names: &mut HashSet<String>) {
    match pattern {
        Pat::Object(object) => {
            for prop in &object.props {
                match prop {
                    swc_core::ecma::ast::ObjectPatProp::KeyValue(key_value) => {
                        if let Some(property_name) = prop_name_to_string(&key_value.key) {
                            if is_valid_js_identifier(&property_name) {
                                names.insert(property_name);
                            }
                        }
                        collect_pattern_property_reads(&key_value.value, names);
                    }
                    swc_core::ecma::ast::ObjectPatProp::Assign(assign) => {
                        names.insert(assign.key.sym.to_string());
                    }
                    swc_core::ecma::ast::ObjectPatProp::Rest(rest) => {
                        collect_pattern_property_reads(&rest.arg, names);
                    }
                }
            }
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_pattern_property_reads(element, names);
            }
        }
        Pat::Assign(assign) => collect_pattern_property_reads(&assign.left, names),
        Pat::Rest(rest) => collect_pattern_property_reads(&rest.arg, names),
        _ => {}
    }
}
