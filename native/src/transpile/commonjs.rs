use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::{Allocator, FromIn, ReplaceWith, Vec};
use oxc_ast::ast::{
    Argument, AssignmentExpression, AssignmentTarget, BindingIdentifier, BindingPattern,
    CallExpression, Class, Expression, FormalParameterKind, FormalParameters, Function,
    FunctionBody, FunctionType, IdentifierName, ImportDeclarationSpecifier, ImportOrExportKind,
    ModuleExportName, ObjectExpression, ObjectProperty, ObjectPropertyKind, Program, PropertyKey,
    SimpleAssignmentTarget, Statement, StringLiteral, ThisExpression, VariableDeclarationKind,
    VariableDeclarator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::{walk_mut, Visit, VisitMut};
use oxc_span::{GetSpan, Span, SPAN};
use oxc_str::{Ident, Str};
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator};

use crate::commonjs::CommonJsAnalysis;

use super::fresh::FreshNameAllocator;
use super::{resolve_module_id_for_specifier, ChunkMode, TranspileContext};

pub(crate) fn normalize_program<'a>(
    allocator: &'a Allocator,
    file_path: &Path,
    program: &mut Program<'a>,
    analysis: &CommonJsAnalysis,
    quoted: bool,
    context: &TranspileContext,
) -> Result<(), String> {
    if let Some(reason) = analysis.unsupported.first() {
        return Err(format!("Unsupported CommonJS pattern: {reason}"));
    }
    let builder = AstBuilder::new(allocator);
    let require_bindings = analysis
        .dependencies
        .iter()
        .enumerate()
        .map(|(index, specifier)| (specifier.clone(), format!("__cjs_require_{index}")))
        .collect::<HashMap<_, _>>();
    let commonjs_bindings = collect_commonjs_bindings(program, &require_bindings);
    let wrap_this = uses_top_level_this(program);
    CommonJsRewriter {
        allocator,
        builder: AstBuilder::new(allocator),
        commonjs_bindings: &commonjs_bindings,
        quoted,
        require_bindings: &require_bindings,
    }
    .visit_program(program);
    program
        .directives
        .retain(|directive| directive.directive != "use strict");

    let identifier =
        |name: &str| Expression::new_identifier(SPAN, Ident::from_in(name, allocator), &builder);
    let binding =
        |name: &str| BindingIdentifier::new(SPAN, Ident::from_in(name, allocator), &builder);
    let member = |object, name: &str| {
        Expression::new_computed_member_expression(
            SPAN,
            object,
            Expression::new_string_literal(SPAN, Str::from_in(name, allocator), None, &builder),
            false,
            &builder,
        )
    };
    let mut body = Vec::new_in(&allocator);
    for (index, specifier) in analysis.dependencies.iter().enumerate() {
        let specifier = super::to_emitted_commonjs_specifier(specifier);
        let require = format!("__cjs_require_{index}");
        let (import, fallback) = if context.chunk_mode == ChunkMode::Off {
            let import = format!("__cjs_import_{index}");
            let test = Expression::new_binary_expression(
                SPAN,
                Expression::new_string_literal(SPAN, "__cjsExports", None, &builder),
                BinaryOperator::In,
                identifier(&import),
                &builder,
            );
            let value = Expression::new_conditional_expression(
                SPAN,
                test,
                member(identifier(&import), "__cjsExports"),
                identifier(&import),
                &builder,
            );
            (
                ImportDeclarationSpecifier::new_import_namespace_specifier(
                    SPAN,
                    binding(&import),
                    &builder,
                ),
                Some(variable_statement(
                    &builder,
                    SPAN,
                    VariableDeclarationKind::Const,
                    BindingPattern::new_binding_identifier(
                        SPAN,
                        Ident::from_in(require.as_str(), allocator),
                        &builder,
                    ),
                    value,
                )),
            )
        } else {
            let module_id = resolve_module_id_for_specifier(file_path, &specifier, context)?;
            let import = if context
                .bundler_module_slots
                .get(&module_id)
                .is_some_and(|slots| slots.slot_for("__cjsExports").is_some())
            {
                ImportDeclarationSpecifier::new_import_specifier(
                    SPAN,
                    ModuleExportName::IdentifierName(IdentifierName::new(
                        SPAN,
                        "__cjsExports",
                        &builder,
                    )),
                    binding(&require),
                    ImportOrExportKind::Value,
                    &builder,
                )
            } else {
                ImportDeclarationSpecifier::new_import_namespace_specifier(
                    SPAN,
                    binding(&require),
                    &builder,
                )
            };
            (import, None)
        };
        body.push(Statement::new_import_declaration(
            SPAN,
            Some(Vec::from_value_in(import, &allocator)),
            StringLiteral::new(
                SPAN,
                Str::from_in(specifier.as_str(), allocator),
                None,
                &builder,
            ),
            None,
            None,
            ImportOrExportKind::Value,
            &builder,
        ));
        if let Some(fallback) = fallback {
            body.push(fallback);
        }
    }
    body.push(variable_statement(
        &builder,
        SPAN,
        VariableDeclarationKind::Var,
        BindingPattern::new_binding_identifier(SPAN, "module", &builder),
        Expression::new_object_expression(SPAN, Vec::new_in(&allocator), &builder),
    ));
    let initial_exports =
        Expression::new_object_expression(SPAN, Vec::new_in(&allocator), &builder);
    let receiver = wrap_this.then(|| fresh_receiver_name(program));
    let initial_exports = if let Some(receiver) = &receiver {
        // Own the initial receiver independently of module.exports. Closure can
        // inline .call(module.exports) into a mutable property read in arrows.
        body.push(variable_statement(
            &builder,
            SPAN,
            VariableDeclarationKind::Const,
            BindingPattern::new_binding_identifier(
                SPAN,
                Ident::from_in(receiver.as_str(), allocator),
                &builder,
            ),
            initial_exports,
        ));
        identifier(receiver)
    } else {
        initial_exports
    };
    body.push(Statement::new_expression_statement(
        SPAN,
        Expression::new_assignment_expression(
            SPAN,
            AssignmentOperator::Assign,
            AssignmentTarget::new_computed_member_expression(
                SPAN,
                identifier("module"),
                Expression::new_string_literal(SPAN, "exports", None, &builder),
                false,
                &builder,
            ),
            initial_exports,
            &builder,
        ),
        &builder,
    ));
    if let Some(receiver) = receiver {
        let statements = std::mem::replace(&mut program.body, Vec::new_in(&allocator));
        let function = Expression::new_function_expression(
            SPAN,
            FunctionType::FunctionExpression,
            None,
            false,
            false,
            false,
            None,
            None,
            FormalParameters::boxed(
                SPAN,
                FormalParameterKind::FormalParameter,
                Vec::new_in(&allocator),
                None,
                &builder,
            ),
            None,
            Some(FunctionBody::boxed(
                SPAN,
                Vec::new_in(&allocator),
                statements,
                &builder,
            )),
            &builder,
        );
        body.push(Statement::new_expression_statement(
            SPAN,
            Expression::new_call_expression(
                SPAN,
                member(function, "call"),
                None,
                Vec::from_value_in(Argument::from(identifier(&receiver)), &allocator),
                false,
                &builder,
            ),
            &builder,
        ));
    } else {
        body.extend(program.body.drain(..));
    }
    body.push(variable_statement(
        &builder,
        SPAN,
        VariableDeclarationKind::Var,
        BindingPattern::new_binding_identifier(SPAN, "__cjsExports", &builder),
        member(identifier("module"), "exports"),
    ));
    program.body = body;
    Ok(())
}

