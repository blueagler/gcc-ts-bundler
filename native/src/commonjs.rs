use std::collections::BTreeSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, LogicalOperator, UnaryOperator};
use oxc_syntax::scope::ScopeFlags;

#[derive(Clone, Debug, Default)]
pub struct CommonJsAnalysis {
    pub dependencies: Vec<String>,
    pub export_names: Vec<String>,
    pub has_commonjs: bool,
    pub has_default_export: bool,
    pub exports_are_opaque: bool,
    pub proxy_export: Option<String>,
    pub unsupported: Vec<String>,
}

pub fn analyze_commonjs_source(file_path: &Path, source: &str) -> Result<CommonJsAnalysis, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .map_err(|error| error.to_string())?
        .with_module(true);
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {diagnostic}", file_path.display()))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(analyze_commonjs_program(&parsed.program))
}

pub fn analyze_commonjs_program(program: &Program<'_>) -> CommonJsAnalysis {
    let mut collector = CommonJsCollector {
        esm_syntax: program.body.iter().any(is_module_declaration),
        ..CommonJsCollector::default()
    };
    collector.visit_program(program);
    if collector.has_commonjs && collector.esm_syntax {
        collector
            .unsupported
            .push("Mixed ESM and CommonJS syntax is not supported.".to_string());
    }

    let mut opacity = ExportsOpacityVisitor::default();
    opacity.visit_program(program);

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

fn is_module_declaration(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::ImportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportDefaultDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::TSExportAssignment(_)
            | Statement::TSNamespaceExportDeclaration(_)
    )
}

fn evaluate_boolean_expr(expression: &Expression<'_>) -> Option<bool> {
    match expression.without_parentheses() {
        Expression::BooleanLiteral(boolean) => Some(boolean.value),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            evaluate_boolean_expr(&unary.argument).map(|value| !value)
        }
        Expression::LogicalExpression(logical) => match logical.operator {
            LogicalOperator::And => Some(
                evaluate_boolean_expr(&logical.left)? && evaluate_boolean_expr(&logical.right)?,
            ),
            LogicalOperator::Or => Some(
                evaluate_boolean_expr(&logical.left)? || evaluate_boolean_expr(&logical.right)?,
            ),
            LogicalOperator::Coalesce => None,
        },
        Expression::BinaryExpression(binary) => match binary.operator {
            BinaryOperator::Equality | BinaryOperator::StrictEquality => {
                Some(static_value(&binary.left)? == static_value(&binary.right)?)
            }
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => {
                Some(static_value(&binary.left)? != static_value(&binary.right)?)
            }
            _ => None,
        },
        _ => None,
    }
}

fn static_value(expression: &Expression<'_>) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(value) => Some(value.value.to_string()),
        Expression::BooleanLiteral(value) => Some(value.value.to_string()),
        Expression::StaticMemberExpression(node_env)
            if node_env.property.name == "NODE_ENV"
                && matches!(&node_env.object, Expression::StaticMemberExpression(env)
                    if env.property.name == "env"
                        && matches!(&env.object, Expression::Identifier(process) if process.name == "process")) =>
        {
            Some("production".to_string())
        }
        _ => None,
    }
}

#[derive(Default)]
struct ExportsOpacityVisitor {
    opaque: bool,
}

impl ExportsOpacityVisitor {
    fn visit_static_member(&mut self, expression: &Expression<'_>) -> bool {
        match expression.without_parentheses() {
            Expression::StaticMemberExpression(member)
                if is_commonjs_export_object(&member.object) =>
            {
                true
            }
            Expression::ComputedMemberExpression(member)
                if is_commonjs_export_object(&member.object) =>
            {
                if string_literal_expr(&member.expression).is_none() {
                    self.opaque = true;
                }
                true
            }
            _ => false,
        }
    }
}

impl<'a> Visit<'a> for ExportsOpacityVisitor {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        if self.visit_static_member(expression) {
            return;
        }
        if is_commonjs_export_object(expression) {
            self.opaque = true;
            return;
        }
        walk::walk_expression(self, expression);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let Some(target) = assignment.left.as_simple_assignment_target() {
            if is_module_exports_target(target) || is_static_export_member_target(target, self) {
                self.visit_expression(&assignment.right);
                return;
            }
        }
        walk::walk_assignment_expression(self, assignment);
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        if is_commonjs_export_object(&statement.right) {
            self.opaque = true;
        }
        walk::walk_for_in_statement(self, statement);
    }
}

fn is_static_export_member_target(
    target: &SimpleAssignmentTarget<'_>,
    visitor: &mut ExportsOpacityVisitor,
) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            if !is_commonjs_export_object(&member.object) {
                return false;
            }
            if string_literal_expr(&member.expression).is_none() {
                visitor.opaque = true;
            }
            true
        }
        _ => false,
    }
}

