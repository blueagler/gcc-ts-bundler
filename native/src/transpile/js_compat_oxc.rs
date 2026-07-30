//! Oxc counterpart of the JavaScript pass-through compatibility emitter.

#![allow(dead_code)]

use std::path::Path;

use oxc_allocator::{Allocator, FromIn};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, SPAN};
use oxc_str::Str;
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};

use super::apply_js_compat_text_fixes;
use super::global_this_oxc::{collect_global_this_compat_property_names, GlobalThisCompatVisitor};
use super::identity_oxc::ModuleIdentity;
use super::lowering_oxc::closure_input_codegen_options;

pub(crate) fn transform_js_pass_through_source(
    file_path: &Path,
    source: &str,
) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(file_path)
        .unwrap_or_default()
        .with_module(true);
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_enum_eval(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let identity = ModuleIdentity::new(semantic.semantic.into_scoping());
    let mut program = parsed.program;

    let properties = collect_global_this_compat_property_names(&program, &identity);
    if !properties.is_empty() {
        GlobalThisCompatVisitor::new(&allocator, &identity, properties).visit_program(&mut program);
    }
    ProcessEnvNodeEnvVisitor::new(&allocator, &identity).visit_program(&mut program);
    JsCompatAstVisitor::new(&allocator, source_declares_ident(source, "T"))
        .visit_program(&mut program);
    DirectoryModuleSpecifierVisitor::new(&allocator).visit_program(&mut program);

    Ok(apply_js_compat_text_fixes(
        Codegen::new()
            .with_options(closure_input_codegen_options())
            .build(&program)
            .code,
    ))
}

struct ProcessEnvNodeEnvVisitor<'a, 'i> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    identity: &'i ModuleIdentity,
}

impl<'a, 'i> ProcessEnvNodeEnvVisitor<'a, 'i> {
    fn new(allocator: &'a Allocator, identity: &'i ModuleIdentity) -> Self {
        Self {
            allocator,
            builder: AstBuilder::new(allocator),
            identity,
        }
    }

    fn is_process_env_node_env(&self, expression: &Expression<'_>) -> bool {
        let Expression::StaticMemberExpression(node_env) = expression else {
            return false;
        };
        if node_env.property.name != "NODE_ENV" {
            return false;
        }
        let Expression::StaticMemberExpression(env) = &node_env.object else {
            return false;
        };
        if env.property.name != "env" {
            return false;
        }
        matches!(&env.object, Expression::Identifier(process)
            if process.name == "process" && self.identity.is_global(process))
    }
}

impl<'a> VisitMut<'a> for ProcessEnvNodeEnvVisitor<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        if self.is_process_env_node_env(expression) {
            *expression = Expression::new_string_literal(
                SPAN,
                Str::from_in("production", self.allocator),
                None,
                &self.builder,
            );
        }
    }
}

struct JsCompatAstVisitor<'a> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    has_t_declaration: bool,
}

impl<'a> JsCompatAstVisitor<'a> {
    fn new(allocator: &'a Allocator, has_t_declaration: bool) -> Self {
        Self {
            allocator,
            builder: AstBuilder::new(allocator),
            has_t_declaration,
        }
    }

    fn empty_statement(&self) -> Statement<'a> {
        Statement::new_empty_statement(SPAN, &self.builder)
    }

    fn empty_expression(&self) -> Expression<'a> {
        Expression::new_null_literal(SPAN, &self.builder)
    }

    fn void_zero(&self) -> Expression<'a> {
        Expression::new_unary_expression(
            SPAN,
            UnaryOperator::Void,
            Expression::new_numeric_literal(SPAN, 0.0, None, NumberBase::Decimal, &self.builder),
            &self.builder,
        )
    }
}