fn fresh_receiver_name(program: &Program<'_>) -> String {
    #[derive(Default)]
    struct Names(FreshNameAllocator);
    impl<'a> Visit<'a> for Names {
        fn visit_identifier_reference(
            &mut self,
            identifier: &oxc_ast::ast::IdentifierReference<'a>,
        ) {
            self.0.try_reserve(identifier.name.as_str());
        }

        fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
            self.0.try_reserve(identifier.name.as_str());
        }
    }
    let mut names = Names::default();
    names.visit_program(program);
    names.0.fresh("__cjsThis")
}

pub(crate) fn variable_statement<'a>(
    builder: &AstBuilder<'a>,
    span: Span,
    kind: VariableDeclarationKind,
    id: BindingPattern<'a>,
    init: Expression<'a>,
) -> Statement<'a> {
    Statement::new_variable_declaration(
        span,
        kind,
        [VariableDeclarator::new(
            span,
            id,
            None,
            Some(init),
            false,
            builder,
        )],
        false,
        builder,
    )
}

fn collect_commonjs_bindings(
    program: &Program<'_>,
    require_bindings: &HashMap<String, String>,
) -> HashSet<String> {
    let mut bindings = require_bindings.values().cloned().collect::<HashSet<_>>();
    loop {
        let mut changed = false;
        for statement in &program.body {
            let Statement::VariableDeclaration(declaration) = statement else {
                continue;
            };
            for declarator in &declaration.declarations {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    continue;
                };
                let Some(initializer) = &declarator.init else {
                    continue;
                };
                let carries_commonjs = match initializer.without_parentheses() {
                    Expression::Identifier(identifier) => {
                        bindings.contains(identifier.name.as_str())
                    }
                    Expression::CallExpression(call) => require_specifier(call)
                        .is_some_and(|specifier| require_bindings.contains_key(specifier)),
                    _ => false,
                };
                if carries_commonjs && bindings.insert(binding.name.to_string()) {
                    changed = true;
                }
            }
        }
        if !changed {
            return bindings;
        }
    }
}

