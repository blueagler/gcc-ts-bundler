//! Explicit parenthesisation for expression shapes the printer emits without
//! the parentheses they require.
//!
//! TypeScript namespace lowering is the case that surfaced this. `strip`
//! rewrites
//!
//! ```ts
//! namespace Outer { export const x = 1; }
//! ```
//!
//! into an IIFE, and the printed result is
//!
//! ```js
//! function(Outer) { Outer.x = 1; }(Outer || Outer = {});
//! ```
//!
//! which is not JavaScript, twice over: a `function` in statement position is
//! a *declaration* and needs a name (`JSC_PARSE_ERROR: 'identifier' expected`),
//! and `a || b = {}` parses as `(a || b) = {}`, an invalid assignment target.
//! Verified to come from the printer rather than from our emission path: the
//! same text appears whether the program is printed whole or statement by
//! statement.
//!
//! The fix is to make the AST say what it means instead of relying on the
//! printer's precedence inference. Both rules below are general precedence
//! facts, not a namespace special case — any construct that produces these
//! shapes is corrected.

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

pub(crate) fn normalize_expression_parens(program: &mut Program) {
    program.visit_mut_with(&mut ParenNormalizer);
}

struct ParenNormalizer;

impl VisitMut for ParenNormalizer {
    /// An assignment used as an operand of a binary expression binds looser
    /// than the operator, so it always needs parentheses: `a || (b = {})`.
    fn visit_mut_bin_expr(&mut self, expression: &mut BinExpr) {
        expression.visit_mut_children_with(self);
        parenthesize_assignment(&mut expression.left);
        parenthesize_assignment(&mut expression.right);
    }

    /// A statement may not *begin* with `function` or `class` unless it is a
    /// declaration. Only the leading expression matters, so this wraps the
    /// head rather than every callee, which keeps ordinary IIFEs byte-identical.
    fn visit_mut_expr_stmt(&mut self, statement: &mut ExprStmt) {
        statement.visit_mut_children_with(self);
        parenthesize_statement_head(&mut statement.expr);
    }
}

fn parenthesize_assignment(expression: &mut Box<Expr>) {
    if !matches!(&**expression, Expr::Assign(_)) {
        return;
    }
    wrap_in_parens(expression);
}

/// Walks the left spine of the statement's expression to the token the parser
/// sees first, and parenthesises it when that token would start a declaration.
fn parenthesize_statement_head(expression: &mut Box<Expr>) {
    if starts_with_function_or_class(expression) {
        wrap_in_parens(expression);
        return;
    }
    match &mut **expression {
        Expr::Call(call) => {
            if let Callee::Expr(callee) = &mut call.callee {
                parenthesize_statement_head(callee);
            }
        }
        Expr::Member(member) => parenthesize_statement_head(&mut member.obj),
        Expr::Bin(binary) => parenthesize_statement_head(&mut binary.left),
        Expr::Seq(sequence) => {
            if let Some(first) = sequence.exprs.first_mut() {
                parenthesize_statement_head(first);
            }
        }
        Expr::Assign(assignment) => {
            if let AssignTarget::Simple(SimpleAssignTarget::Paren(_)) = &assignment.left {
                // Already parenthesised.
            }
        }
        Expr::Cond(conditional) => parenthesize_statement_head(&mut conditional.test),
        Expr::Tpl(_) | Expr::TaggedTpl(_) => {}
        _ => {}
    }
}

fn starts_with_function_or_class(expression: &Expr) -> bool {
    matches!(expression, Expr::Fn(_) | Expr::Class(_))
}

fn wrap_in_parens(expression: &mut Box<Expr>) {
    let inner = std::mem::replace(
        expression,
        Box::new(Expr::Invalid(Invalid {
            span: Default::default(),
        })),
    );
    *expression = Box::new(Expr::Paren(ParenExpr {
        expr: inner,
        span: Default::default(),
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_cache::parse_module;
    use std::path::PathBuf;

    fn normalized(source: &str) -> String {
        let module = parse_module(&PathBuf::from("f.ts"), source).expect("parse");
        let mut program = Program::Module(module);
        swc_core::common::GLOBALS.set(&swc_core::common::Globals::new(), || {
            let unresolved = swc_core::common::Mark::new();
            let top_level = swc_core::common::Mark::new();
            swc_ecma_transforms_base::resolver(unresolved, top_level, true).process(&mut program);
            swc_ecma_transforms_typescript::strip(unresolved, top_level).process(&mut program);
        });
        normalize_expression_parens(&mut program);
        crate::transpile::print::print_program_for_test(&program).expect("print")
    }

    #[test]
    fn namespace_lowering_prints_parsable_javascript() {
        // The exact W2C-1 shape: an anonymous function in statement position
        // plus an assignment inside `||`. Closure rejected both.
        let printed =
            normalized("namespace Outer { export const x = 1; }\nexport const y = Outer.x;\n");
        assert!(printed.contains("(function(Outer)"), "{printed}");
        assert!(printed.contains("(Outer = {})"), "{printed}");
        assert!(!printed.contains("}(Outer || Outer = {})"), "{printed}");
    }

    #[test]
    fn ordinary_iifes_and_binaries_are_left_alone() {
        // The rules must not fire where the printer was already correct, or
        // every bundle grows a pair of parentheses.
        let printed = normalized(
            "export const a = (function () { return 1; })();\nexport const b = 1 || 2;\n",
        );
        assert!(!printed.contains("((function"), "{printed}");
        assert!(printed.contains("1 || 2"), "{printed}");
    }
}
