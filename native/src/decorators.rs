use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use swc_core::common::{sync::Lrc, SourceMap};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};

use crate::commonjs::evaluate_boolean_expr;
use crate::module_cache::parse_module;

pub fn rewrite_decorator_metadata(
    code: String,
    property_renaming_report: String,
) -> std::result::Result<String, String> {
    if property_renaming_report.trim().is_empty() {
        return Ok(code);
    }

    let renames = parse_property_renaming_report(&property_renaming_report);
    if renames.is_empty() {
        return Ok(code);
    }

    let mut module = parse_module(&PathBuf::from("property-protocol-bundle.js"), &code)?;
    let mut rewriter = PropertyProtocolRewriter {
        changed: false,
        property_key_scopes: vec![PropertyKeyScope::default()],
        renames: &renames,
    };
    module.visit_mut_with(&mut rewriter);
    if !rewriter.changed {
        return Ok(code);
    }

    print_module_minified(&module)
}

fn parse_property_renaming_report(report: &str) -> HashMap<String, String> {
    let mut renames = HashMap::new();
    for line in report.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((original, renamed)) = trimmed.split_once(':') else {
            continue;
        };
        if !original.is_empty() && !renamed.is_empty() {
            renames.insert(original.to_string(), renamed.to_string());
        }
    }
    renames
}

struct PropertyProtocolRewriter<'a> {
    changed: bool,
    property_key_scopes: Vec<PropertyKeyScope>,
    renames: &'a HashMap<String, String>,
}

#[derive(Default)]
struct PropertyKeyScope {
    identifiers: HashSet<String>,
    member_paths: HashSet<String>,
}