impl<'a> VisitMut<'a> for JsCompatAstVisitor<'a> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        walk_mut::walk_statement(self, statement);
        let Statement::IfStatement(if_statement) = statement else {
            return;
        };
        let Some(test_value) = evaluate_boolean_expr(&if_statement.test) else {
            return;
        };
        let dropped = if test_value {
            if_statement.alternate.as_ref()
        } else {
            Some(&if_statement.consequent)
        };
        if dropped.is_some_and(branch_declares_hoisted_bindings) {
            return;
        }
        *statement = if test_value {
            std::mem::replace(&mut if_statement.consequent, self.empty_statement())
        } else {
            if_statement
                .alternate
                .take()
                .unwrap_or_else(|| self.empty_statement())
        };
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);

        if let Expression::ConditionalExpression(conditional) = expression {
            if let Some(test_value) = evaluate_boolean_expr(&conditional.test) {
                *expression = if test_value {
                    std::mem::replace(&mut conditional.consequent, self.empty_expression())
                } else {
                    std::mem::replace(&mut conditional.alternate, self.empty_expression())
                };
                return;
            }
        }

        if let Expression::LogicalExpression(logical) = expression {
            if let Some(left_value) = evaluate_boolean_expr(&logical.left) {
                let take_left = match logical.operator {
                    LogicalOperator::And => !left_value,
                    LogicalOperator::Or => left_value,
                    LogicalOperator::Coalesce => return,
                };
                *expression = if take_left {
                    std::mem::replace(&mut logical.left, self.empty_expression())
                } else {
                    std::mem::replace(&mut logical.right, self.empty_expression())
                };
                return;
            }
        }

        if self.has_t_declaration {
            return;
        }
        let Expression::ArrowFunctionExpression(arrow) = expression else {
            return;
        };
        if !arrow.params.items.is_empty() {
            return;
        }
        let Some(returned) = arrow.get_expression_mut() else {
            return;
        };
        if matches!(returned, Expression::Identifier(identifier) if identifier.name == "T") {
            *returned = self.void_zero();
        }
    }
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
        _ => None,
    }
}

fn branch_declares_hoisted_bindings(statement: &Statement<'_>) -> bool {
    let mut scanner = HoistedBindingScanner { found: false };
    scanner.visit_statement(statement);
    scanner.found
}

struct HoistedBindingScanner {
    found: bool,
}

impl<'a> Visit<'a> for HoistedBindingScanner {
    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if matches!(statement, Statement::FunctionDeclaration(_)) {
            self.found = true;
            return;
        }
        walk::walk_statement(self, statement);
    }

    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if declaration.kind == VariableDeclarationKind::Var {
            self.found = true;
        }
        walk::walk_variable_declaration(self, declaration);
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: oxc_syntax::scope::ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _arrow: &ArrowFunctionExpression<'a>) {}
}

struct DirectoryModuleSpecifierVisitor<'a> {
    allocator: &'a Allocator,
}

impl<'a> DirectoryModuleSpecifierVisitor<'a> {
    fn new(allocator: &'a Allocator) -> Self {
        Self { allocator }
    }

    fn rewrite(&self, literal: &mut StringLiteral<'a>) {
        let replacement = match literal.value.as_str() {
            "." => "./index.js",
            ".." => "../index.js",
            _ => return,
        };
        literal.value = Str::from_in(replacement, self.allocator);
        literal.raw = None;
    }
}

impl<'a> VisitMut<'a> for DirectoryModuleSpecifierVisitor<'a> {
    fn visit_import_declaration(&mut self, declaration: &mut ImportDeclaration<'a>) {
        self.rewrite(&mut declaration.source);
        walk_mut::walk_import_declaration(self, declaration);
    }

    fn visit_export_named_declaration(&mut self, declaration: &mut ExportNamedDeclaration<'a>) {
        if let Some(source) = &mut declaration.source {
            self.rewrite(source);
        }
        walk_mut::walk_export_named_declaration(self, declaration);
    }

    fn visit_export_all_declaration(&mut self, declaration: &mut ExportAllDeclaration<'a>) {
        self.rewrite(&mut declaration.source);
        walk_mut::walk_export_all_declaration(self, declaration);
    }

    fn visit_import_expression(&mut self, expression: &mut ImportExpression<'a>) {
        walk_mut::walk_import_expression(self, expression);
        if let Expression::StringLiteral(source) = &mut expression.source {
            self.rewrite(source);
        }
    }
}

