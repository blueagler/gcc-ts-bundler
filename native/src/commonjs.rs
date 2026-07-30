use std::collections::BTreeSet;

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{Visit, VisitWith};

#[derive(Clone, Debug, Default)]
pub struct CommonJsAnalysis {
    pub dependencies: Vec<String>,
    pub export_names: Vec<String>,
    pub has_commonjs: bool,
    pub has_default_export: bool,
    /// The module observes its own export surface as data: a computed key, an
    /// enumeration, or the export object itself escaping into an expression we
    /// cannot follow. Such a module's export names must stay literal, because
    /// something can read them as strings at runtime.
    ///
    /// This is the fail-closed half of the export-name decision; see
    /// `transpile::collect_opaque_commonjs`. Three constructs that would also
    /// belong here are already rejected outright by `CommonJsCollector` and can
    /// never reach normalization: computed export writes, non-literal
    /// `require()`, and `Object.defineProperty` exports other than
    /// `__esModule`.
    pub exports_are_opaque: bool,
    pub proxy_export: Option<String>,
    pub unsupported: Vec<String>,
}

pub fn analyze_commonjs_module(module: &Module) -> CommonJsAnalysis {
    let mut collector = CommonJsCollector::default();
    collector.visit_module_items(&module.body);

    if collector.has_commonjs && collector.esm_syntax {
        collector
            .unsupported
            .push("Mixed ESM and CommonJS syntax is not supported.".to_string());
    }

    let mut opacity = ExportsOpacityVisitor::default();
    module.visit_with(&mut opacity);

    CommonJsAnalysis {
        dependencies: collector.dependencies.into_iter().collect(),
        export_names: collector.export_names.into_iter().collect(),
        has_commonjs: collector.has_commonjs,
        has_default_export: collector.has_default_export,
        exports_are_opaque: opacity.opaque,
        proxy_export: collector.proxy_export,
        unsupported: collector.unsupported,
    }
}

/// Decides whether a CommonJS module can ever observe its own export names as
/// strings.
///
/// The walk is inverted on purpose: instead of enumerating the shapes that leak
/// (an open-ended list), it enumerates the two shapes that provably cannot —
/// a statically-named member access on the export object, and an assignment to
/// the export slot itself — and consumes them without descending into the
/// export object. Anything that still reaches the export object through normal
/// recursion is, by construction, an occurrence we did not prove safe, and the
/// module is marked opaque. New syntax therefore fails closed by default.
#[derive(Default)]
struct ExportsOpacityVisitor {
    opaque: bool,
}

impl ExportsOpacityVisitor {
    /// A statically-named read/write: `exports.foo`, `module.exports["foo"]`.
    /// Returns false when the key is computed and not a string literal.
    fn visit_static_member(&mut self, member: &MemberExpr) -> bool {
        if !is_commonjs_export_object(&member.obj) {
            return false;
        }
        match &member.prop {
            MemberProp::Ident(_) => true,
            MemberProp::Computed(computed) => {
                if string_literal_expr(&computed.expr).is_some() {
                    true
                } else {
                    // `exports[k]` — the key is data.
                    self.opaque = true;
                    true
                }
            }
            MemberProp::PrivateName(_) => false,
        }
    }
}

impl Visit for ExportsOpacityVisitor {
    fn visit_expr(&mut self, expression: &Expr) {
        if let Expr::Member(member) = expression {
            if self.visit_static_member(member) {
                // Consumed: deliberately do not descend into `member.obj`, so a
                // bare export-object reference can only be reached when no
                // safe shape claimed it.
                return;
            }
        }
        if is_commonjs_export_object(expression) {
            self.opaque = true;
            return;
        }
        expression.visit_children_with(self);
    }

    fn visit_assign_expr(&mut self, expression: &AssignExpr) {
        if let AssignTarget::Simple(SimpleAssignTarget::Member(member)) = &expression.left {
            // `module.exports = …` replaces the slot; `exports.foo = …` names a
            // key. Neither exposes a name as data.
            if is_module_exports_target(member) || self.visit_static_member(member) {
                expression.right.visit_with(self);
                return;
            }
        }
        expression.visit_children_with(self);
    }