struct CommonJsRewriter<'a, 'c> {
    allocator: &'a Allocator,
    builder: AstBuilder<'a>,
    commonjs_bindings: &'c HashSet<String>,
    quoted: bool,
    require_bindings: &'c HashMap<String, String>,
}

impl<'a> CommonJsRewriter<'a, '_> {
    fn quote_member(&self, object: &Expression<'_>, property: &str) -> bool {
        (is_module_identifier(object) && property == "exports")
            || (self.quoted
                && (is_commonjs_export_object(object)
                    || match object.without_parentheses() {
                        Expression::Identifier(identifier) => {
                            self.commonjs_bindings.contains(identifier.name.as_str())
                        }
                        Expression::CallExpression(call) => require_specifier(call)
                            .is_some_and(|specifier| self.require_bindings.contains_key(specifier)),
                        _ => false,
                    }))
    }

    fn exports(&self, span: Span) -> Expression<'a> {
        Expression::new_computed_member_expression(
            span,
            Expression::new_identifier(SPAN, "module", &self.builder),
            Expression::new_string_literal(SPAN, "exports", None, &self.builder),
            false,
            &self.builder,
        )
    }
}

impl<'a> VisitMut<'a> for CommonJsRewriter<'a, '_> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        if matches!(statement, Statement::ExpressionStatement(expression)
            if matches!(&expression.expression, Expression::StringLiteral(literal) if literal.value == "use strict")
                || matches!(&expression.expression, Expression::CallExpression(call) if object_define_property_es_module(call)))
        {
            *statement = Statement::new_empty_statement(statement.span(), &self.builder);
            return;
        }
        walk_mut::walk_statement(self, statement);
    }

    fn visit_assignment_expression(&mut self, assignment: &mut AssignmentExpression<'a>) {
        if self.quoted
            && assignment
                .left
                .as_simple_assignment_target()
                .is_some_and(is_commonjs_export_target)
        {
            if let Expression::ObjectExpression(object) = &mut assignment.right {
                quote_object_literal(object, self.allocator, &self.builder);
            }
        }
        walk_mut::walk_assignment_expression(self, assignment);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            if let Some(binding) =
                require_specifier(call).and_then(|specifier| self.require_bindings.get(specifier))
            {
                *expression = Expression::new_identifier(
                    call.span,
                    Ident::from_in(binding.as_str(), self.allocator),
                    &self.builder,
                );
                return;
            }
        }
        if matches!(expression, Expression::Identifier(identifier) if identifier.name == "exports")
        {
            *expression = self.exports(expression.span());
            return;
        }
        let quote = matches!(expression, Expression::StaticMemberExpression(member)
            if self.quote_member(&member.object, member.property.name.as_str()));
        walk_mut::walk_expression(self, expression);
        if quote {
            expression.replace_with(|expression| match expression {
                Expression::StaticMemberExpression(member) => {
                    let member = member.unbox();
                    Expression::new_computed_member_expression(
                        member.span,
                        member.object,
                        Expression::new_string_literal(
                            member.property.span,
                            Str::from_in(member.property.name.as_str(), self.allocator),
                            None,
                            &self.builder,
                        ),
                        member.optional,
                        &self.builder,
                    )
                }
                expression => expression,
            });
        }
    }

    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        let quote = matches!(target, SimpleAssignmentTarget::StaticMemberExpression(member)
            if self.quote_member(&member.object, member.property.name.as_str()));
        walk_mut::walk_simple_assignment_target(self, target);
        if quote {
            target.replace_with(|target| match target {
                SimpleAssignmentTarget::StaticMemberExpression(member) => {
                    let member = member.unbox();
                    SimpleAssignmentTarget::new_computed_member_expression(
                        member.span,
                        member.object,
                        Expression::new_string_literal(
                            member.property.span,
                            Str::from_in(member.property.name.as_str(), self.allocator),
                            None,
                            &self.builder,
                        ),
                        member.optional,
                        &self.builder,
                    )
                }
                target => target,
            });
        }
    }

    fn visit_object_property(&mut self, property: &mut ObjectProperty<'a>) {
        let rewritten_shorthand = property.shorthand
            && matches!(&property.value, Expression::Identifier(identifier) if identifier.name == "exports");
        walk_mut::walk_object_property(self, property);
        if rewritten_shorthand {
            property.shorthand = false;
        }
    }
}

