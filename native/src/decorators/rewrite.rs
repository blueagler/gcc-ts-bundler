use std::collections::{HashMap, HashSet};

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

use super::utils::{
    collect_for_in_binding_names, collect_key_list_param_indexes, get_boolean_property_value,
    get_object_property_value_mut, get_string_property_value, looks_like_property_name,
    property_key_member_path, set_string_property_value,
};

pub(super) struct PropertyProtocolRewriter<'a> {
    pub(super) changed: bool,
    property_key_scopes: Vec<PropertyKeyScope>,
    renames: &'a HashMap<String, String>,
}

#[derive(Default)]
struct PropertyKeyScope {
    identifiers: HashSet<String>,
    member_paths: HashSet<String>,
}

impl<'a> PropertyProtocolRewriter<'a> {
    pub(super) fn new(renames: &'a HashMap<String, String>) -> Self {
        Self {
            changed: false,
            property_key_scopes: vec![PropertyKeyScope::default()],
            renames,
        }
    }

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
                element.as_ref().and_then(|item| match &*item.expr {
                    Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
                    _ => None,
                })
            })
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };

        if !elements
            .iter()
            .any(|element| self.renames.contains_key(element))
            || !elements
                .iter()
                .all(|element| looks_like_property_name(element))
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
            BinaryOp::EqEq | BinaryOp::EqEqEq | BinaryOp::NotEq | BinaryOp::NotEqEq => {
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