    fn visit_for_in_stmt(&mut self, statement: &ForInStmt) {
        if is_commonjs_export_object(&statement.right) {
            // `for (const key in exports)` reads every name as a string.
            self.opaque = true;
        }
        statement.visit_children_with(self);
    }
}

/// Consumer-side counterpart: does `module` observe any of `bindings` (locals
/// bound to an imported CommonJS namespace) as data?
///
/// Only key-reading shapes count here. Passing the namespace object around is
/// safe under whole-program renaming, because every access site renames with
/// it; what is not safe is turning a name into a string.
pub fn commonjs_namespace_is_opaque(module: &Module, bindings: &BTreeSet<String>) -> bool {
    if bindings.is_empty() {
        return false;
    }
    let mut visitor = NamespaceOpacityVisitor {
        bindings,
        opaque: false,
    };
    module.visit_with(&mut visitor);
    visitor.opaque
}

struct NamespaceOpacityVisitor<'a> {
    bindings: &'a BTreeSet<String>,
    opaque: bool,
}

impl NamespaceOpacityVisitor<'_> {
    fn is_namespace(&self, expression: &Expr) -> bool {
        matches!(expression, Expr::Ident(ident) if self.bindings.contains(ident.sym.as_ref()))
    }
}

impl Visit for NamespaceOpacityVisitor<'_> {
    fn visit_member_expr(&mut self, member: &MemberExpr) {
        if self.is_namespace(&member.obj) {
            if let MemberProp::Computed(computed) = &member.prop {
                if string_literal_expr(&computed.expr).is_none() {
                    self.opaque = true;
                }
            }
        }
        member.visit_children_with(self);
    }

    fn visit_for_in_stmt(&mut self, statement: &ForInStmt) {
        if self.is_namespace(&statement.right) {
            self.opaque = true;
        }
        statement.visit_children_with(self);
    }
}

#[derive(Default)]
struct CommonJsCollector {
    dependencies: BTreeSet<String>,
    esm_syntax: bool,
    export_names: BTreeSet<String>,
    has_commonjs: bool,
    has_default_export: bool,
    proxy_export: Option<String>,
    unsupported: Vec<String>,
    /// Depth of enclosing function scopes that bind `exports`/`module` as
    /// parameters. Bundlers wrap CommonJS package sources in
    /// `__commonJS({ "file.js"(exports, module) { ... } })` inside an
    /// otherwise pure ESM file; those assignments write to a local parameter,
    /// not to a module record, so they must not mark the file as CommonJS.
    shadowed_exports_depth: u32,
}

impl CommonJsCollector {
    fn visit_module_items(&mut self, items: &[ModuleItem]) {
        for item in items {
            self.visit_module_item(item);
        }
    }

    fn visit_module_item(&mut self, item: &ModuleItem) {
        match item {
            ModuleItem::ModuleDecl(_) => {
                self.esm_syntax = true;
            }
            ModuleItem::Stmt(statement) => self.visit_stmt(statement),
        }
    }

    fn visit_stmt(&mut self, statement: &Stmt) {
        match statement {
            Stmt::Block(block) => {
                for statement in &block.stmts {
                    self.visit_stmt(statement);
                }
            }
            Stmt::If(if_statement) => match evaluate_boolean_expr(&if_statement.test) {
                Some(true) => self.visit_stmt(&if_statement.cons),
                Some(false) => {
                    if let Some(alt) = &if_statement.alt {
                        self.visit_stmt(alt);
                    }
                }
                None => {
                    if_statement.test.visit_with(self);
                    self.visit_stmt(&if_statement.cons);
                    if let Some(alt) = &if_statement.alt {
                        self.visit_stmt(alt);
                    }
                }
            },
            Stmt::Labeled(labeled) => self.visit_stmt(&labeled.body),
            Stmt::With(with_statement) => {
                with_statement.obj.visit_with(self);
                self.visit_stmt(&with_statement.body);
            }
            Stmt::Switch(switch_statement) => {
                switch_statement.discriminant.visit_with(self);
                for case in &switch_statement.cases {
                    case.test.visit_with(self);
                    for statement in &case.cons {
                        self.visit_stmt(statement);
                    }
                }
            }
            Stmt::Try(try_statement) => {
                for statement in &try_statement.block.stmts {
                    self.visit_stmt(statement);
                }
                if let Some(handler) = &try_statement.handler {
                    for statement in &handler.body.stmts {
                        self.visit_stmt(statement);
                    }
                }
                if let Some(finalizer) = &try_statement.finalizer {
                    for statement in &finalizer.stmts {
                        self.visit_stmt(statement);
                    }
                }
            }
            _ => statement.visit_with(self),
        }
    }