impl PropertyProtocolRewriter<'_> {
    fn maybe_rewrite_metadata_object(&mut self, object: &mut ObjectLit) {
        let Some(kind) = get_string_property_value(object, "kind") else {
            return;
        };
        if !matches!(
            kind.as_str(),
            "accessor" | "field" | "getter" | "method" | "setter"
        ) {
            return;
        }
        if matches!(get_boolean_property_value(object, "private"), Some(true)) {
            return;
        }
        let Some(original_name) = get_string_property_value(object, "name") else {
            return;
        };
        let Some(renamed) = self.renames.get(&original_name).cloned() else {
            return;
        };
        if renamed == original_name {
            return;
        }

        if set_string_property_value(object, "name", &renamed) {
            self.changed = true;
        }
        if let Some(access) = get_object_property_value_mut(object, "access") {
            let mut rewriter = DecoratorAccessHasRewriter {
                changed: false,
                original_name: &original_name,
                renamed_name: &renamed,
            };
            access.visit_mut_with(&mut rewriter);
            self.changed |= rewriter.changed;
        }
    }

    fn maybe_rewrite_string_literal(&mut self, value: &mut Str) -> bool {
        let original_name = value.value.to_string_lossy();
        let Some(renamed_name) = self.renames.get(original_name.as_ref()) else {
            return false;
        };
        if renamed_name == original_name.as_ref() {
            return false;
        }

        value.value = renamed_name.as_str().into();
        true
    }

    fn maybe_rewrite_space_separated_tokens(&mut self, value: &mut Str) -> bool {
        let original = value.value.to_string_lossy().to_string();
        if original.is_empty() || !original.contains(' ') {
            return false;
        }

        let mut changed = false;
        let rewritten = original
            .split(' ')
            .map(|token| {
                if let Some(renamed) = self.renames.get(token) {
                    changed = true;
                    renamed.as_str()
                } else {
                    token
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        if !changed || rewritten == original {
            return false;
        }

        value.value = rewritten.as_str().into();
        true
    }

    fn maybe_rewrite_property_name_array(&mut self, array: &mut ArrayLit) -> bool {
        let Some(elements) = array
            .elems
            .iter()
            .map(|element| {
                element
                    .as_ref()
                    .and_then(|item| match &*item.expr {
                        Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
                        _ => None,
                    })
            })
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };

        if !elements.iter().any(|element| self.renames.contains_key(element))
            || !elements.iter().all(|element| looks_like_property_name(element))
        {
            return false;
        }

        let mut changed = false;
        for element in array.elems.iter_mut().flatten() {
            let Expr::Lit(Lit::Str(value)) = &mut *element.expr else {
                continue;
            };
            changed |= self.maybe_rewrite_string_literal(value);
        }
        changed
    }

    fn maybe_rewrite_string_literal_expr(&mut self, expr: &mut Expr) -> bool {
        match expr {
            Expr::Lit(Lit::Str(value)) => self.maybe_rewrite_string_literal(value),
            _ => false,
        }
    }

    fn is_property_key_expr(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(ident) => self
                .property_key_scopes
                .iter()
                .rev()
                .any(|scope| scope.identifiers.contains(ident.sym.as_ref())),
            Expr::Member(member) => property_key_member_path(member).is_some_and(|path| {
                self.property_key_scopes
                    .iter()
                    .rev()
                    .any(|scope| scope.member_paths.contains(&path))
            }),
            Expr::Paren(paren) => self.is_property_key_expr(&paren.expr),
            Expr::Seq(sequence) => sequence
                .exprs
                .last()
                .is_some_and(|expr| self.is_property_key_expr(expr)),
            _ => false,
        }
    }

    fn push_property_key_scope(&mut self, binding_names: HashSet<String>) {
        self.property_key_scopes.push(PropertyKeyScope {
            identifiers: binding_names,
            member_paths: HashSet::new(),
        });
    }

    fn pop_property_key_scope(&mut self) {
        self.property_key_scopes.pop();
    }

    fn current_scope_mut(&mut self) -> &mut PropertyKeyScope {
        self.property_key_scopes
            .last_mut()
            .expect("property key scope should always exist")
    }

    fn track_property_key_pat(&mut self, pattern: &Pat) {
        if let Pat::Ident(binding) = pattern {
            self.current_scope_mut()
                .identifiers
                .insert(binding.id.sym.to_string());
        }
    }

    fn clear_property_key_binding(&mut self, binding_name: &str) {
        let scope = self.current_scope_mut();
        scope.identifiers.remove(binding_name);
        let member_prefix = format!("{binding_name}.");
        scope
            .member_paths
            .retain(|path| !path.starts_with(&member_prefix));
    }

    fn clear_property_key_pat(&mut self, pattern: &Pat) {
        if let Pat::Ident(binding) = pattern {
            self.clear_property_key_binding(binding.id.sym.as_ref());
        }
    }

    fn track_property_key_assign_target(&mut self, target: &AssignTarget) {
        match target {
            AssignTarget::Simple(SimpleAssignTarget::Ident(binding)) => {
                self.current_scope_mut()
                    .identifiers
                    .insert(binding.id.sym.to_string());
            }
            AssignTarget::Simple(SimpleAssignTarget::Member(member)) => {
                if let Some(path) = property_key_member_path(member) {
                    self.current_scope_mut().member_paths.insert(path);
                }
            }
            _ => {}
        }
    }

    fn clear_property_key_assign_target(&mut self, target: &AssignTarget) {
        match target {
            AssignTarget::Simple(SimpleAssignTarget::Ident(binding)) => {
                self.clear_property_key_binding(binding.id.sym.as_ref());
            }
            AssignTarget::Simple(SimpleAssignTarget::Member(member)) => {
                let Some(path) = property_key_member_path(member) else {
                    return;
                };
                self.current_scope_mut().member_paths.remove(&path);
            }
            _ => {}
        }
    }
}