fn is_commonjs_export_target(target: &SimpleAssignmentTarget<'_>) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
                || (is_module_identifier(&member.object) && member.property.name == "exports")
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            is_commonjs_export_object(&member.object)
                || (is_module_identifier(&member.object)
                    && matches!(&member.expression, Expression::StringLiteral(property) if property.value == "exports"))
        }
        _ => false,
    }
}

fn is_commonjs_export_object(expression: &Expression<'_>) -> bool {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => identifier.name == "exports",
        Expression::StaticMemberExpression(member) => {
            is_module_identifier(&member.object) && member.property.name == "exports"
        }
        Expression::ComputedMemberExpression(member) => {
            is_module_identifier(&member.object)
                && matches!(&member.expression, Expression::StringLiteral(property) if property.value == "exports")
        }
        _ => false,
    }
}

fn is_module_identifier(expression: &Expression<'_>) -> bool {
    matches!(expression.without_parentheses(), Expression::Identifier(identifier) if identifier.name == "module")
}

fn quote_object_literal<'a>(
    object: &mut ObjectExpression<'a>,
    allocator: &'a Allocator,
    builder: &AstBuilder<'a>,
) {
    for property in &mut object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        if property.computed {
            continue;
        }
        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => Some((
                identifier.span,
                Str::from_in(identifier.name.as_str(), allocator),
            )),
            PropertyKey::NumericLiteral(number) => Some((
                number.span,
                Str::from_in(&number.value.to_string(), allocator),
            )),
            _ => None,
        };
        if let Some((span, key)) = key {
            property.key = PropertyKey::new_string_literal(span, key, None, builder);
            property.shorthand = false;
        }
    }
}