    fn record_dependency(&mut self, specifier: String) {
        self.has_commonjs = true;
        self.dependencies.insert(specifier);
    }

    fn record_named_export(&mut self, export_name: String) {
        self.has_commonjs = true;
        self.has_default_export = true;
        self.export_names.insert(export_name);
        if self.proxy_export.is_some() {
            self.unsupported.push(
                "CommonJS proxy exports cannot be mixed with local export assignments.".to_string(),
            );
        }
    }

    fn record_default_export(&mut self) {
        self.has_commonjs = true;
        self.has_default_export = true;
    }

    fn record_proxy_export(&mut self, specifier: String) {
        self.record_default_export();
        if let Some(existing) = &self.proxy_export {
            if existing != &specifier {
                self.unsupported
                    .push("Multiple CommonJS proxy export targets are not supported.".to_string());
            }
        } else {
            self.proxy_export = Some(specifier);
        }
        if !self.export_names.is_empty() {
            self.unsupported.push(
                "CommonJS proxy exports cannot be mixed with local export assignments.".to_string(),
            );
        }
    }

    /// Visits a function body with `exports`/`module` treated as local when the
    /// parameter list binds either name.
    fn visit_shadowing_scope<T: VisitWith<Self>>(&mut self, shadows: bool, node: &T) {
        if shadows {
            self.shadowed_exports_depth += 1;
            node.visit_children_with(self);
            self.shadowed_exports_depth -= 1;
            return;
        }
        node.visit_children_with(self);
    }
}

/// True when any parameter pattern binds `exports` or `module` directly.
fn binds_commonjs_wrapper_names<'a>(patterns: impl Iterator<Item = &'a Pat>) -> bool {
    patterns.into_iter().any(|pattern| {
        matches!(pattern, Pat::Ident(ident) if ident.id.sym == *"exports" || ident.id.sym == *"module")
    })
}

impl Visit for CommonJsCollector {
    fn visit_function(&mut self, node: &Function) {
        let shadows = binds_commonjs_wrapper_names(node.params.iter().map(|param| &param.pat));
        self.visit_shadowing_scope(shadows, node);
    }

    fn visit_arrow_expr(&mut self, node: &ArrowExpr) {
        let shadows = binds_commonjs_wrapper_names(node.params.iter());
        self.visit_shadowing_scope(shadows, node);
    }

    fn visit_assign_expr(&mut self, expression: &AssignExpr) {
        if self.shadowed_exports_depth > 0 {
            expression.visit_children_with(self);
            return;
        }
        if expression.op != AssignOp::Assign {
            expression.visit_children_with(self);
            return;
        }

        if let AssignTarget::Simple(SimpleAssignTarget::Member(member)) = &expression.left {
            if is_module_exports_target(member) {
                self.record_default_export();
                if let Expr::Call(call_expr) = &*expression.right {
                    if let Some(specifier) = require_call_specifier(call_expr) {
                        self.record_dependency(specifier.clone());
                        self.record_proxy_export(specifier);
                    }
                } else if let Some(object_keys) = object_literal_export_names(&expression.right) {
                    for key in object_keys {
                        self.record_named_export(key);
                    }
                }
            } else if is_commonjs_export_object(&member.obj) {
                if let Some(export_name) = member_prop_name(&member.prop) {
                    self.record_named_export(export_name);
                } else {
                    self.has_commonjs = true;
                    self.unsupported.push(
                        "Computed CommonJS export names must be string literals.".to_string(),
                    );
                }
            }
        }

        expression.visit_children_with(self);
    }

    fn visit_call_expr(&mut self, expression: &CallExpr) {
        if self.shadowed_exports_depth > 0 {
            expression.visit_children_with(self);
            return;
        }
        if let Some(specifier) = require_call_specifier(expression) {
            self.record_dependency(specifier);
            return;
        }

        if is_commonjs_require_call(expression) {
            self.has_commonjs = true;
            self.unsupported
                .push("Only string-literal require() calls are supported.".to_string());
        }

        if let Some(export_name) = object_define_property_export(expression) {
            if export_name != "__esModule" {
                self.has_commonjs = true;
                self.unsupported.push(format!(
                    "CommonJS Object.defineProperty export for \"{export_name}\" is not supported.",
                ));
            }
        }

        expression.visit_children_with(self);
    }
}

