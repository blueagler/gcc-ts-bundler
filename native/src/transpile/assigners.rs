//! Finds vendor-chunk callables that mutate their module's own state.

use std::collections::HashSet;
use swc_core::ecma::ast::{
    ArrayPat, AssignTarget, AssignTargetPat, Decl, Expr, ForHead, Ident, ObjectPat, ObjectPatProp,
    Pat, SimpleAssignTarget, Stmt,
};
use swc_core::ecma::visit::{Visit, VisitWith};

/// The Closure annotation that keeps a function out of its call sites.
pub(crate) const NOINLINE_TAG: &str = "@noinline";

/// Returns the first top-level callable declared by `statement` whose body
/// writes one of `module_bindings`.
pub(crate) fn assigner_function_name(
    statement: &Stmt,
    module_bindings: &HashSet<String>,
) -> Option<String> {
    assigner_function_names(statement, module_bindings)
        .into_iter()
        .next()
}

pub(crate) fn assigner_function_names(
    statement: &Stmt,
    module_bindings: &HashSet<String>,
) -> Vec<String> {
    if module_bindings.is_empty() {
        return Vec::new();
    }
    callable_declarations(statement)
        .into_iter()
        .filter_map(|callable| {
            let mut visitor = ModuleStateAssignmentVisitor {
                module_bindings,
                found: false,
            };
            match callable.body {
                CallableBody::Function(function) => function.visit_with(&mut visitor),
                CallableBody::Arrow(arrow) => arrow.visit_with(&mut visitor),
            }
            visitor.found.then(|| callable.name.sym.to_string())
        })
        .collect()
}

struct CallableDeclaration<'a> {
    name: &'a Ident,
    body: CallableBody<'a>,
}