impl VisitMut for PropertyProtocolRewriter<'_> {
    fn visit_mut_call_expr(&mut self, call_expr: &mut CallExpr) {
        call_expr.visit_mut_children_with(self);

        if let Callee::Expr(callee_expr) = &mut call_expr.callee {
            if let Some(key_list_param_indexes) = collect_key_list_param_indexes(callee_expr) {
                for index in key_list_param_indexes {
                    let Some(argument) = call_expr.args.get_mut(index) else {
                        continue;
                    };
                    if let Expr::Array(array) = &mut *argument.expr {
                        if self.maybe_rewrite_property_name_array(array) {
                            self.changed = true;
                        }
                    }
                }
            }
            if let Expr::Member(member) = &mut **callee_expr {
                if matches!(&member.prop, MemberProp::Ident(ident) if ident.sym == *"split")
                    && call_expr.args.len() == 1
                    && matches!(
                        &*call_expr.args[0].expr,
                        Expr::Lit(Lit::Str(value)) if value.value == *" "
                    )
                {
                    if let Expr::Lit(Lit::Str(value)) = &mut *member.obj {
                        if self.maybe_rewrite_space_separated_tokens(value) {
                            self.changed = true;
                        }
                    }
                }
            }
        }

        for argument in &mut call_expr.args {
            if let Expr::Object(object) = &mut *argument.expr {
                self.maybe_rewrite_metadata_object(object);
            }
        }
    }

    fn visit_mut_var_declarator(&mut self, declarator: &mut VarDeclarator) {
        declarator.visit_mut_children_with(self);

        let Some(init) = declarator.init.as_deref() else {
            return;
        };
        if self.is_property_key_expr(init) {
            self.track_property_key_pat(&declarator.name);
        } else {
            self.clear_property_key_pat(&declarator.name);
        }
    }

    fn visit_mut_bin_expr(&mut self, bin_expr: &mut BinExpr) {
        bin_expr.visit_mut_children_with(self);

        match bin_expr.op {
            BinaryOp::In => {
                if self.maybe_rewrite_string_literal_expr(&mut bin_expr.left) {
                    self.changed = true;
                }
            }
            BinaryOp::EqEq
            | BinaryOp::EqEqEq
            | BinaryOp::NotEq
            | BinaryOp::NotEqEq => {
                if self.is_property_key_expr(&bin_expr.left)
                    && self.maybe_rewrite_string_literal_expr(&mut bin_expr.right)
                {
                    self.changed = true;
                }
                if self.is_property_key_expr(&bin_expr.right)
                    && self.maybe_rewrite_string_literal_expr(&mut bin_expr.left)
                {
                    self.changed = true;
                }
            }
            _ => {}
        }
    }

    fn visit_mut_switch_stmt(&mut self, switch_stmt: &mut SwitchStmt) {
        switch_stmt.visit_mut_children_with(self);

        if !self.is_property_key_expr(&switch_stmt.discriminant) {
            return;
        }

        for case in &mut switch_stmt.cases {
            let Some(test) = &mut case.test else {
                continue;
            };
            if self.maybe_rewrite_string_literal_expr(test) {
                self.changed = true;
            }
        }
    }

    fn visit_mut_assign_expr(&mut self, assign_expr: &mut AssignExpr) {
        assign_expr.visit_mut_children_with(self);

        if self.is_property_key_expr(&assign_expr.right) {
            self.track_property_key_assign_target(&assign_expr.left);
        } else {
            self.clear_property_key_assign_target(&assign_expr.left);
        }
    }

    fn visit_mut_for_in_stmt(&mut self, for_in_stmt: &mut ForInStmt) {
        for_in_stmt.left.visit_mut_with(self);
        for_in_stmt.right.visit_mut_with(self);

        let binding_names = collect_for_in_binding_names(&for_in_stmt.left);
        self.push_property_key_scope(binding_names);
        for_in_stmt.body.visit_mut_with(self);
        self.pop_property_key_scope();
    }
}

struct DecoratorAccessHasRewriter<'a> {
    changed: bool,
    original_name: &'a str,
    renamed_name: &'a str,
}

impl VisitMut for DecoratorAccessHasRewriter<'_> {
    fn visit_mut_bin_expr(&mut self, bin_expr: &mut BinExpr) {
        bin_expr.visit_mut_children_with(self);

        if bin_expr.op != BinaryOp::In {
            return;
        }
        let Expr::Lit(Lit::Str(value)) = &mut *bin_expr.left else {
            return;
        };
        if value.value.to_string_lossy() != self.original_name {
            return;
        }

        value.value = self.renamed_name.into();
        self.changed = true;
    }
}

fn get_object_property_value_mut<'a>(
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