pub fn evaluate_boolean_expr(expression: &Expr) -> Option<bool> {
    match expression {
        Expr::Lit(Lit::Bool(boolean)) => Some(boolean.value),
        Expr::Paren(parenthesized) => evaluate_boolean_expr(&parenthesized.expr),
        Expr::Unary(unary) if unary.op == UnaryOp::Bang => {
            evaluate_boolean_expr(&unary.arg).map(|value| !value)
        }
        Expr::Bin(binary) => match binary.op {
            BinaryOp::LogicalAnd => {
                Some(evaluate_boolean_expr(&binary.left)? && evaluate_boolean_expr(&binary.right)?)
            }
            BinaryOp::LogicalOr => {
                Some(evaluate_boolean_expr(&binary.left)? || evaluate_boolean_expr(&binary.right)?)
            }
            BinaryOp::EqEq | BinaryOp::EqEqEq => {
                Some(compare_literal_exprs(&binary.left, &binary.right)? == 0)
            }
            BinaryOp::NotEq | BinaryOp::NotEqEq => {
                Some(compare_literal_exprs(&binary.left, &binary.right)? != 0)
            }
            _ => None,
        },
        _ => None,
    }
}

fn compare_literal_exprs(left: &Expr, right: &Expr) -> Option<i32> {
    let left_value = static_env_value(left)?;
    let right_value = static_env_value(right)?;
    Some(if left_value == right_value { 0 } else { 1 })
}

fn static_env_value(expression: &Expr) -> Option<String> {
    match expression {
        Expr::Lit(Lit::Str(value)) => Some(value.value.to_string_lossy().to_string()),
        Expr::Lit(Lit::Bool(value)) => Some(value.value.to_string()),
        Expr::Member(member) if is_process_env_node_env(member) => Some("production".to_string()),
        Expr::Paren(parenthesized) => static_env_value(&parenthesized.expr),
        _ => None,
    }
}

fn is_process_env_node_env(member: &MemberExpr) -> bool {
    let MemberProp::Ident(node_env) = &member.prop else {
        return false;
    };
    if node_env.sym != *"NODE_ENV" {
        return false;
    }
    let Expr::Member(env_member) = &*member.obj else {
        return false;
    };
    let MemberProp::Ident(env_ident) = &env_member.prop else {
        return false;
    };
    if env_ident.sym != *"env" {
        return false;
    }
    matches!(&*env_member.obj, Expr::Ident(process_ident) if process_ident.sym == *"process")
}

fn require_call_specifier(expression: &CallExpr) -> Option<String> {
    let Callee::Expr(callee) = &expression.callee else {
        return None;
    };
    let Expr::Ident(ident) = &**callee else {
        return None;
    };
    if ident.sym != *"require" || expression.args.len() != 1 {
        return None;
    }

    string_literal_expr(&expression.args[0].expr)
}

fn is_commonjs_require_call(expression: &CallExpr) -> bool {
    let Callee::Expr(callee) = &expression.callee else {
        return false;
    };
    matches!(&**callee, Expr::Ident(ident) if ident.sym == *"require")
}

fn object_define_property_export(expression: &CallExpr) -> Option<String> {
    let Callee::Expr(callee) = &expression.callee else {
        return None;
    };
    let Expr::Member(member) = &**callee else {
        return None;
    };
    let MemberProp::Ident(ident) = &member.prop else {
        return None;
    };
    if ident.sym != *"defineProperty" {
        return None;
    }
    let Expr::Ident(object_ident) = &*member.obj else {
        return None;
    };
    if object_ident.sym != *"Object" || expression.args.len() < 2 {
        return None;
    }
    let target = &expression.args[0].expr;
    if !matches!(&**target, Expr::Ident(ident) if ident.sym == *"exports")
        && !matches!(&**target, Expr::Member(member) if is_module_exports_target(member))
    {
        return None;
    }

    string_literal_expr(&expression.args[1].expr)
}