enum CallableBody<'a> {
    Function(&'a swc_core::ecma::ast::Function),
    Arrow(&'a swc_core::ecma::ast::ArrowExpr),
}

fn callable_declarations(statement: &Stmt) -> Vec<CallableDeclaration<'_>> {
    match statement {
        Stmt::Decl(Decl::Fn(declaration)) => vec![CallableDeclaration {
            name: &declaration.ident,
            body: CallableBody::Function(&declaration.function),
        }],
        Stmt::Decl(Decl::Var(declaration)) => declaration
            .decls
            .iter()
            .filter_map(|declarator| {
                let Pat::Ident(binding) = &declarator.name else {
                    return None;
                };
                let initializer = declarator.init.as_deref()?;
                let body = match peel_parens(initializer) {
                    Expr::Fn(function) => CallableBody::Function(&function.function),
                    Expr::Arrow(arrow) => CallableBody::Arrow(arrow),
                    _ => return None,
                };
                Some(CallableDeclaration {
                    name: &binding.id,
                    body,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn peel_parens(mut expression: &Expr) -> &Expr {
    while let Expr::Paren(paren) = expression {
        expression = &paren.expr;
    }
    expression
}

struct ModuleStateAssignmentVisitor<'a> {
    module_bindings: &'a HashSet<String>,
    found: bool,
}

impl ModuleStateAssignmentVisitor<'_> {
    fn note(&mut self, name: &str) {
        if self.module_bindings.contains(name) {
            self.found = true;
        }
    }

    fn note_pattern(&mut self, pattern: &Pat) {
        match pattern {
            Pat::Ident(binding) => self.note(binding.id.sym.as_ref()),
            Pat::Array(array) => self.note_array_pattern(array),
            Pat::Object(object) => self.note_object_pattern(object),
            Pat::Assign(assign) => self.note_pattern(&assign.left),
            Pat::Rest(rest) => self.note_pattern(&rest.arg),
            Pat::Expr(expression) => self.note_assignment_expression(expression),
            _ => {}
        }
    }

    fn note_array_pattern(&mut self, pattern: &ArrayPat) {
        for element in pattern.elems.iter().flatten() {
            self.note_pattern(element);
        }
    }

    fn note_object_pattern(&mut self, pattern: &ObjectPat) {
        for property in &pattern.props {
            match property {
                ObjectPatProp::KeyValue(property) => self.note_pattern(&property.value),
                ObjectPatProp::Assign(property) => self.note(property.key.sym.as_ref()),
                ObjectPatProp::Rest(property) => self.note_pattern(&property.arg),
            }
        }
    }

    fn note_assignment_expression(&mut self, expression: &Expr) {
        match peel_parens(expression) {
            Expr::Ident(ident) => self.note(ident.sym.as_ref()),
            Expr::Array(array) => {
                for element in array.elems.iter().flatten() {
                    self.note_assignment_expression(&element.expr);
                }
            }
            Expr::Object(object) => {
                for property in &object.props {
                    let swc_core::ecma::ast::PropOrSpread::Prop(property) = property else {
                        continue;
                    };
                    match property.as_ref() {
                        swc_core::ecma::ast::Prop::Shorthand(ident) => {
                            self.note(ident.sym.as_ref())
                        }
                        swc_core::ecma::ast::Prop::KeyValue(property) => {
                            self.note_assignment_expression(&property.value)
                        }
                        swc_core::ecma::ast::Prop::Assign(property) => {
                            self.note(property.key.sym.as_ref())
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn note_simple_target(&mut self, target: &SimpleAssignTarget) {
        match target {
            SimpleAssignTarget::Ident(binding) => self.note(binding.id.sym.as_ref()),
            SimpleAssignTarget::Paren(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            SimpleAssignTarget::TsAs(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            SimpleAssignTarget::TsSatisfies(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            SimpleAssignTarget::TsNonNull(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            SimpleAssignTarget::TsTypeAssertion(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            SimpleAssignTarget::TsInstantiation(expression) => {
                self.note_assignment_expression(&expression.expr)
            }
            _ => {}
        }
    }

    fn note_target(&mut self, target: &AssignTarget) {
        match target {
            AssignTarget::Simple(target) => self.note_simple_target(target),
            AssignTarget::Pat(AssignTargetPat::Array(pattern)) => self.note_array_pattern(pattern),
            AssignTarget::Pat(AssignTargetPat::Object(pattern)) => {
                self.note_object_pattern(pattern)
            }
            AssignTarget::Pat(AssignTargetPat::Invalid(_)) => {}
        }
    }

    fn note_for_head(&mut self, head: &ForHead) {
        if let ForHead::Pat(pattern) = head {
            self.note_pattern(pattern);
        }
    }
}

impl Visit for ModuleStateAssignmentVisitor<'_> {
    fn visit_assign_expr(&mut self, node: &swc_core::ecma::ast::AssignExpr) {
        node.visit_children_with(self);
        self.note_target(&node.left);
    }

    fn visit_update_expr(&mut self, node: &swc_core::ecma::ast::UpdateExpr) {
        node.visit_children_with(self);
        self.note_assignment_expression(&node.arg);
    }

    fn visit_for_in_stmt(&mut self, node: &swc_core::ecma::ast::ForInStmt) {
        node.visit_children_with(self);
        self.note_for_head(&node.left);
    }

    fn visit_for_of_stmt(&mut self, node: &swc_core::ecma::ast::ForOfStmt) {
        node.visit_children_with(self);
        self.note_for_head(&node.left);
    }
}

/// Extracts every annotated callable from an assembled vendor chunk.
/// This text-only island can switch before the transpile AST seam does.
pub(crate) fn collect_annotated_assigner_names(chunk_text: &str) -> Vec<String> {
    super::assigners_oxc::collect_annotated_assigner_names(chunk_text)
}

#[cfg(test)]
pub(crate) fn assigner_function_names_for_test(
    source: &str,
    module_bindings: &HashSet<String>,
) -> Vec<String> {
    let module = crate::module_cache::parse_module(std::path::Path::new("fixture.js"), source)
        .expect("swc parity parse");
    module
        .body
        .iter()
        .filter_map(|item| match item {
            swc_core::ecma::ast::ModuleItem::Stmt(statement) => {
                assigner_function_name(statement, module_bindings)
            }
            _ => None,
        })
        .collect()
}

/// The statement appended to a vendor chunk that makes its mutating functions
/// immovable.
pub(crate) fn render_assigner_pin(runtime_alias: &str, names: &[String]) -> Option<String> {
    (!names.is_empty()).then(|| format!("{runtime_alias}.v=[{}];", names.join(",")))
}