pub fn commonjs_namespace_is_opaque(program: &Program<'_>, bindings: &BTreeSet<String>) -> bool {
    if bindings.is_empty() {
        return false;
    }
    let mut visitor = NamespaceOpacityVisitor {
        bindings,
        opaque: false,
    };
    visitor.visit_program(program);
    visitor.opaque
}

struct NamespaceOpacityVisitor<'a> {
    bindings: &'a BTreeSet<String>,
    opaque: bool,
}

impl NamespaceOpacityVisitor<'_> {
    fn is_namespace(&self, expression: &Expression<'_>) -> bool {
        matches!(expression.without_parentheses(), Expression::Identifier(identifier) if self.bindings.contains(identifier.name.as_str()))
    }
}

impl<'a> Visit<'a> for NamespaceOpacityVisitor<'_> {
    fn visit_static_member_expression(&mut self, member: &StaticMemberExpression<'a>) {
        walk::walk_static_member_expression(self, member);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        if self.is_namespace(&member.object) && string_literal_expr(&member.expression).is_none() {
            self.opaque = true;
        }
        walk::walk_computed_member_expression(self, member);
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        if self.is_namespace(&statement.right) {
            self.opaque = true;
        }
        walk::walk_for_in_statement(self, statement);
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
    shadowed_exports_depth: u32,
}

impl CommonJsCollector {
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

    fn visit_shadowing_scope<F>(&mut self, shadows: bool, visit: F)
    where
        F: FnOnce(&mut Self),
    {
        if shadows {
            self.shadowed_exports_depth += 1;
            visit(self);
            self.shadowed_exports_depth -= 1;
        } else {
            visit(self);
        }
    }
}

impl<'a> Visit<'a> for CommonJsCollector {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if let Statement::IfStatement(if_statement) = statement {
            match evaluate_boolean_expr(&if_statement.test) {
                Some(true) => self.visit_statement(&if_statement.consequent),
                Some(false) => {
                    if let Some(alternate) = &if_statement.alternate {
                        self.visit_statement(alternate);
                    }
                }
                None => walk::walk_if_statement(self, if_statement),
            }
            return;
        }
        walk::walk_statement(self, statement);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let shadows = function
            .params
            .items
            .iter()
            .any(|parameter| binds_commonjs_wrapper_name(&parameter.pattern));
        self.visit_shadowing_scope(shadows, |visitor| {
            walk::walk_function(visitor, function, flags)
        });
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let shadows = arrow
            .params
            .items
            .iter()
            .any(|parameter| binds_commonjs_wrapper_name(&parameter.pattern));
        self.visit_shadowing_scope(shadows, |visitor| {
            walk::walk_arrow_function_expression(visitor, arrow)
        });
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if self.shadowed_exports_depth > 0 || assignment.operator != AssignmentOperator::Assign {
            walk::walk_assignment_expression(self, assignment);
            return;
        }
        if let Some(target) = assignment.left.as_simple_assignment_target() {
            if is_module_exports_target(target) {
                self.record_default_export();
                if let Expression::CallExpression(call) = assignment.right.without_parentheses() {
                    if let Some(specifier) = require_specifier(call) {
                        self.record_dependency(specifier.clone());
                        self.record_proxy_export(specifier);
                    }
                } else if let Some(names) = object_literal_export_names(&assignment.right) {
                    for name in names {
                        self.record_named_export(name);
                    }
                }
            } else if let Some(name) = export_member_name(target) {
                self.record_named_export(name);
            } else if is_export_member_target(target) {
                self.has_commonjs = true;
                self.unsupported
                    .push("Computed CommonJS export names must be string literals.".to_string());
            }
        }
        walk::walk_assignment_expression(self, assignment);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.shadowed_exports_depth > 0 {
            walk::walk_call_expression(self, call);
            return;
        }
        if let Some(specifier) = require_specifier(call) {
            self.record_dependency(specifier);
            return;
        }
        if is_commonjs_require_call(call) {
            self.has_commonjs = true;
            self.unsupported
                .push("Only string-literal require() calls are supported.".to_string());
        }
        if let Some(export_name) = object_define_property_export(call) {
            if export_name != "__esModule" {
                self.has_commonjs = true;
                self.unsupported.push(format!(
                    "CommonJS Object.defineProperty export for \"{export_name}\" is not supported."
                ));
            }
        }
        walk::walk_call_expression(self, call);
    }
}

fn binds_commonjs_wrapper_name(pattern: &BindingPattern<'_>) -> bool {
    matches!(pattern, BindingPattern::BindingIdentifier(identifier) if identifier.name == "exports" || identifier.name == "module")
}

fn require_specifier(call: &CallExpression<'_>) -> Option<String> {
    if call.arguments.len() != 1
        || !matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "require")
    {
        return None;
    }
    string_literal_argument(&call.arguments[0])
}

