use std::collections::{HashMap, HashSet};

use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitWith};

use crate::commonjs::evaluate_boolean_expr;

pub(super) fn get_object_property_value_mut<'a>(
    object: &'a mut ObjectLit,
    property_name: &str,
) -> Option<&'a mut ObjectLit> {
    for property in &mut object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_mut() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Object(value) = &mut *key_value.value else {
            return None;
        };
        return Some(value);
    }
    None
}

pub(super) fn get_boolean_property_value(
    object: &ObjectLit,
    property_name: &str,
) -> Option<bool> {
    for property in &object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_ref() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        return evaluate_boolean_expr(&key_value.value);
    }
    None
}

pub(super) fn get_string_property_value(object: &ObjectLit, property_name: &str) -> Option<String> {
    for property in &object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_ref() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Lit(Lit::Str(value)) = &*key_value.value else {
            return None;
        };
        return Some(value.value.to_string_lossy().to_string());
    }
    None
}

pub(super) fn set_string_property_value(
    object: &mut ObjectLit,
    property_name: &str,
    next_value: &str,
) -> bool {
    for property in &mut object.props {
        let PropOrSpread::Prop(prop) = property else {
            continue;
        };
        let Prop::KeyValue(key_value) = prop.as_mut() else {
            continue;
        };
        if prop_name_to_string(&key_value.key).as_deref() != Some(property_name) {
            continue;
        }
        let Expr::Lit(Lit::Str(value)) = &mut *key_value.value else {
            return false;
        };
        value.value = next_value.into();
        return true;
    }
    false
}

pub(super) fn print_module_minified(module: &Module) -> std::result::Result<String, String> {
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
        emitter
            .emit_module(module)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

pub(super) fn collect_for_in_binding_names(left: &ForHead) -> HashSet<String> {
    let mut names = HashSet::new();
    match left {
        ForHead::VarDecl(var_decl) => {
            for declarator in &var_decl.decls {
                collect_binding_names_from_pat(&declarator.name, &mut names);
            }
        }
        ForHead::UsingDecl(using_decl) => {
            for declarator in &using_decl.decls {
                collect_binding_names_from_pat(&declarator.name, &mut names);
            }
        }
        ForHead::Pat(pattern) => collect_binding_names_from_pat(pattern, &mut names),
    }
    names
}

pub(super) fn collect_binding_names_from_pat(pattern: &Pat, names: &mut HashSet<String>) {
    match pattern {
        Pat::Ident(binding) => {
            names.insert(binding.id.sym.to_string());
        }
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_binding_names_from_pat(element, names);
            }
        }
        Pat::Assign(assign) => collect_binding_names_from_pat(&assign.left, names),
        Pat::Object(object) => {
            for prop in &object.props {
                match prop {
                    ObjectPatProp::Assign(assign) => {
                        names.insert(assign.key.sym.to_string());
                    }
                    ObjectPatProp::KeyValue(key_value) => {
                        collect_binding_names_from_pat(&key_value.value, names);
                    }
                    ObjectPatProp::Rest(rest) => collect_binding_names_from_pat(&rest.arg, names),
                }
            }
        }
        Pat::Rest(rest) => collect_binding_names_from_pat(&rest.arg, names),
        _ => {}
    }
}

pub(super) fn looks_like_property_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

pub(super) fn property_key_member_path(member: &MemberExpr) -> Option<String> {
    let object_path = match &*member.obj {
        Expr::Ident(ident) => ident.sym.to_string(),
        Expr::Member(inner_member) => property_key_member_path(inner_member)?,
        Expr::Paren(paren) => property_key_member_path_from_expr(&paren.expr)?,
        _ => return None,
    };
    let prop_name = member_prop_name(&member.prop)?;
    Some(format!("{object_path}.{prop_name}"))
}

fn property_key_member_path_from_expr(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Member(member) => property_key_member_path(member),
        Expr::Paren(paren) => property_key_member_path_from_expr(&paren.expr),
        _ => None,
    }
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => match &*computed.expr {
            Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
            Expr::Lit(Lit::Num(value)) => Some(value.value.to_string()),
            _ => None,
        },
        MemberProp::PrivateName(_) => None,
    }
}