fn require_specifier<'a>(call: &'a CallExpression<'a>) -> Option<&'a str> {
    if call.arguments.len() != 1 {
        return None;
    }
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    if callee.name != "require" {
        return None;
    }
    match call.arguments[0].as_expression()? {
        Expression::StringLiteral(literal) => Some(literal.value.as_str()),
        Expression::TemplateLiteral(template)
            if template.expressions.is_empty() && template.quasis.len() == 1 =>
        {
            Some(
                template.quasis[0]
                    .value
                    .cooked
                    .as_ref()
                    .unwrap_or(&template.quasis[0].value.raw)
                    .as_str(),
            )
        }
        _ => None,
    }
}

fn object_define_property_es_module(call: &CallExpression<'_>) -> bool {
    if call.arguments.len() < 2 {
        return false;
    }
    let Expression::StaticMemberExpression(callee) = &call.callee else {
        return false;
    };
    if callee.property.name != "defineProperty"
        || !matches!(&callee.object, Expression::Identifier(object) if object.name == "Object")
    {
        return false;
    }
    matches!(call.arguments[0].as_expression(), Some(Expression::Identifier(exports)) if exports.name == "exports")
        && matches!(call.arguments[1].as_expression(), Some(Expression::StringLiteral(name)) if name.value == "__esModule")
}

fn uses_top_level_this(program: &Program<'_>) -> bool {
    struct Finder {
        found: bool,
    }
    impl<'a> Visit<'a> for Finder {
        fn visit_this_expression(&mut self, _: &ThisExpression) {
            self.found = true;
        }
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_syntax::scope::ScopeFlags) {}
        fn visit_class(&mut self, _: &Class<'a>) {}
    }
    let mut finder = Finder { found: false };
    finder.visit_program(program);
    finder.found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commonjs::analyze_commonjs_program;
    use crate::transpile::context::analysis_resolution_context;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    #[test]
    fn normalized_commonjs_retains_require_exports_and_wrapper_this(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let allocator = Allocator::default();
        let source = r#"
            "use strict";
            const dependency = require("data:text/javascript,export const amount=4");
            const alias = dependency;
            Object.defineProperty(exports, "__esModule", { value: true });
            exports.before = 2;
            const initial = this;
            const readThis = () => this;
            const local = 8;
            const key = "computed";
            module.exports = {
                total: alias.amount + initial.before,
                same: initial === readThis(),
                before: initial.before,
                local,
                [key]: alias.amount
            };
        "#;
        let mut program = Parser::new(&allocator, source, SourceType::mjs())
            .parse()
            .program;
        let analysis = analyze_commonjs_program(&program);
        let mut context = analysis_resolution_context(Path::new("/work"), &[], &HashMap::new());
        context.chunk_mode = ChunkMode::Off;
        normalize_program(
            &allocator,
            Path::new("/work/node_modules/pkg/index.cjs"),
            &mut program,
            &analysis,
            true,
            &context,
        )?;
        let semantic = SemanticBuilder::new().build(&program);
        assert!(
            semantic.diagnostics.is_empty(),
            "{:?}",
            semantic.diagnostics
        );
        let code = Codegen::new().build(&program).code;
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "--eval"])
            .arg(format!(
                "{code}\nconsole.log(JSON.stringify(__cjsExports));"
            ))
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            r#"{"total":6,"same":true,"before":2,"local":8,"computed":4}"#,
        );
        Ok(())
    }

    #[test]
    fn normalization_rejects_mixed_modules_and_dynamic_require() {
        let context = analysis_resolution_context(Path::new("/work"), &[], &HashMap::new());
        for (source, expected) in [
            (
                "import x from 'x'; exports.value = x;",
                "Mixed ESM and CommonJS",
            ),
            (
                "module.exports = require(name);",
                "Only string-literal require()",
            ),
        ] {
            let allocator = Allocator::default();
            let mut program = Parser::new(&allocator, source, SourceType::mjs())
                .parse()
                .program;
            let analysis = analyze_commonjs_program(&program);
            let result = normalize_program(
                &allocator,
                Path::new("/work/node_modules/pkg/index.js"),
                &mut program,
                &analysis,
                false,
                &context,
            );
            assert!(result.is_err_and(|error| error.contains(expected)));
        }
    }
}