fn is_module_exports_target(member: &MemberExpr) -> bool {
    let MemberProp::Ident(exports_ident) = &member.prop else {
        return false;
    };
    if exports_ident.sym != *"exports" {
        return false;
    }
    matches!(&*member.obj, Expr::Ident(module_ident) if module_ident.sym == *"module")
}

fn is_commonjs_export_object(expression: &Expr) -> bool {
    if matches!(expression, Expr::Ident(ident) if ident.sym == *"exports") {
        return true;
    }

    matches!(expression, Expr::Member(member) if is_module_exports_target(member))
}

fn member_prop_name(prop: &MemberProp) -> Option<String> {
    match prop {
        MemberProp::Ident(ident) => Some(ident.sym.to_string()),
        MemberProp::Computed(computed) => string_literal_expr(&computed.expr),
        _ => None,
    }
}

fn object_literal_export_names(expression: &Expr) -> Option<Vec<String>> {
    let Expr::Object(object) = expression else {
        return None;
    };

    let mut export_names = Vec::new();
    for property in &object.props {
        let PropOrSpread::Prop(property) = property else {
            return None;
        };
        let Prop::KeyValue(key_value) = &**property else {
            return None;
        };
        match &key_value.key {
            PropName::Ident(ident) => export_names.push(ident.sym.to_string()),
            PropName::Str(string) => export_names.push(string.value.to_string_lossy().to_string()),
            _ => return None,
        }
    }

    Some(export_names)
}

fn string_literal_expr(expression: &Expr) -> Option<String> {
    match expression {
        Expr::Lit(Lit::Str(string)) => Some(string.value.to_string_lossy().to_string()),
        Expr::Tpl(template) if template.exprs.is_empty() && template.quasis.len() == 1 => {
            Some(template.quasis[0].raw.to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::analyze_commonjs_module;
    use crate::module_cache::parse_module;
    use std::path::PathBuf;

    fn analyze(source: &str) -> super::CommonJsAnalysis {
        let file_path = PathBuf::from("/tmp/cjs-test.js");
        let module = parse_module(&file_path, source).unwrap();
        analyze_commonjs_module(&module)
    }

    #[test]
    fn collects_static_requires() {
        let analysis = analyze("const React = require('react'); exports.ok = React;");
        assert!(analysis.has_commonjs);
        assert_eq!(analysis.dependencies, vec!["react".to_string()]);
    }

    #[test]
    fn collects_named_exports() {
        let analysis = analyze("exports.foo = 1; module.exports.bar = 2;");
        assert_eq!(
            analysis.export_names,
            vec!["bar".to_string(), "foo".to_string()]
        );
        assert!(analysis.has_default_export);
    }

    #[test]
    fn ignores_exports_shadowed_by_bundler_wrapper_parameters() {
        // esbuild's `__commonJS` wrapper shape inside a pure ESM bundle.
        let analysis = analyze(
            "var require_a = __commonJS({ \"a.js\"(exports, module) { exports.jsx = 1; module.exports = null; } });\nexport { require_a };",
        );
        assert!(!analysis.has_commonjs);
        assert!(analysis.export_names.is_empty());
        assert!(analysis.unsupported.is_empty());
    }

    #[test]
    fn still_detects_commonjs_outside_shadowing_scopes() {
        let analysis = analyze(
            "function wrap(exports) { exports.inner = 1; }\nmodule.exports.outer = 2;",
        );
        assert!(analysis.has_commonjs);
        assert_eq!(analysis.export_names, vec!["outer".to_string()]);
    }

    #[test]
    fn detects_proxy_exports() {
        let analysis = analyze("module.exports = require('./dep');");
        assert_eq!(analysis.proxy_export.as_deref(), Some("./dep"));
    }

    #[test]
    fn folds_production_env_condition() {
        let analysis = analyze(
            "if (process.env.NODE_ENV === 'production') { module.exports = require('./prod'); } else { module.exports = require('./dev'); }",
        );
        assert_eq!(analysis.dependencies, vec!["./prod".to_string()]);
    }

    #[test]
    fn rejects_dynamic_require() {
        let analysis = analyze("require(name);");
        assert!(!analysis.unsupported.is_empty());
    }

    #[test]
    fn rejects_computed_export_names() {
        let analysis = analyze("exports[name] = 1;");
        assert!(!analysis.unsupported.is_empty());
    }
}