fn is_commonjs_require_call(call: &CallExpression<'_>) -> bool {
    matches!(&call.callee, Expression::Identifier(identifier) if identifier.name == "require")
}

fn object_define_property_export(call: &CallExpression<'_>) -> Option<String> {
    if call.arguments.len() < 2 {
        return None;
    }
    let Expression::StaticMemberExpression(callee) = &call.callee else {
        return None;
    };
    if callee.property.name != "defineProperty"
        || !matches!(&callee.object, Expression::Identifier(object) if object.name == "Object")
    {
        return None;
    }
    let target = call.arguments[0].as_expression()?;
    if !is_commonjs_export_object(target) {
        return None;
    }
    string_literal_argument(&call.arguments[1])
}

fn is_module_exports_target(target: &SimpleAssignmentTarget<'_>) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            matches!(&member.object, Expression::Identifier(identifier) if identifier.name == "module")
                && member.property.name == "exports"
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            matches!(&member.object, Expression::Identifier(identifier) if identifier.name == "module")
                && string_literal_expr(&member.expression).as_deref() == Some("exports")
        }
        _ => false,
    }
}

fn is_commonjs_export_object(expression: &Expression<'_>) -> bool {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => identifier.name == "exports",
        Expression::StaticMemberExpression(member) => {
            matches!(&member.object, Expression::Identifier(identifier) if identifier.name == "module")
                && member.property.name == "exports"
        }
        Expression::ComputedMemberExpression(member) => {
            matches!(&member.object, Expression::Identifier(identifier) if identifier.name == "module")
                && string_literal_expr(&member.expression).as_deref() == Some("exports")
        }
        _ => false,
    }
}

fn is_export_member_target(target: &SimpleAssignmentTarget<'_>) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
        }
        _ => false,
    }
}

fn export_member_name(target: &SimpleAssignmentTarget<'_>) -> Option<String> {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member)
            if is_commonjs_export_object(&member.object) =>
        {
            Some(member.property.name.to_string())
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member)
            if is_commonjs_export_object(&member.object) =>
        {
            string_literal_expr(&member.expression)
        }
        _ => None,
    }
}

fn object_literal_export_names(expression: &Expression<'_>) -> Option<Vec<String>> {
    let Expression::ObjectExpression(object) = expression.without_parentheses() else {
        return None;
    };
    let mut names = Vec::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            return None;
        };
        if property.kind != PropertyKind::Init || property.method || property.shorthand {
            return None;
        }
        match &property.key {
            PropertyKey::StaticIdentifier(identifier) => names.push(identifier.name.to_string()),
            PropertyKey::StringLiteral(literal) => names.push(literal.value.to_string()),
            _ => return None,
        }
    }
    Some(names)
}

fn string_literal_argument(argument: &Argument<'_>) -> Option<String> {
    string_literal_expr(argument.as_expression()?)
}

fn string_literal_expr(expression: &Expression<'_>) -> Option<String> {
    match expression.without_parentheses() {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        Expression::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            Some(
                template.quasis[0]
                    .value
                    .cooked
                    .as_ref()
                    .unwrap_or(&template.quasis[0].value.raw)
                    .to_string(),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze(source: &str) -> CommonJsAnalysis {
        analyze_commonjs_source(Path::new("/tmp/cjs-test.js"), source).unwrap()
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
        let analysis = analyze(
            "var require_a = __commonJS({ \"a.js\"(exports, module) { exports.jsx = 1; module.exports = null; } });\nexport { require_a };",
        );
        assert!(!analysis.has_commonjs);
        assert!(analysis.export_names.is_empty());
        assert!(analysis.unsupported.is_empty());
    }

    #[test]
    fn still_detects_commonjs_outside_shadowing_scopes() {
        let analysis =
            analyze("function wrap(exports) { exports.inner = 1; }\nmodule.exports.outer = 2;");
        assert!(analysis.has_commonjs);
        assert_eq!(analysis.export_names, vec!["outer".to_string()]);
    }

    #[test]
    fn detects_proxy_exports_and_folds_production_branch() {
        let analysis = analyze(
            "if (process.env.NODE_ENV === 'production') { module.exports = require('./prod'); } else { module.exports = require('./dev'); }",
        );
        assert_eq!(analysis.dependencies, vec!["./prod".to_string()]);
        assert_eq!(analysis.proxy_export.as_deref(), Some("./prod"));
    }

    #[test]
    fn rejects_dynamic_require_and_computed_export_names() {
        assert!(!analyze("require(name);").unsupported.is_empty());
        assert!(!analyze("exports[name] = 1;").unsupported.is_empty());
    }

    #[test]
    fn opacity_is_fail_closed() {
        assert!(!analyze("exports.alpha = 1;").exports_are_opaque);
        assert!(analyze("exports.alpha = 1; Object.keys(exports);").exports_are_opaque);
        assert!(analyze("exports.alpha = 1; exports[key];").exports_are_opaque);
    }
}