fn get_boolean_property_value(object: &ObjectLit, property_name: &str) -> Option<bool> {
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

fn get_string_property_value(object: &ObjectLit, property_name: &str) -> Option<String> {
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

fn prop_name_to_string(prop_name: &PropName) -> Option<String> {
    match prop_name {
        PropName::Ident(ident) => Some(ident.sym.to_string()),
        PropName::Str(value) => Some(value.value.to_string_lossy().to_string()),
        PropName::Num(value) => Some(value.value.to_string()),
        _ => None,
    }
}

fn set_string_property_value(
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
        emitter
            .emit_module(module)
            .map_err(|error| error.to_string())?;
    }
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn collect_for_in_binding_names(left: &ForHead) -> HashSet<String> {
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

fn collect_binding_names_from_pat(pattern: &Pat, names: &mut HashSet<String>) {
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

fn looks_like_property_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn property_key_member_path(member: &MemberExpr) -> Option<String> {
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

fn collect_key_list_param_indexes(callee_expr: &Expr) -> Option<HashSet<usize>> {
    match unwrap_paren_expr(callee_expr) {
        Expr::Fn(function_expr) => Some(collect_function_key_list_param_indexes(
            &function_expr.function.params,
            function_expr.function.body.as_ref()?,
        )),
        Expr::Arrow(arrow_expr) => Some(collect_arrow_key_list_param_indexes(arrow_expr)),
        _ => None,
    }
}

fn unwrap_paren_expr(expr: &Expr) -> &Expr {
    match expr {
        Expr::Paren(paren) => unwrap_paren_expr(&paren.expr),
        _ => expr,
    }
}

fn collect_function_key_list_param_indexes(
    params: &[Param],
    body: &BlockStmt,
) -> HashSet<usize> {
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

#[cfg(test)]
mod tests {
    use super::rewrite_decorator_metadata;

    #[test]
    fn rewrites_decorator_metadata_names_and_access_has_checks() {
        let output = rewrite_decorator_metadata(
            "function g(A,y,d,b,e,n){return b}g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("name:\"J\""), "{output}");
        assert!(output.contains("\"J\"in H"), "{output}");
    }

    #[test]
    fn leaves_unrelated_string_literals_untouched() {
        let output = rewrite_decorator_metadata(
            "console.log(\"letters\");g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("console.log(\"letters\")"), "{output}");
        assert!(output.contains("name:\"J\""), "{output}");
    }

    #[test]
    fn skips_metadata_without_string_literal_names() {
        let input =
            "g(null,y={value:b},A,{kind:\"class\",name:b.name,metadata:D},null,d);".to_string();
        let output =
            rewrite_decorator_metadata(input.clone(), "letters:J\n".to_string()).expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn rewrites_property_key_comparisons_for_for_in_variables() {
        let output = rewrite_decorator_metadata(
            "for(const key in attrs){if(key===\"class\"){apply(attrs[key])}else if(key!==\"style\"){sync(key)}}".to_string(),
            "class:o\nstyle:i\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("key===\"o\""), "{output}");
        assert!(output.contains("key!==\"i\""), "{output}");
    }

    #[test]
    fn rewrites_space_separated_property_lists() {
        let output = rewrite_decorator_metadata(
            "const keys=\"$$slots $$events $$legacy variant children\".split(\" \");".to_string(),
            "$$slots:i\n$$events:j\n$$legacy:k\nvariant:l\n".to_string(),
        )
        .expect("rewrite");

        assert!(
            output.contains("\"i j k l children\".split(\" \")"),
            "{output}"
        );
    }

    #[test]
    fn rewrites_array_literal_key_lists_passed_to_key_filter_functions() {
        let output = rewrite_decorator_metadata(
            "(function(props,exclude){for(const key in props){if(exclude.includes(key))continue;use(key)}})(attrs,[\"$$slots\",\"$$events\",\"$$legacy\",\"variant\"]);".to_string(),
            "$$slots:i\n$$events:j\n$$legacy:k\nvariant:l\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("[\"i\",\"j\",\"k\",\"l\"]"), "{output}");
    }

    #[test]
    fn leaves_plain_string_arrays_untouched() {
        let input = "const letters=[\"L\",\"I\",\"T\"];".to_string();
        let output = rewrite_decorator_metadata(
            input.clone(),
            "L:fc\nI:qb\nT:Pa\n".to_string(),
        )
        .expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn leaves_plain_css_property_arrays_untouched() {
        let input =
            "const props=[\"left\",\"top\",\"width\",\"height\",\"opacity\",\"color\",\"background\"];"
                .to_string();
        let output = rewrite_decorator_metadata(
            input.clone(),
            "left:a\ntop:b\nwidth:c\nheight:d\nopacity:e\ncolor:0\nbackground:g\n".to_string(),
        )
        .expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn rewrites_switch_cases_for_property_key_variables() {
        let output = rewrite_decorator_metadata(
            "for(const key in attrs){switch(key){case\"class\":a();break;case\"role\":b();break;}}".to_string(),
            "class:o\nrole:r\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("case\"o\""), "{output}");
        assert!(output.contains("case\"r\""), "{output}");
    }

    #[test]
    fn rewrites_string_in_checks_outside_decorator_metadata() {
        let output = rewrite_decorator_metadata(
            "if(\"label\" in props){use(props)}".to_string(),
            "label:sa\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("\"sa\"in props"), "{output}");
    }

    #[test]
    fn rewrites_member_carrier_comparisons_for_property_keys() {
        let output = rewrite_decorator_metadata(
            "for(var key in attrs){state.current=key;if(state.current===\"class\"){apply(attrs[key])}}"
                .to_string(),
            "class:o\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("state.current===\"o\""), "{output}");
    }
}