pub(super) fn collect_key_list_param_indexes(callee_expr: &Expr) -> Option<HashSet<usize>> {
    match unwrap_paren_expr(callee_expr) {
        Expr::Fn(function_expr) => Some(collect_function_key_list_param_indexes(
            &function_expr.function.params,
            function_expr.function.body.as_ref()?,
        )),
        Expr::Arrow(arrow_expr) => Some(collect_arrow_key_list_param_indexes(arrow_expr)),
        _ => None,
    }
}

fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

fn unwrap_paren_expr(expr: &Expr) -> &Expr {
    match expr {
        Expr::Paren(paren) => unwrap_paren_expr(&paren.expr),
        _ => expr,
    }
}

fn collect_function_key_list_param_indexes(params: &[Param], body: &BlockStmt) -> HashSet<usize> {
    let mut parameter_indexes = HashMap::new();
    for (index, param) in params.iter().enumerate() {
        let mut names = HashSet::new();
        collect_binding_names_from_pat(&param.pat, &mut names);
        for name in names {
            parameter_indexes.insert(name, index);
        }
    }

    let mut collector = PropertyKeyUsageCollector::new(parameter_indexes);
    body.visit_with(&mut collector);
    collector.used_parameter_indexes
}

fn collect_arrow_key_list_param_indexes(arrow_expr: &ArrowExpr) -> HashSet<usize> {
    let mut parameter_indexes = HashMap::new();
    for (index, param) in arrow_expr.params.iter().enumerate() {
        let mut names = HashSet::new();
        collect_binding_names_from_pat(param, &mut names);
        for name in names {
            parameter_indexes.insert(name, index);
        }
    }

    let mut collector = PropertyKeyUsageCollector::new(parameter_indexes);
    match &*arrow_expr.body {
        BlockStmtOrExpr::BlockStmt(block_stmt) => block_stmt.visit_with(&mut collector),
        BlockStmtOrExpr::Expr(expr) => expr.visit_with(&mut collector),
    }
    collector.used_parameter_indexes
}

struct PropertyKeyUsageCollector {
    parameter_indexes: HashMap<String, usize>,
    property_key_scopes: Vec<HashSet<String>>,
    used_parameter_indexes: HashSet<usize>,
}

impl PropertyKeyUsageCollector {
    fn new(parameter_indexes: HashMap<String, usize>) -> Self {
        Self {
            parameter_indexes,
            property_key_scopes: vec![HashSet::new()],
            used_parameter_indexes: HashSet::new(),
        }
    }

    fn is_property_key_expr(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(ident) => self
                .property_key_scopes
                .iter()
                .rev()
                .any(|scope| scope.contains(ident.sym.as_ref())),
            Expr::Paren(paren) => self.is_property_key_expr(&paren.expr),
            Expr::Seq(sequence) => sequence
                .exprs
                .last()
                .is_some_and(|expr| self.is_property_key_expr(expr)),
            _ => false,
        }
    }
}

impl Visit for PropertyKeyUsageCollector {
    fn visit_function(&mut self, _: &Function) {}

    fn visit_arrow_expr(&mut self, _: &ArrowExpr) {}

    fn visit_call_expr(&mut self, call_expr: &CallExpr) {
        if let Callee::Expr(callee_expr) = &call_expr.callee {
            if let Expr::Member(member) = &**callee_expr {
                if let Expr::Ident(ident) = &*member.obj {
                    if let Some(index) = self.parameter_indexes.get(ident.sym.as_ref()) {
                        let is_key_list_lookup = matches!(
                            &member.prop,
                            MemberProp::Ident(prop_ident)
                                if matches!(prop_ident.sym.as_ref(), "includes" | "indexOf" | "has")
                        );
                        if is_key_list_lookup
                            && call_expr
                                .args
                                .first()
                                .is_some_and(|arg| self.is_property_key_expr(&arg.expr))
                        {
                            self.used_parameter_indexes.insert(*index);
                        }
                    }
                }
            }
        }

        call_expr.visit_children_with(self);
    }

    fn visit_for_in_stmt(&mut self, for_in_stmt: &ForInStmt) {
        for_in_stmt.left.visit_with(self);
        for_in_stmt.right.visit_with(self);

        let binding_names = collect_for_in_binding_names(&for_in_stmt.left);
        self.property_key_scopes.push(binding_names);
        for_in_stmt.body.visit_with(self);
        self.property_key_scopes.pop();
    }
}