fn source_declares_ident(source: &str, name: &str) -> bool {
    let pattern = format!(
        r#"(?m)\b(?:var|let|const|function|class|import)\s+{}\b"#,
        regex::escape(name)
    );
    regex::Regex::new(&pattern)
        .map(|regex| regex.is_match(source))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;

    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    use super::*;
    use crate::module_cache::parse_module;
    use crate::transpile::{ChunkMode, TranspileContext};

    fn context() -> TranspileContext {
        TranspileContext {
            bundler_module_slots: HashMap::new(),
            bundler_runtime_logical_ids: HashMap::new(),
            chunk_mode: ChunkMode::Off,
            class_map_calls: Vec::new(),
            pure_callees: HashSet::new(),
            commonjs_specifiers: HashSet::new(),
            opaque_commonjs: Default::default(),
            file_metadata: HashMap::new(),
            hoist_plan: None,
            lazy_imports_by_file: HashMap::new(),
            lazy_target_module_ids: HashSet::new(),
            package_aliases: Vec::new(),
            resolved_module_ids: HashMap::new(),
            preserved_property_names: HashSet::new(),
            static_property_names: HashSet::new(),
            type_metadata_enabled: false,
            vendor_module_ids: HashSet::new(),
            workspace_dir: PathBuf::from("."),
        }
    }

    fn swc(source: &str) -> String {
        let path = Path::new("fixture.js");
        super::super::transform_js_pass_through_module(
            parse_module(path, source).expect("swc compat parse"),
            source.to_string(),
            path,
            &context(),
        )
        .expect("swc compat transform")
    }

    fn normalize(source: &str) -> String {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
        assert!(
            parsed.diagnostics.is_empty(),
            "{source}\n{:?}",
            parsed.diagnostics
        );
        Codegen::new().build(&parsed.program).code
    }

    fn assert_parity(source: &str) -> String {
        let oxc = transform_js_pass_through_source(Path::new("fixture.js"), source)
            .expect("oxc compat transform");
        let swc = swc(source);
        assert_eq!(normalize(&oxc), normalize(&swc), "swc:\n{swc}\noxc:\n{oxc}");
        oxc
    }

    #[test]
    fn pass_through_structure_matches_swc() {
        let output = assert_parity(
            r#"
            const base = globalThis.sharedRegistry ?? new WeakMap();
            const item = sharedRegistry.get(meta);
            const mode = process.env.NODE_ENV;
            const envChoice = process.env.NODE_ENV === "production" ? yes() : no();
            if (false) missing(); else keep();
            const conditional = false ? missing() : fallback();
            const andValue = true && keep();
            const orValue = false || fallback();
            var RETURN = () => T;
            import value from ".";
            export { other } from "..";
            export * from ".";
            const lazy = import("..");
            "#,
        );
        assert!(
            output.contains("globalThis.sharedRegistry.get(meta)"),
            "{output}"
        );
        assert!(output.contains("\"production\""), "{output}");
        assert!(output.contains("void 0"), "{output}");
        assert!(!output.contains("no()"), "{output}");
        assert!(output.contains("./index.js"), "{output}");
        assert!(output.contains("../index.js"), "{output}");
    }

    #[test]
    fn hoisted_declarations_block_only_unsafe_branch_folds() {
        let output = assert_parity(
            r#"
            if (false) { var retained = 1; } else use(retained);
            if (true) keep(); else { function declared() {} }
            if (false) { let dropped = 1; } else keep();
            "#,
        );
        assert!(output.contains("if (false)"), "{output}");
        assert!(output.contains("if (true)"), "{output}");
        assert!(!output.contains("dropped"), "{output}");
    }

    #[test]
    fn local_process_and_declared_t_are_not_rewritten() {
        let output = assert_parity(
            r#"
            const T = token;
            const RETURN = () => T;
            function read(process) { return process.env.NODE_ENV; }
            const globalMode = process.env.NODE_ENV;
            "#,
        );
        assert!(output.contains("() => T"), "{output}");
        assert!(output.contains("process.env.NODE_ENV"), "{output}");
        assert_eq!(output.matches("\"production\"").count(), 1, "{output}");
    }

    #[test]
    fn codegen_uses_the_closed_comment_policy() {
        let output = transform_js_pass_through_source(
            Path::new("fixture.js"),
            "/** @const HOSTILE */ const value = 1; /*#__PURE__*/ make();",
        )
        .unwrap();
        assert!(!output.contains("HOSTILE"), "{output}");
        assert!(output.contains("__PURE__"), "{output}");
    }
}
